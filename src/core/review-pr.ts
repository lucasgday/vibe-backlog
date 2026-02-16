import { createHash } from "node:crypto";
import { execa } from "execa";
import { REVIEW_PASS_ORDER, type ReviewFinding } from "./review-agent";

type ExecaFn = typeof execa;

const GH_API_PAGE_SIZE = 100;
export const REVIEW_SUMMARY_MARKER = "<!-- vibe:review-summary -->";
const REVIEW_FINGERPRINT_MARKER_PREFIX = "<!-- vibe:fingerprint:";
const REVIEW_FINGERPRINT_MARKER_REGEX = /<!-- vibe:fingerprint:([a-f0-9]+) -->/g;

type JsonRecord = Record<string, unknown>;

export type ReviewIssueSnapshot = {
  title: string;
  url: string | null;
  milestone: string | null;
};

export type ReviewPrSnapshot = {
  number: number;
  url: string | null;
  headRefOid: string | null;
  created: boolean;
};

export type ReviewPublishResult = {
  summaryCommentId: number | null;
  inlinePublished: number;
  inlineSkipped: number;
};

export type FollowUpIssue = {
  number: number | null;
  url: string | null;
  label: "bug" | "enhancement";
  created: boolean;
};

export type FollowUpLabelOverride = "bug" | "enhancement" | null;
const FOLLOW_UP_OPTIONAL_LABELS = ["status:backlog", "module:cli", "module:tracker"] as const;

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

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

async function listPaginatedGhApiRecords(execaFn: ExecaFn, endpoint: string, context: string): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];

  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const paginated = `${endpoint}${separator}per_page=${GH_API_PAGE_SIZE}&page=${page}`;
    const response = await execaFn("gh", ["api", paginated], { stdio: "pipe" });
    const parsed = parseJsonArray(response.stdout, context);
    rows.push(...parsed);
    if (parsed.length < GH_API_PAGE_SIZE) break;
  }

  return rows;
}

function extractUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine.startsWith("http")) return null;
  return firstLine;
}

function extractPrNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/pull\/([0-9]+)\b/.exec(url);
  return match ? Number(match[1]) : null;
}

function extractIssueNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/issues\/([0-9]+)\b/.exec(url);
  return match ? Number(match[1]) : null;
}

function normalizeFindingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeFindingFingerprint(finding: ReviewFinding): string {
  const raw = [
    finding.pass,
    finding.severity,
    finding.file ?? "",
    String(finding.line ?? ""),
    normalizeFindingText(finding.title),
    normalizeFindingText(finding.body),
  ].join("|");
  return createHash("sha1").update(raw).digest("hex");
}

function buildInlineCommentBody(finding: ReviewFinding, fingerprint: string): string {
  const parts = [
    `**[${finding.severity}] ${finding.title}**`,
    finding.body,
    `Pass: \`${finding.pass}\``,
    `${REVIEW_FINGERPRINT_MARKER_PREFIX}${fingerprint} -->`,
  ];
  return parts.join("\n\n");
}

function findFirstPullRequestRow(rows: JsonRecord[]): ReviewPrSnapshot | null {
  for (const row of rows) {
    const number = parsePositiveInt(row.number);
    if (!number) continue;
    return {
      number,
      url: parseNullableString(row.url),
      headRefOid: parseNullableString(row.headRefOid),
      created: false,
    };
  }
  return null;
}

function buildAutoPrTitle(issueId: number, issueTitle: string): string {
  return `review: #${issueId} ${issueTitle}`;
}

function buildAutoPrBody(issueId: number, branch: string, issueTitle: string): string {
  return [
    "## Summary",
    `- Auto-created by \`vibe review\` for branch \`${branch}\`.`,
    `- Target issue: #${issueId} (${issueTitle}).`,
    "",
    "## Architecture decisions",
    "- TODO: describe decisions made in this change.",
    "",
    "## Why these decisions",
    "- TODO: explain rationale and trade-offs.",
    "",
    "## Alternatives considered",
    "- TODO: list alternatives rejected and why.",
    "",
    `Fixes #${issueId}`,
  ].join("\n");
}

export async function resolveRepoNameWithOwner(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stdio: "pipe",
  });
  const slug = response.stdout.trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("unable to resolve repository owner/name from gh");
  }
  return slug;
}

