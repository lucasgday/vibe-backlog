import { execa } from "execa";
import { runGhWithRetry } from "./gh-retry";
import { resolveRepoNameWithOwner } from "./review-pr";

type ExecaFn = typeof execa;
type JsonRecord = Record<string, unknown>;
const EXTERNAL_AUTOMATION_AUTHORS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);

const REVIEW_THREADS_QUERY = [
  "query($owner:String!, $repo:String!, $pr:Int!, $after:String){",
  "  repository(owner:$owner,name:$repo){",
  "    pullRequest(number:$pr){",
  "      reviewThreads(first:100, after:$after){",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes {",
  "          id",
  "          isResolved",
  "          isOutdated",
  "          comments(first:20){",
  "            nodes {",
  "              id",
  "              body",
  "              url",
  "              path",
  "              line",
  "              originalLine",
  "              author { login }",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const REPLY_THREAD_MUTATION = [
  "mutation($id:ID!, $body:String!){",
  "  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}) {",
  "    comment { url }",
  "  }",
  "}",
].join("\n");

const RESOLVE_THREAD_MUTATION = [
  "mutation($id:ID!){",
  "  resolveReviewThread(input:{threadId:$id}) {",
  "    thread { id isResolved }",
  "  }",
  "}",
].join("\n");

export type ReviewThreadsResolveOptions = {
  prNumber: number | null;
  threadIds: string[];
  allUnresolved: boolean;
  bodyOverride: string | null;
  dryRun: boolean;
  vibeManagedOnly?: boolean;
};

export type ReviewThreadTargetMode = "thread-id" | "all-unresolved";

export type ReviewThreadResolveItem = {
  threadId: string;
  planned: boolean;
  replied: boolean;
  resolved: boolean;
  skipped: boolean;
  failed: boolean;
  reason: string | null;
  replyUrl: string | null;
  path: string | null;
  line: number | null;
  title: string | null;
};

export type ReviewThreadsResolveResult = {
  dryRun: boolean;
  prNumber: number;
  branch: string | null;
  headSha: string | null;
  targetMode: ReviewThreadTargetMode;
  totalThreads: number;
  selectedThreads: number;
  planned: number;
  replied: number;
  resolved: number;
  skipped: number;
  failed: number;
  items: ReviewThreadResolveItem[];
};

export type ReviewThreadLifecycleTotals = {
  observed: number;
  unresolved: number;
  resolved: number;
};

export type ReviewThreadLifecycleTotalsOptions = {
  prNumber: number;
  vibeManagedOnly?: boolean;
};

type ReviewThreadComment = {
  id: string;
  body: string | null;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  authorLogin: string | null;
};

type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewThreadComment[];
};

function parseJsonObject(stdout: string, context: string): JsonRecord {
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context}: expected object response`);
  }
  return parsed as JsonRecord;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function parsePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function splitOwnerRepo(slug: string): { owner: string; repo: string } {
  const normalized = slug.trim();
  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
    throw new Error(`review threads resolve: invalid repository slug '${slug}'`);
  }
  return {
    owner: normalized.slice(0, separatorIndex),
    repo: normalized.slice(separatorIndex + 1),
  };
}

async function resolveCurrentBranch(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" });
  const branch = response.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("review threads resolve: unable to resolve current git branch");
  }
  return branch;
}

async function resolveOpenPrNumberForBranch(execaFn: ExecaFn, branch: string): Promise<number> {
  const response = await runGhWithRetry(
    execaFn,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number"],
    { stdio: "pipe" },
  );
  const parsed = JSON.parse(response.stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("review threads resolve: invalid gh pr list response");
  }

  const numbers = parsed
    .map((entry) => (typeof entry === "object" && entry !== null ? parsePositiveInt((entry as JsonRecord).number) : null))
    .filter((value): value is number => value !== null);

  if (numbers.length === 0) {
    throw new Error(`review threads resolve: no open PR found for branch '${branch}'`);
  }

  if (numbers.length > 1) {
    throw new Error(`review threads resolve: multiple open PRs found for branch '${branch}'`);
  }

  return numbers[0];
}

async function resolvePullRequestHeadSha(execaFn: ExecaFn, prNumber: number): Promise<string | null> {
  const viewed = await runGhWithRetry(execaFn, ["pr", "view", String(prNumber), "--json", "headRefOid"], {
    stdio: "pipe",
  });
  const row = parseJsonObject(viewed.stdout, "gh pr view");
  return parseNullableString(row.headRefOid);
}

function parseReviewThreadComment(value: unknown): ReviewThreadComment | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as JsonRecord;
  const id = parseNullableString(row.id);
  if (!id) return null;
  return {
    id,
    body: parseNullableString(row.body),
    url: parseNullableString(row.url),
    path: parseNullableString(row.path),
    line: parsePositiveInt(row.line),
    originalLine: parsePositiveInt(row.originalLine),
    authorLogin:
      typeof row.author === "object" && row.author !== null ? parseNullableString((row.author as JsonRecord).login) : null,
  };
}

function parseReviewThread(value: unknown): ReviewThread | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as JsonRecord;
  const id = parseNullableString(row.id);
  if (!id) return null;

  const commentsContainer =
    typeof row.comments === "object" && row.comments !== null ? (row.comments as JsonRecord).nodes : null;
  const comments = Array.isArray(commentsContainer)
    ? commentsContainer.map(parseReviewThreadComment).filter((entry): entry is ReviewThreadComment => entry !== null)
    : [];

  return {
    id,
    isResolved: Boolean(row.isResolved),
    isOutdated: Boolean(row.isOutdated),
    comments,
  };
}

async function listPullRequestReviewThreads(
  execaFn: ExecaFn,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;

  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
      "-F",
      `pr=${prNumber}`,
    ];
    if (cursor) {
      args.push("-f", `after=${cursor}`);
    }

    const response = await runGhWithRetry(execaFn, args, { stdio: "pipe" });
    const root = parseJsonObject(response.stdout, "gh api graphql reviewThreads");

    const repository = typeof root.data === "object" && root.data !== null ? (root.data as JsonRecord).repository : null;
    const pullRequest =
      typeof repository === "object" && repository !== null ? (repository as JsonRecord).pullRequest : null;
    if (pullRequest === null) {
      throw new Error(`review threads resolve: PR #${prNumber} not found`);
    }
    if (typeof pullRequest !== "object") {
      throw new Error("review threads resolve: invalid pullRequest payload");
    }

    const reviewThreads =
      typeof (pullRequest as JsonRecord).reviewThreads === "object" && (pullRequest as JsonRecord).reviewThreads !== null
        ? ((pullRequest as JsonRecord).reviewThreads as JsonRecord)
        : null;
    if (!reviewThreads) {
      break;
    }

    const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
    for (const node of nodes) {
      const parsed = parseReviewThread(node);
      if (parsed) threads.push(parsed);
    }

    const pageInfo =
      typeof reviewThreads.pageInfo === "object" && reviewThreads.pageInfo !== null
        ? (reviewThreads.pageInfo as JsonRecord)
        : null;
    const hasNext = Boolean(pageInfo?.hasNextPage);
    const endCursor = parseNullableString(pageInfo?.endCursor);

    if (!hasNext || !endCursor) {
      break;
    }

    cursor = endCursor;
  }

  return threads;
}