export async function fetchIssueSnapshot(execaFn: ExecaFn, issueId: number): Promise<ReviewIssueSnapshot> {
  const response = await execaFn("gh", ["issue", "view", String(issueId), "--json", "title,url,milestone"], { stdio: "pipe" });
  const row = parseJsonObject(response.stdout, "gh issue view");

  const title = parseNullableString(row.title);
  if (!title) {
    throw new Error(`gh issue view: missing title for issue #${issueId}`);
  }

  const milestoneRaw = row.milestone;
  const milestone =
    typeof milestoneRaw === "object" &&
    milestoneRaw !== null &&
    typeof (milestoneRaw as Record<string, unknown>).title === "string"
      ? String((milestoneRaw as Record<string, unknown>).title).trim() || null
      : null;

  return {
    title,
    url: parseNullableString(row.url),
    milestone,
  };
}

type ResolvePrParams = {
  execaFn: ExecaFn;
  issueId: number;
  issueTitle: string;
  branch: string;
  baseBranch: string;
  dryRun: boolean;
};

export async function resolveOrCreateReviewPullRequest(params: ResolvePrParams): Promise<ReviewPrSnapshot> {
  const { execaFn, issueId, issueTitle, branch, baseBranch, dryRun } = params;

  const listed = await execaFn(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,headRefOid"],
    { stdio: "pipe" },
  );
  const rows = parseJsonArray(listed.stdout, "gh pr list");
  const open = findFirstPullRequestRow(rows);
  if (open) return open;

  const title = buildAutoPrTitle(issueId, issueTitle);
  const body = buildAutoPrBody(issueId, branch, issueTitle);

  if (dryRun) {
    return {
      number: 0,
      url: null,
      headRefOid: null,
      created: false,
    };
  }

  const created = await execaFn("gh", ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body", body], {
    stdio: "pipe",
  });
  const url = extractUrl(created.stdout);
  const prNumber = extractPrNumberFromUrl(url);
  if (!prNumber) {
    throw new Error(`unable to parse PR number from gh pr create output: ${created.stdout}`);
  }

  const viewed = await execaFn("gh", ["pr", "view", String(prNumber), "--json", "number,url,headRefOid"], { stdio: "pipe" });
  const viewedRow = parseJsonObject(viewed.stdout, "gh pr view");
  const viewedNumber = parsePositiveInt(viewedRow.number) ?? prNumber;

  return {
    number: viewedNumber,
    url: parseNullableString(viewedRow.url) ?? url,
    headRefOid: parseNullableString(viewedRow.headRefOid),
    created: true,
  };
}

function extractSummaryCommentId(rows: JsonRecord[]): number | null {
  for (const row of rows) {
    const body = parseNullableString(row.body);
    if (!body || !body.includes(REVIEW_SUMMARY_MARKER)) continue;
    const id = parsePositiveInt(row.id);
    if (id) return id;
  }
  return null;
}

async function upsertReviewSummaryComment(
  execaFn: ExecaFn,
  repo: string,
  prNumber: number,
  body: string,
  dryRun: boolean,
): Promise<number | null> {
  if (dryRun) return null;

  const rows = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/issues/${prNumber}/comments`, "gh issue comments");
  const existingCommentId = extractSummaryCommentId(rows);
  if (existingCommentId) {
    await execaFn("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existingCommentId}`, "-f", `body=${body}`], {
      stdio: "pipe",
    });
    return existingCommentId;
  }

  const created = await execaFn("gh", ["api", "--method", "POST", `repos/${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`], {
    stdio: "pipe",
  });
  const parsed = parseJsonObject(created.stdout, "gh issue comment create");
  return parsePositiveInt(parsed.id);
}

async function listExistingInlineFingerprints(execaFn: ExecaFn, repo: string, prNumber: number): Promise<Set<string>> {
  const rows = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/pulls/${prNumber}/comments`, "gh pr review comments");
  const fingerprints = new Set<string>();

  for (const row of rows) {
    const body = parseNullableString(row.body);
    if (!body) continue;
    let match: RegExpExecArray | null = REVIEW_FINGERPRINT_MARKER_REGEX.exec(body);
    while (match) {
      const fingerprint = (match[1] ?? "").trim();
      if (fingerprint) fingerprints.add(fingerprint);
      match = REVIEW_FINGERPRINT_MARKER_REGEX.exec(body);
    }
    REVIEW_FINGERPRINT_MARKER_REGEX.lastIndex = 0;
  }

  return fingerprints;
}

async function resolvePullRequestHeadSha(execaFn: ExecaFn, prNumber: number): Promise<string> {
  const viewed = await execaFn("gh", ["pr", "view", String(prNumber), "--json", "headRefOid"], { stdio: "pipe" });
  const row = parseJsonObject(viewed.stdout, "gh pr view");
  const sha = parseNullableString(row.headRefOid);
  if (!sha) {
    throw new Error(`unable to resolve headRefOid for PR #${prNumber}`);
  }
  return sha;
}

type PublishReviewParams = {
  execaFn: ExecaFn;
  repo: string;
  pr: ReviewPrSnapshot;
  summaryBody: string;
  findings: ReviewFinding[];
  dryRun: boolean;
};

export async function publishReviewToPullRequest(params: PublishReviewParams): Promise<ReviewPublishResult> {
  const { execaFn, repo, pr, summaryBody, findings, dryRun } = params;
  if (pr.number <= 0) {
    return {
      summaryCommentId: null,
      inlinePublished: 0,
      inlineSkipped: findings.length,
    };
  }

  const reviewBody = `vibe review: final report posted.\n\n${REVIEW_SUMMARY_MARKER}`;
  if (!dryRun) {
    await execaFn("gh", ["pr", "review", String(pr.number), "--comment", "-b", reviewBody], { stdio: "inherit" });
  }

  const summaryCommentId = await upsertReviewSummaryComment(execaFn, repo, pr.number, summaryBody, dryRun);
  if (dryRun) {
    return {
      summaryCommentId,
      inlinePublished: 0,
      inlineSkipped: findings.length,
    };
  }

  const fingerprints = await listExistingInlineFingerprints(execaFn, repo, pr.number);
  const headSha = pr.headRefOid ?? (await resolvePullRequestHeadSha(execaFn, pr.number));
  let inlinePublished = 0;
  let inlineSkipped = 0;

  for (const finding of findings) {
    const file = finding.file ?? null;
    const line = finding.line ?? null;
    if (!file || !line || line <= 0) {
      inlineSkipped += 1;
      continue;
    }

    const fingerprint = computeFindingFingerprint(finding);
    if (fingerprints.has(fingerprint)) {
      inlineSkipped += 1;
      continue;
    }

    const body = buildInlineCommentBody(finding, fingerprint);
    try {
      await execaFn(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${repo}/pulls/${pr.number}/comments`,
          "-f",
          `body=${body}`,
          "-f",
          `commit_id=${headSha}`,
          "-f",
          `path=${file}`,
          "-F",
          `line=${line}`,
        ],
        { stdio: "pipe" },
      );
      fingerprints.add(fingerprint);
      inlinePublished += 1;
    } catch {
      inlineSkipped += 1;
      continue;
    }
  }

  return {
    summaryCommentId,
    inlinePublished,
    inlineSkipped,
  };
}

function hasHighSeverity(findings: ReviewFinding[]): boolean {
  return findings.some((finding) => finding.severity === "P0" || finding.severity === "P1");
}

function hasBugKind(findings: ReviewFinding[]): boolean {
  return findings.some((finding) => finding.kind === "defect" || finding.kind === "regression" || finding.kind === "security");
}

export function classifyFollowUpLabel(
  findings: ReviewFinding[],
  overrideLabel: FollowUpLabelOverride = null,
): "bug" | "enhancement" {
  if (overrideLabel === "bug" || overrideLabel === "enhancement") {
    return overrideLabel;
  }

  if (hasBugKind(findings)) {
    return "bug";
  }

  if (hasHighSeverity(findings)) {
    return "bug";
  }

  return "enhancement";
}

function buildFollowUpIssueBody(sourceIssueId: number, findings: ReviewFinding[], reviewSummary: string): string {
  const lines = [
    `Auto-generated by \`vibe review\` after unresolved findings remained for #${sourceIssueId}.`,
    "",
    "## Review Summary",
    reviewSummary,
    "",
    "## Unresolved Findings",
  ];

  for (const finding of findings) {
    const location = finding.file && finding.line ? ` (${finding.file}:${finding.line})` : finding.file ? ` (${finding.file})` : "";
    lines.push(`- [${finding.severity}] ${finding.title}${location}`);
  }

  return lines.join("\n");
}

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase();
}

async function listRepositoryLabels(execaFn: ExecaFn): Promise<Set<string>> {
  const listed = await execaFn("gh", ["label", "list", "--limit", "500", "--json", "name"], { stdio: "pipe" });
  const rows = parseJsonArray(listed.stdout, "gh label list");
  const labels = new Set<string>();
  for (const row of rows) {
    const name = parseNullableString(row.name);
    if (!name) continue;
    labels.add(normalizeLabelName(name));
  }
  return labels;
}

function pickExistingLabels(requested: string[], existing: Set<string>): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const label of requested) {
    const normalized = normalizeLabelName(label);
    if (!normalized || seen.has(normalized)) continue;
    if (!existing.has(normalized)) continue;
    seen.add(normalized);
    picked.push(label);
  }
  return picked;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const execaError = error as Error & { stderr?: unknown; stdout?: unknown; shortMessage?: unknown };
    const parts = [execaError.message];
    if (typeof execaError.shortMessage === "string" && execaError.shortMessage.trim()) parts.push(execaError.shortMessage);
    if (typeof execaError.stderr === "string" && execaError.stderr.trim()) parts.push(execaError.stderr);
    if (typeof execaError.stdout === "string" && execaError.stdout.trim()) parts.push(execaError.stdout);
    return parts.join("\n");
  }
  return String(error);
}