function normalizeThreadIds(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function extractFingerprint(body: string | null): string | null {
  if (!body) return null;
  const match = /<!--\s*vibe:fingerprint:([a-f0-9]+)\s*-->/i.exec(body);
  return match ? String(match[1]).trim().toLowerCase() : null;
}

function isManagedAutomationReply(body: string | null): boolean {
  if (!body) return false;
  return body.includes("Resolved via `vibe review threads resolve`.");
}

function normalizeAuthorLogin(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function isExternalAutomationAuthor(login: string | null): boolean {
  const normalized = normalizeAuthorLogin(login);
  if (!normalized) return false;
  return EXTERNAL_AUTOMATION_AUTHORS.has(normalized);
}

function isVibeManagedThread(thread: ReviewThread): boolean {
  const firstComment = thread.comments[0];
  if (!firstComment) {
    return false;
  }

  const firstIsVibeFingerprint = extractFingerprint(firstComment.body) !== null;
  const firstIsExternalAutomation = isExternalAutomationAuthor(firstComment.authorLogin);
  if (!firstIsVibeFingerprint && !firstIsExternalAutomation) {
    return false;
  }

  // Avoid closing mixed human+bot conversations automatically:
  // only auto-resolve threads whose additional replies are managed automation replies.
  for (let index = 1; index < thread.comments.length; index += 1) {
    const comment = thread.comments[index];
    if (!isManagedAutomationReply(comment?.body ?? null) && !isExternalAutomationAuthor(comment?.authorLogin ?? null)) {
      return false;
    }
  }

  return true;
}

function extractPass(body: string | null): string | null {
  if (!body) return null;
  const match = /\bPass:\s*`([^`]+)`/i.exec(body);
  if (!match) return null;
  const value = String(match[1]).trim();
  return value || null;
}

function cleanupMarkdownLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\*_`>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSeverityAndTitle(body: string | null): { severity: string | null; title: string | null } {
  if (!body) return { severity: null, title: null };
  const lines = body.split(/\r?\n/).map((line) => line.trim());

  for (const line of lines) {
    if (!line) continue;
    const severityTitle = /\*\*\[(P[0-3])\]\s+([^*]+?)\*\*/i.exec(line);
    if (severityTitle) {
      return {
        severity: String(severityTitle[1]).toUpperCase(),
        title: cleanupMarkdownLine(String(severityTitle[2])),
      };
    }

    const badgeStyle = /\*\*.*?\s([A-Za-z].+?)\*\*/.exec(line);
    if (badgeStyle) {
      const cleaned = cleanupMarkdownLine(String(badgeStyle[1]));
      if (cleaned) {
        return { severity: null, title: cleaned };
      }
    }
  }

  for (const line of lines) {
    const cleaned = cleanupMarkdownLine(line);
    if (!cleaned) continue;
    if (cleaned.toLowerCase().startsWith("pass:")) continue;
    return { severity: null, title: cleaned };
  }

  return { severity: null, title: null };
}

function formatLocation(pathValue: string | null, line: number | null): string | null {
  if (!pathValue) return null;
  if (line && line > 0) {
    return `${pathValue}:${line}`;
  }
  return pathValue;
}

function buildAutoReplyBody(params: {
  prNumber: number;
  headSha: string | null;
  thread: ReviewThread;
  detailComment: ReviewThreadComment | null;
}): string {
  const { prNumber, headSha, thread, detailComment } = params;
  const shortHead = headSha ? headSha.slice(0, 12) : "(unknown)";
  const severityTitle = extractSeverityAndTitle(detailComment?.body ?? null);
  const fingerprint = extractFingerprint(detailComment?.body ?? null);
  const pass = extractPass(detailComment?.body ?? null);
  const line = detailComment?.line ?? detailComment?.originalLine ?? null;
  const location = formatLocation(detailComment?.path ?? null, line);

  const lines = [
    "Resolved via `vibe review threads resolve`.",
    "",
    `- PR: #${prNumber}`,
    `- HEAD: ${shortHead}`,
    `- Thread: ${thread.id}`,
    `- Outdated: ${thread.isOutdated ? "yes" : "no"}`,
  ];

  if (location) lines.push(`- Location: \`${location}\``);
  if (severityTitle.severity) lines.push(`- Severity: ${severityTitle.severity}`);
  if (severityTitle.title) lines.push(`- Finding: ${severityTitle.title}`);
  if (pass) lines.push(`- Pass: \`${pass}\``);
  if (fingerprint) lines.push(`- Fingerprint: \`${fingerprint}\``);

  lines.push("", "Marking this thread as resolved.");
  return lines.join("\n");
}

async function addThreadReply(execaFn: ExecaFn, threadId: string, body: string): Promise<string | null> {
  const response = await runGhWithRetry(
    execaFn,
    [
      "api",
      "graphql",
      "-f",
      `query=${REPLY_THREAD_MUTATION}`,
      "-f",
      `id=${threadId}`,
      "-f",
      `body=${body}`,
    ],
    { stdio: "pipe" },
    { idempotent: false },
  );
  const root = parseJsonObject(response.stdout, "gh api graphql addPullRequestReviewThreadReply");
  const data = typeof root.data === "object" && root.data !== null ? (root.data as JsonRecord) : null;
  const reply =
    data && typeof data.addPullRequestReviewThreadReply === "object" && data.addPullRequestReviewThreadReply !== null
      ? (data.addPullRequestReviewThreadReply as JsonRecord)
      : null;
  const comment = reply && typeof reply.comment === "object" && reply.comment !== null ? (reply.comment as JsonRecord) : null;
  return parseNullableString(comment?.url);
}

async function resolveThread(execaFn: ExecaFn, threadId: string): Promise<boolean> {
  const response = await runGhWithRetry(
    execaFn,
    ["api", "graphql", "-f", `query=${RESOLVE_THREAD_MUTATION}`, "-f", `id=${threadId}`],
    { stdio: "pipe" },
    { idempotent: false },
  );
  const root = parseJsonObject(response.stdout, "gh api graphql resolveReviewThread");
  const data = typeof root.data === "object" && root.data !== null ? (root.data as JsonRecord) : null;
  const resolveNode =
    data && typeof data.resolveReviewThread === "object" && data.resolveReviewThread !== null
      ? (data.resolveReviewThread as JsonRecord)
      : null;
  const thread = resolveNode && typeof resolveNode.thread === "object" && resolveNode.thread !== null
    ? (resolveNode.thread as JsonRecord)
    : null;
  return Boolean(thread?.isResolved);
}

function selectThreads(
  allThreads: ReviewThread[],
  threadIds: string[],
  allUnresolved: boolean,
  vibeManagedOnly: boolean,
): ReviewThread[] {
  if (allUnresolved) {
    const unresolved = allThreads.filter((thread) => !thread.isResolved);
    if (!vibeManagedOnly) return unresolved;
    return unresolved.filter((thread) => isVibeManagedThread(thread));
  }

  const byId = new Map<string, ReviewThread>();
  for (const thread of allThreads) {
    byId.set(thread.id, thread);
  }

  const selected: ReviewThread[] = [];
  for (const id of threadIds) {
    const thread = byId.get(id);
    if (thread) selected.push(thread);
  }
  return selected;
}

function missingThreadIds(allThreads: ReviewThread[], requested: string[]): string[] {
  const existing = new Set(allThreads.map((thread) => thread.id));
  return requested.filter((id) => !existing.has(id));
}

function buildLifecycleFindingKey(thread: ReviewThread): string | null {
  const firstComment = thread.comments[0];
  if (!firstComment) return null;
  const fingerprint = extractFingerprint(firstComment.body);
  if (fingerprint) return `fingerprint:${fingerprint}`;
  return `thread:${thread.id}`;
}

export async function summarizeReviewThreadLifecycleTotals(
  options: ReviewThreadLifecycleTotalsOptions,
  execaFn: ExecaFn = execa,
): Promise<ReviewThreadLifecycleTotals> {
  const repoSlug = await resolveRepoNameWithOwner(execaFn);
  const { owner, repo } = splitOwnerRepo(repoSlug);
  const allThreads = await listPullRequestReviewThreads(execaFn, owner, repo, options.prNumber);
  const vibeManagedOnly = options.vibeManagedOnly !== false;
  const selectedThreads = vibeManagedOnly ? allThreads.filter((thread) => isVibeManagedThread(thread)) : allThreads;

  const statusByFindingKey = new Map<string, { unresolved: boolean; resolved: boolean }>();
  for (const thread of selectedThreads) {
    const findingKey = buildLifecycleFindingKey(thread);
    if (!findingKey) continue;
    const current = statusByFindingKey.get(findingKey) ?? { unresolved: false, resolved: false };
    if (thread.isResolved) {
      current.resolved = true;
    } else {
      current.unresolved = true;
    }
    statusByFindingKey.set(findingKey, current);
  }

  let unresolved = 0;
  let resolved = 0;
  for (const status of statusByFindingKey.values()) {
    if (status.unresolved) {
      unresolved += 1;
    } else if (status.resolved) {
      resolved += 1;
    }
  }

  return {
    observed: statusByFindingKey.size,
    unresolved,
    resolved,
  };
}

export async function resolveReviewThreads(
  options: ReviewThreadsResolveOptions,
  execaFn: ExecaFn = execa,
): Promise<ReviewThreadsResolveResult> {
  const threadIds = normalizeThreadIds(options.threadIds);
  const targetMode: ReviewThreadTargetMode = options.allUnresolved ? "all-unresolved" : "thread-id";
  const vibeManagedOnly = Boolean(options.vibeManagedOnly);

  let branch: string | null = null;
  let prNumber = options.prNumber;
  if (prNumber === null || prNumber === undefined) {
    branch = await resolveCurrentBranch(execaFn);
    prNumber = await resolveOpenPrNumberForBranch(execaFn, branch);
  }

  const repoSlug = await resolveRepoNameWithOwner(execaFn);
  const { owner, repo } = splitOwnerRepo(repoSlug);
  const headSha = await resolvePullRequestHeadSha(execaFn, prNumber);
  const allThreads = await listPullRequestReviewThreads(execaFn, owner, repo, prNumber);

  const selected = selectThreads(allThreads, threadIds, options.allUnresolved, vibeManagedOnly);
  const missing = options.allUnresolved ? [] : missingThreadIds(allThreads, threadIds);

  const items: ReviewThreadResolveItem[] = [];
  let planned = 0;
  let replied = 0;
  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const missingId of missing) {
    failed += 1;
    items.push({
      threadId: missingId,
      planned: false,
      replied: false,
      resolved: false,
      skipped: false,
      failed: true,
      reason: "thread id not found on PR",
      replyUrl: null,
      path: null,
      line: null,
      title: null,
    });
  }

  for (const thread of selected) {
    const detailComment = thread.comments[0] ?? null;
    const line = detailComment?.line ?? detailComment?.originalLine ?? null;
    const severityTitle = extractSeverityAndTitle(detailComment?.body ?? null);

    if (thread.isResolved) {
      skipped += 1;
      items.push({
        threadId: thread.id,
        planned: false,
        replied: false,
        resolved: false,
        skipped: true,
        failed: false,
        reason: "already resolved",
        replyUrl: null,
        path: detailComment?.path ?? null,
        line,
        title: severityTitle.title,
      });
      continue;
    }

    const body = options.bodyOverride ?? buildAutoReplyBody({ prNumber, headSha, thread, detailComment });

    if (options.dryRun) {
      planned += 1;
      items.push({
        threadId: thread.id,
        planned: true,
        replied: false,
        resolved: false,
        skipped: false,
        failed: false,
        reason: null,
        replyUrl: null,
        path: detailComment?.path ?? null,
        line,
        title: severityTitle.title,
      });
      continue;
    }

    try {
      const replyUrl = await addThreadReply(execaFn, thread.id, body);
      replied += 1;
      const resolveOk = await resolveThread(execaFn, thread.id);
      if (!resolveOk) {
        failed += 1;
        items.push({
          threadId: thread.id,
          planned: false,
          replied: true,
          resolved: false,
          skipped: false,
          failed: true,
          reason: "thread resolve mutation did not return isResolved=true",
          replyUrl,
          path: detailComment?.path ?? null,
          line,
          title: severityTitle.title,
        });
        continue;
      }

      resolved += 1;
      items.push({
        threadId: thread.id,
        planned: false,
        replied: true,
        resolved: true,
        skipped: false,
        failed: false,
        reason: null,
        replyUrl,
        path: detailComment?.path ?? null,
        line,
        title: severityTitle.title,
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error && error.message ? error.message : String(error);
      items.push({
        threadId: thread.id,
        planned: false,
        replied: false,
        resolved: false,
        skipped: false,
        failed: true,
        reason: message,
        replyUrl: null,
        path: detailComment?.path ?? null,
        line,
        title: severityTitle.title,
      });
    }
  }

  return {
    dryRun: options.dryRun,
    prNumber,
    branch,
    headSha,
    targetMode,
    totalThreads: allThreads.length,
    selectedThreads: selected.length,
    planned,
    replied,
    resolved,
    skipped,
    failed,
    items,
  };
}