function isLikelyMissingLabelError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("label") && (text.includes("not found") || text.includes("could not add") || text.includes("invalid"));
}

async function createIssueWithLabels(params: {
  execaFn: ExecaFn;
  title: string;
  body: string;
  labels: string[];
  milestoneTitle: string | null;
}) {
  const args = ["issue", "create", "--title", params.title, "--body", params.body];
  for (const label of params.labels) {
    args.push("--label", label);
  }
  if (params.milestoneTitle) {
    args.push("--milestone", params.milestoneTitle);
  }
  return params.execaFn("gh", args, { stdio: "pipe" });
}

type CreateFollowUpParams = {
  execaFn: ExecaFn;
  sourceIssueId: number;
  sourceIssueTitle: string;
  findings: ReviewFinding[];
  reviewSummary: string;
  milestoneTitle: string | null;
  dryRun: boolean;
  overrideLabel: FollowUpLabelOverride;
};

export async function createReviewFollowUpIssue(params: CreateFollowUpParams): Promise<FollowUpIssue> {
  const { execaFn, sourceIssueId, sourceIssueTitle, findings, reviewSummary, milestoneTitle, dryRun, overrideLabel } = params;
  const label = classifyFollowUpLabel(findings, overrideLabel);
  const title = `review follow-up: unresolved findings for #${sourceIssueId} ${sourceIssueTitle}`.slice(0, 240);
  const body = buildFollowUpIssueBody(sourceIssueId, findings, reviewSummary);

  if (dryRun) {
    return {
      number: null,
      url: null,
      label,
      created: false,
    };
  }

  const requestedLabels: string[] = [label, ...FOLLOW_UP_OPTIONAL_LABELS];
  let labelsToApply: string[] = [...requestedLabels];
  try {
    const availableLabels = await listRepositoryLabels(execaFn);
    labelsToApply = pickExistingLabels(requestedLabels, availableLabels);
  } catch {
    labelsToApply = requestedLabels;
  }

  let created;
  try {
    created = await createIssueWithLabels({
      execaFn,
      title,
      body,
      labels: labelsToApply,
      milestoneTitle,
    });
  } catch (error) {
    if (!labelsToApply.length || !isLikelyMissingLabelError(error)) {
      throw error;
    }

    created = await createIssueWithLabels({
      execaFn,
      title,
      body,
      labels: [],
      milestoneTitle,
    });
  }

  const url = extractUrl(created.stdout);
  const number = extractIssueNumberFromUrl(url);

  return {
    number,
    url,
    label,
    created: true,
  };
}

export function buildReviewSummaryBody(markdown: string): string {
  return `${REVIEW_SUMMARY_MARKER}\n${markdown.trim()}\n`;
}
