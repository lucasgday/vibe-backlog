import { Command } from "commander";
import { execa } from "execa";
import { scaffoldVibeInit } from "./core/init";
import {
  appendIssueAutocloseReference,
  buildTrackerCommands,
  collectLinkedPrNumbers,
  normalizeGitHubIssueId,
  PostflightSchemaV1,
} from "./core/postflight";
import {
  runTrackerReconcile,
  selectMissingTrackerLabels,
  selectMissingTrackerMilestones,
  shouldSuggestTrackerBootstrap,
  type TrackerReconcilePromptRequest,
  writeTrackerBootstrapMarker,
} from "./core/tracker";
import { buildTurnBranch, clearTurnContext, readTurnContext, validateTurnContext, writeTurnContext } from "./core/turn";
import { ensureIssueReviewTemplates } from "./core/reviews";
import {
  REVIEW_INVALID_TURN_EXIT_CODE,
  REVIEW_NO_ACTIVE_TURN_EXIT_CODE,
  REVIEW_REMEDIATION,
  runReviewCommand,
} from "./core/review";
import { REVIEW_AGENT_PROVIDER_VALUES } from "./core/review-provider";
import { runPrOpenCommand } from "./core/pr-open";
import { hasReviewForHead, postReviewGateSkipComment } from "./core/review-pr";
import { runGhWithRetry } from "./core/gh-retry";

type ExecaFn = typeof execa;
const GUARD_NO_ACTIVE_TURN_EXIT_CODE = 2;
const GUARD_INVALID_TURN_EXIT_CODE = 3;
const GUARD_REMEDIATION = "Run: node dist/cli.cjs turn start --issue <n>";
const GH_API_PAGE_SIZE = 100;

function printGhCommand(args: string[]): void {
  console.log("$ " + ["gh", ...args].join(" "));
}

function printPathList(title: string, paths: string[]): void {
  if (!paths.length) return;
  console.log(`\n${title}:`);
  for (const entry of paths) {
    console.log(`- ${entry}`);
  }
}

type JsonRecord = Record<string, unknown>;

type IssueSnapshot = {
  number: number;
  title: string;
  state: string | null;
  labels: string[];
  milestone: string | null;
  updatedAt: string | null;
  url: string | null;
};

type PullRequestSnapshot = {
  number: number;
  state: string | null;
  title: string;
  url: string | null;
};

type BranchTrackingSnapshot = {
  branch: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
};

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

function parseLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === "string") return name.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function parseIssueSnapshots(stdout: string, context: string): IssueSnapshot[] {
  const rows = parseJsonArray(stdout, context);
  const snapshots: IssueSnapshot[] = [];

  for (const row of rows) {
    const number = row.number;
    const title = row.title;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== "string" || !title.trim()) continue;

    const milestoneRaw = row.milestone;
    const milestone =
      typeof milestoneRaw === "object" && milestoneRaw !== null && typeof milestoneRaw.title === "string"
        ? milestoneRaw.title.trim() || null
        : null;

    const state = typeof row.state === "string" ? row.state.trim() || null : null;
    const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt.trim() || null : null;
    const url = typeof row.url === "string" ? row.url.trim() || null : null;

    snapshots.push({
      number,
      title: title.trim(),
      state,
      labels: parseLabelNames(row.labels),
      milestone,
      updatedAt,
      url,
    });
  }

  return snapshots;
}

function parsePullRequestSnapshots(stdout: string, context: string): PullRequestSnapshot[] {
  const rows = parseJsonArray(stdout, context);
  const snapshots: PullRequestSnapshot[] = [];

  for (const row of rows) {
    const number = row.number;
    const title = row.title;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== "string" || !title.trim()) continue;

    const state = typeof row.state === "string" ? row.state.trim() || null : null;
    const url = typeof row.url === "string" ? row.url.trim() || null : null;

    snapshots.push({
      number,
      title: title.trim(),
      state,
      url,
    });
  }

  return snapshots;
}

function formatIssueSnapshot(snapshot: IssueSnapshot): string {
  const labels = snapshot.labels.length ? snapshot.labels.join(", ") : "-";
  const state = snapshot.state ?? "OPEN";
  const updatedAt = snapshot.updatedAt ?? "-";
  return `${snapshot.number}\t${state}\t${snapshot.title}\t${labels}\t${updatedAt}`;
}

function findInProgressIssues(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => issue.labels.some((label) => label.trim().toLowerCase() === "status:in-progress"));
}

function findIssuesMissingMilestone(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => !issue.milestone);
}

function findIssuesMissingModuleLabel(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => !issue.labels.some((label) => label.trim().toLowerCase().startsWith("module:")));
}

function printIssueBlock(title: string, snapshots: IssueSnapshot[], limit: number): void {
  console.log(`\n${title}:`);
  if (!snapshots.length) {
    console.log("none");
    return;
  }

  for (const snapshot of snapshots.slice(0, limit)) {
    console.log(formatIssueSnapshot(snapshot));
  }
}

function printHygieneWarnings(snapshots: IssueSnapshot[]): void {
  const missingMilestone = findIssuesMissingMilestone(snapshots);
  const missingModule = findIssuesMissingModuleLabel(snapshots);

  console.log("\nTracker hygiene warnings:");
  if (!missingMilestone.length && !missingModule.length) {
    console.log("none");
    return;
  }

  if (missingMilestone.length) {
    const ids = missingMilestone.map((issue) => `#${issue.number}`).join(", ");
    console.log(`missing milestone: ${ids}`);
  }

  if (missingModule.length) {
    const ids = missingModule.map((issue) => `#${issue.number}`).join(", ");
    console.log(`missing module label: ${ids}`);
  }
}

async function promptTrackerReconcileValue(request: TrackerReconcilePromptRequest): Promise<string | null> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = process;
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const suggestionText = request.suggestions.length ? ` [suggestions: ${request.suggestions.join(", ")}]` : "";
    const prompt =
      request.kind === "module"
        ? `tracker reconcile: issue #${request.issueNumber} missing module${suggestionText}. Enter module label: `
        : `tracker reconcile: issue #${request.issueNumber} missing milestone${suggestionText}. Enter milestone title: `;
    const answer = (await rl.question(prompt)).trim();
    return answer || null;
  } finally {
    rl.close();
  }
}

async function resolveRepoNameWithOwner(execaFn: ExecaFn): Promise<string> {
  const repo = await runGhWithRetry(execaFn, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stdio: "pipe",
  });
  const slug = repo.stdout.trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("unable to resolve repository owner/name from gh");
  }
  return slug;
}

async function listPaginatedGhApiRecords(execaFn: ExecaFn, endpoint: string, context: string): Promise<JsonRecord[]> {
  const all: JsonRecord[] = [];

  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const paginatedEndpoint = `${endpoint}${separator}per_page=${GH_API_PAGE_SIZE}&page=${page}`;
    const response = await runGhWithRetry(execaFn, ["api", paginatedEndpoint], { stdio: "pipe" });
    const parsed = parseJsonArray(response.stdout, context);
    all.push(...parsed);
    if (parsed.length < GH_API_PAGE_SIZE) {
      break;
    }
  }

  return all;
}

async function listExistingMilestoneTitles(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const parsed = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/milestones?state=all`, "gh milestones");
  const titles = parsed
    .map((row) => row.title)
    .filter((value): value is string => typeof value === "string")
    .map((title) => title.trim())
    .filter(Boolean);
  return new Set(titles);
}

async function listExistingLabelNames(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const parsed = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/labels`, "gh labels");
  const names = parsed
    .map((row) => row.name)
    .filter((value): value is string => typeof value === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set(names);
}

async function listOpenIssueSnapshots(execaFn: ExecaFn, limit: number): Promise<IssueSnapshot[]> {
  const response = await runGhWithRetry(
    execaFn,
    ["issue", "list", "--state", "open", "-L", String(limit), "--json", "number,title,state,labels,milestone,updatedAt,url"],
    { stdio: "pipe" },
  );
  return parseIssueSnapshots(response.stdout, "gh issue list");
}

async function fetchIssueSnapshotByNumber(execaFn: ExecaFn, issueId: number): Promise<IssueSnapshot | null> {
  const response = await runGhWithRetry(
    execaFn,
    ["issue", "view", String(issueId), "--json", "number,title,state,labels,milestone,updatedAt,url"],
    {
      stdio: "pipe",
    },
  );
  const parsed = parseIssueSnapshots(`[${response.stdout}]`, "gh issue view");
  return parsed[0] ?? null;
}

async function listBranchPullRequestSnapshots(execaFn: ExecaFn, branch: string): Promise<PullRequestSnapshot[]> {
  const response = await runGhWithRetry(
    execaFn,
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,state,url"],
    {
      stdio: "pipe",
    },
  );
  return parsePullRequestSnapshots(response.stdout, "gh pr list");
}

async function findOpenPullRequestNumberByBranch(execaFn: ExecaFn, branch: string): Promise<number | null> {
  const response = await runGhWithRetry(
    execaFn,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number"],
    {
      stdio: "pipe",
    },
  );

  const rows = parseJsonArray(response.stdout, "gh pr list");
  for (const row of rows) {
    const number = parsePositiveInt(row.number);
    if (number) return number;
  }

  return null;
}

async function resolvePullRequestHeadSha(execaFn: ExecaFn, prNumber: number): Promise<string> {
  const viewed = await runGhWithRetry(execaFn, ["pr", "view", String(prNumber), "--json", "headRefOid"], {
    stdio: "pipe",
  });
  const row = parseJsonObject(viewed.stdout, "gh pr view");
  const headSha = parseNullableString(row.headRefOid);
  if (!headSha) {
    throw new Error(`postflight --apply: unable to resolve headRefOid for PR #${prNumber}`);
  }
  return headSha;
}

async function resolveGitRefHeadSha(execaFn: ExecaFn, ref: string): Promise<string> {
  const response = await execaFn("git", ["rev-parse", ref], { stdio: "pipe" });
  const head = response.stdout.trim();
  if (!head) {
    throw new Error(`unable to resolve git ref HEAD sha for '${ref}'`);
  }
  return head;
}

async function enforcePostflightApplyReviewGate(params: {
  execaFn: ExecaFn;
  issueId: string;
  branch: string;
  dryRun: boolean;
}): Promise<void> {
  const { execaFn, issueId, branch, dryRun } = params;
  if (dryRun) return;

  const normalizedBranch = branch.trim();
  if (!normalizedBranch) return;

  const prNumber = await findOpenPullRequestNumberByBranch(execaFn, normalizedBranch);
  if (!prNumber) return;

  const repo = await resolveRepoNameWithOwner(execaFn);
  const headSha = await resolvePullRequestHeadSha(execaFn, prNumber);
  const hasReview = await hasReviewForHead(execaFn, repo, prNumber, headSha);
  if (hasReview) return;

  const shortHead = headSha.slice(0, 12);
  throw new Error(
    `postflight --apply: review gate missing for branch '${normalizedBranch}' HEAD ${shortHead} on PR #${prNumber}. Run: node dist/cli.cjs review --issue ${issueId}`,
  );
}

async function resolveCurrentBranchName(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" });
  const branch = response.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("unable to resolve current git branch");
  }
  return branch;
}

function parseCurrentBranchFromStatus(statusOutput: string): string | null {
  const firstLine = statusOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const match = /^##\s+(.+)$/.exec(firstLine);
  if (!match) return null;

  const branchInfo = match[1].trim();
  if (!branchInfo) return null;

  if (branchInfo.startsWith("HEAD ")) return null;

  const noCommitsPrefix = "No commits yet on ";
  if (branchInfo.startsWith(noCommitsPrefix)) {
    const branch = branchInfo.slice(noCommitsPrefix.length).trim();
    return branch || null;
  }

  const branch = branchInfo.split("...")[0]?.trim() ?? "";
  const [branchName = ""] = branch.split(/\s+/);
  return branchName || null;
}

function parseAheadBehindState(raw: string): { ahead: number; behind: number; upstreamGone: boolean } {
  let ahead = 0;
  let behind = 0;
  let upstreamGone = false;

  for (const segment of raw.split(",")) {
    const token = segment.trim().toLowerCase();
    if (!token) continue;

    const aheadMatch = /^ahead\s+(\d+)$/.exec(token);
    if (aheadMatch) {
      ahead = Number(aheadMatch[1]);
      continue;
    }

    const behindMatch = /^behind\s+(\d+)$/.exec(token);
    if (behindMatch) {
      behind = Number(behindMatch[1]);
      continue;
    }

    if (token.includes("gone")) {
      upstreamGone = true;
    }
  }

  return { ahead, behind, upstreamGone };
}

function parseStatusTrackingSnapshot(statusOutput: string): BranchTrackingSnapshot | null {
  const firstLine = statusOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const match = /^##\s+(.+)$/.exec(firstLine);
  if (!match) return null;

  const branchInfo = match[1].trim();
  if (!branchInfo || branchInfo.startsWith("HEAD ")) return null;

  const noCommitsPrefix = "No commits yet on ";
  if (branchInfo.startsWith(noCommitsPrefix)) {
    const branch = branchInfo.slice(noCommitsPrefix.length).trim();
    if (!branch) return null;
    return {
      branch,
      current: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    };
  }

  const [branchPart, upstreamPart = ""] = branchInfo.split("...", 2);
  const branch = branchPart.trim().split(/\s+/)[0]?.trim() ?? "";
  if (!branch) return null;

  if (!upstreamPart.trim()) {
    return {
      branch,
      current: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    };
  }

  const trackingMatch = /^([^\s]+)(?:\s+\[(.+)\])?$/.exec(upstreamPart.trim());
  const upstream = trackingMatch?.[1]?.trim() ?? "";
  const relation = trackingMatch?.[2]?.trim() ?? "";
  const parsed = parseAheadBehindState(relation);

  return {
    branch,
    current: true,
    upstream: upstream || null,
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstreamGone: parsed.upstreamGone,
  };
}

function parseBranchVvSnapshots(branchVvOutput: string): BranchTrackingSnapshot[] {
  const snapshots: BranchTrackingSnapshot[] = [];

  for (const rawLine of branchVvOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const current = line.startsWith("* ");
    const normalized = current || line.startsWith("+ ") ? line.slice(2).trim() : line;
    const branch = normalized.split(/\s+/)[0]?.trim() ?? "";
    if (!branch || branch.startsWith("(")) continue;

    snapshots.push({
      branch,
      current,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    });
  }

  return snapshots;
}

function parseRevListAheadBehind(raw: string): { ahead: number; behind: number } | null {
  const [aheadRaw = "", behindRaw = ""] = raw.trim().split(/\s+/);
  if (!aheadRaw || !behindRaw) return null;

  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;

  return {
    ahead: Math.max(0, Math.trunc(ahead)),
    behind: Math.max(0, Math.trunc(behind)),
  };
}

async function resolveBranchTrackingSnapshot(
  execaFn: ExecaFn,
  branch: string,
  current: boolean,
): Promise<BranchTrackingSnapshot> {
  const upstreamProbe = await execaFn("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], {
    stdio: "pipe",
    reject: false,
  });
  const upstreamRaw = upstreamProbe.exitCode === 0 ? upstreamProbe.stdout.trim() : "";

  if (!upstreamRaw || upstreamRaw.includes("@{upstream}")) {
    return {
      branch,
      current,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    };
  }

  const revList = await execaFn("git", ["rev-list", "--left-right", "--count", `${branch}...${upstreamRaw}`], {
    stdio: "pipe",
    reject: false,
  });

  if (revList.exitCode !== 0) {
    return {
      branch,
      current,
      upstream: upstreamRaw,
      ahead: 0,
      behind: 0,
      upstreamGone: true,
    };
  }

  const counts = parseRevListAheadBehind(revList.stdout);
  return {
    branch,
    current,
    upstream: upstreamRaw,
    ahead: counts?.ahead ?? 0,
    behind: counts?.behind ?? 0,
    upstreamGone: false,
  };
}

function buildPullCommandForUpstream(upstream: string | null): string {
  if (!upstream) return "git pull --ff-only origin main";
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator >= upstream.length - 1) {
    return `git pull --ff-only ${upstream}`;
  }
  const remote = upstream.slice(0, separator);
  const branch = upstream.slice(separator + 1);
  return `git pull --ff-only ${remote} ${branch}`;
}

function buildRebaseCommandForUpstream(upstream: string | null): string {
  if (!upstream) return "git rebase origin/main";
  return `git rebase ${upstream}`;
}

function isClosedOrMergedPrState(state: string | null): boolean {
  const normalized = (state ?? "").trim().toUpperCase();
  return normalized === "CLOSED" || normalized === "MERGED";
}

async function enforceTurnStartRemoteGuard(execaFn: ExecaFn): Promise<void> {
  await execaFn("git", ["fetch", "origin"], { stdio: "pipe" });

  const [statusResult, branchResult] = await Promise.all([
    execaFn("git", ["status", "-sb"], { stdio: "pipe" }),
    execaFn("git", ["branch", "-vv"], { stdio: "pipe" }),
  ]);

  const statusTracking = parseStatusTrackingSnapshot(statusResult.stdout);
  const branchSnapshots = parseBranchVvSnapshots(branchResult.stdout);
  const currentFromVv = branchSnapshots.find((snapshot) => snapshot.current)?.branch ?? null;
  const currentBranch = statusTracking?.branch ?? currentFromVv ?? null;
  if (!currentBranch) {
    throw new Error("turn start: guard could not resolve current branch after `git status -sb`.");
  }

  const hasMainBranch = branchSnapshots.some((snapshot) => snapshot.branch === "main");
  const [currentResolved, mainResolved] = await Promise.all([
    resolveBranchTrackingSnapshot(execaFn, currentBranch, true),
    hasMainBranch && currentBranch !== "main" ? resolveBranchTrackingSnapshot(execaFn, "main", false) : Promise.resolve(null),
  ]);

  const currentHasStatusUpstream = Boolean(statusTracking?.upstream);
  const currentUpstream = currentHasStatusUpstream ? statusTracking?.upstream ?? null : currentResolved.upstream;
  const currentAhead = currentHasStatusUpstream ? statusTracking?.ahead ?? 0 : currentResolved.ahead;
  const currentBehind = currentHasStatusUpstream ? statusTracking?.behind ?? 0 : currentResolved.behind;
  const currentUpstreamGone = currentHasStatusUpstream
    ? Boolean(statusTracking?.upstreamGone || currentResolved.upstreamGone)
    : currentResolved.upstreamGone;

  const blockers: string[] = [];
  const remediation = new Set<string>();

  remediation.add("git fetch origin");

  if (currentUpstreamGone) {
    blockers.push(`- current branch '${currentBranch}' tracks '${currentUpstream ?? "unknown"}' but upstream is gone.`);
    remediation.add("git checkout main");
    remediation.add("git pull --ff-only origin main");
  }

  if (currentBehind > 0 && currentAhead > 0) {
    blockers.push(
      `- current branch '${currentBranch}' diverged from '${currentUpstream ?? "upstream"}' (ahead ${currentAhead}, behind ${currentBehind}).`,
    );
    remediation.add(buildRebaseCommandForUpstream(currentUpstream));
  } else if (currentBehind > 0) {
    blockers.push(
      `- current branch '${currentBranch}' is behind '${currentUpstream ?? "upstream"}' by ${currentBehind} commit(s).`,
    );
    remediation.add(buildPullCommandForUpstream(currentUpstream));
  }

  if (mainResolved && currentBranch !== "main" && mainResolved.upstream && mainResolved.behind > 0) {
    if (mainResolved.ahead > 0) {
      blockers.push(
        `- local 'main' diverged from '${mainResolved.upstream}' (ahead ${mainResolved.ahead}, behind ${mainResolved.behind}).`,
      );
      remediation.add(buildRebaseCommandForUpstream(mainResolved.upstream));
    } else {
      blockers.push(
        `- local 'main' is behind '${mainResolved.upstream}' by ${mainResolved.behind} commit(s).`,
      );
      remediation.add(buildPullCommandForUpstream(mainResolved.upstream));
    }
  }

  let branchPrSnapshots: PullRequestSnapshot[] = [];
  try {
    branchPrSnapshots = await listBranchPullRequestSnapshots(execaFn, currentBranch);
  } catch {
    branchPrSnapshots = [];
  }

  const closedOrMergedPrs = branchPrSnapshots.filter((snapshot) => isClosedOrMergedPrState(snapshot.state));
  if (closedOrMergedPrs.length > 0) {
    const summary = closedOrMergedPrs
      .slice(0, 3)
      .map((snapshot) => `#${snapshot.number} (${(snapshot.state ?? "unknown").toUpperCase()})`)
      .join(", ");
    blockers.push(`- current branch '${currentBranch}' already has closed/merged PRs: ${summary}.`);
    remediation.add("git checkout main");
    remediation.add("git pull --ff-only origin main");
  }

  if (!blockers.length) return;

  const nextSteps = Array.from(remediation).map((command) => `- ${command}`);
  nextSteps.push("- node dist/cli.cjs turn start --issue <n>");

  throw new Error(
    ["turn start: remote state guard blocked branch creation.", ...blockers, "Remediation:", ...nextSteps].join("\n"),
  );
}

async function runTrackerBootstrap(execaFn: ExecaFn, dryRun: boolean): Promise<void> {
  const repo = await resolveRepoNameWithOwner(execaFn);
  const [existingMilestones, existingLabels] = await Promise.all([
    listExistingMilestoneTitles(execaFn, repo),
    listExistingLabelNames(execaFn, repo),
  ]);
  const milestonesToCreate = selectMissingTrackerMilestones(existingMilestones);
  const labelsToCreate = selectMissingTrackerLabels(existingLabels);

  console.log(`tracker bootstrap: repo ${repo}`);
  if (!milestonesToCreate.length && !labelsToCreate.length) {
    console.log("tracker bootstrap: already configured.");
    if (!dryRun) {
      const markerPath = await writeTrackerBootstrapMarker(repo);
      console.log(`tracker bootstrap: marker updated at ${markerPath}`);
    }
    return;
  }

  if (milestonesToCreate.length > 0) {
    console.log("\nMilestones to create:");
    for (const milestone of milestonesToCreate) {
      console.log(`- ${milestone.title}`);
      const args = [
        "api",
        "--method",
        "POST",
        `repos/${repo}/milestones`,
        "-f",
        `title=${milestone.title}`,
        "-f",
        `description=${milestone.description}`,
      ];
      printGhCommand(args);
      if (!dryRun) {
        await runGhWithRetry(execaFn, args, { stdio: "inherit" });
      }
    }
  } else {
    console.log("Milestones: already configured.");
  }

  if (labelsToCreate.length > 0) {
    console.log("\nLabels to create:");
    for (const label of labelsToCreate) {
      console.log(`- ${label.name}`);
      const args = ["label", "create", label.name, "--color", label.color, "--description", label.description];
      printGhCommand(args);
      if (!dryRun) {
        await runGhWithRetry(execaFn, args, { stdio: "inherit" });
      }
    }
  } else {
    console.log("Labels: already configured.");
  }

  if (dryRun) {
    console.log("\ntracker bootstrap: dry-run complete.");
    return;
  }

  const markerPath = await writeTrackerBootstrapMarker(repo);
  console.log(`\ntracker bootstrap: DONE (${markerPath})`);
}

type PrBodySyncParams = {
  execaFn: ExecaFn;
  issueId: string;
  prNumbers: number[];
  dryRun: boolean;
};

async function syncPrBodiesWithIssueReference(params: PrBodySyncParams): Promise<void> {
  const { execaFn, issueId, prNumbers, dryRun } = params;

  for (const prNumber of prNumbers) {
    const pr = String(prNumber);

    if (dryRun) {
      printGhCommand(["pr", "view", pr, "--json", "body,url"]);
      printGhCommand(["pr", "edit", pr, "--body", `<existing-body>\\n\\nFixes #${issueId}`]);
      continue;
    }

    const viewArgs = ["pr", "view", pr, "--json", "body,url"];
    printGhCommand(viewArgs);
    const prView = await runGhWithRetry(execaFn, viewArgs, { stdio: "pipe" });

    let currentBody = "";
    if (prView.stdout.trim()) {
      const parsed = JSON.parse(prView.stdout) as { body?: unknown };
      if (typeof parsed.body === "string") {
        currentBody = parsed.body;
      }
    }

    const nextBody = appendIssueAutocloseReference(currentBody, issueId);
    if (nextBody === currentBody) {
      console.log(`PR #${pr} already references issue #${issueId}.`);
      continue;
    }

    const editArgs = ["pr", "edit", pr, "--body", nextBody];
    printGhCommand(editArgs);
    await runGhWithRetry(execaFn, editArgs, { stdio: "inherit" });
  }
}

async function issueTitleFromGitHub(execaFn: ExecaFn, issueId: number): Promise<string> {
  try {
    const issue = await runGhWithRetry(execaFn, ["issue", "view", String(issueId), "--json", "title", "-q", ".title"], {
      stdio: "pipe",
    });
    const title = issue.stdout.trim();
    if (title) {
      return title;
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return `issue-${issueId}`;
}

async function checkoutOrCreateBranch(execaFn: ExecaFn, branch: string): Promise<void> {
  const probe = await execaFn("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    stdio: "pipe",
    reject: false,
  });

  if (probe.exitCode === 0) {
    await execaFn("git", ["checkout", branch], { stdio: "inherit" });
    return;
  }

  await execaFn("git", ["checkout", "-b", branch], { stdio: "inherit" });
}

export function createProgram(execaFn: ExecaFn = execa): Command {
  const program = new Command();

  program.name("vibe").description("Vibe-backlog CLI (MVP)").version("0.1.0");

  const turn = program.command("turn").description("Manage active local turn context");

  turn
    .command("start")
    .description("Start a turn from an issue number")
    .requiredOption("--issue <n>", "GitHub issue number")
    .action(async (opts) => {
      const issueRaw = String(opts.issue).trim();
      if (!/^[0-9]+$/.test(issueRaw)) {
        console.error("turn start: --issue debe ser un entero positivo.");
        process.exitCode = 1;
        return;
      }

      const issueId = Number(issueRaw);
      if (!Number.isSafeInteger(issueId) || issueId <= 0) {
        console.error("turn start: --issue debe ser un entero positivo.");
        process.exitCode = 1;
        return;
      }

      try {
        await enforceTurnStartRemoteGuard(execaFn);
        const issueTitle = await issueTitleFromGitHub(execaFn, issueId);
        const branch = buildTurnBranch(issueId, issueTitle);

        await checkoutOrCreateBranch(execaFn, branch);

        const turnContext = {
          issue_id: issueId,
          branch,
          base_branch: "main",
          started_at: new Date().toISOString(),
          issue_title: issueTitle,
        };

        await writeTurnContext(turnContext);
        const reviewTemplates = await ensureIssueReviewTemplates(issueId);
        if (reviewTemplates.created.length) {
          console.log(`review templates: created ${reviewTemplates.created.length} file(s) at ${reviewTemplates.directory}`);
        } else {
          console.log(`review templates: already present at ${reviewTemplates.directory}`);
        }
        console.log(JSON.stringify(turnContext, null, 2));
      } catch (error) {
        console.error("turn start: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  turn
    .command("show")
    .description("Show active turn context")
    .action(async () => {
      try {
        const activeTurn = await readTurnContext();
        if (!activeTurn) {
          console.log("no active turn");
          return;
        }

        console.log(JSON.stringify(activeTurn, null, 2));
      } catch (error) {
        console.error("turn show: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  turn
    .command("end")
    .description("End active turn context")
    .action(async () => {
      try {
        const deleted = await clearTurnContext();
        if (!deleted) {
          console.log("no active turn");
          return;
        }

        console.log("turn ended");
      } catch (error) {
        console.error("turn end: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("guard")
    .description("Fail when there is no valid active turn context")
    .action(async () => {
      try {
        const activeTurn = await readTurnContext();
        if (!activeTurn) {
          console.error("guard: no active turn.");
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_NO_ACTIVE_TURN_EXIT_CODE;
          return;
        }

        const turnErrors = validateTurnContext(activeTurn);
        if (turnErrors.length > 0) {
          console.error(`guard: invalid active turn (missing/invalid: ${turnErrors.join(", ")}).`);
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_INVALID_TURN_EXIT_CODE;
          return;
        }

        console.log(
          `guard: OK issue=${activeTurn.issue_id} branch=${activeTurn.branch} base_branch=${activeTurn.base_branch}`,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error("guard: invalid active turn (malformed turn.json).");
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_INVALID_TURN_EXIT_CODE;
          return;
        }

        console.error("guard: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  const tracker = program.command("tracker").description("Manage tracker bootstrap for current repository");

  tracker
    .command("bootstrap")
    .description("Create default milestones + module labels in current GitHub repo")
    .option("--dry-run", "Print gh commands without executing them", false)
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun);

      try {
        await runTrackerBootstrap(execaFn, dryRun);
      } catch (error) {
        console.error("tracker bootstrap: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  tracker
    .command("reconcile")
    .description("Reconcile missing module:* labels and milestones for open issues")
    .option("--dry-run", "Print planned gh commands without executing them", false)
    .option("--fallback-module <name>", "Fallback module label/name when inference is uncertain")
    .option("--fallback-milestone <title>", "Fallback milestone title when inference is uncertain")
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun);
      const fallbackModule = typeof opts.fallbackModule === "string" ? opts.fallbackModule : null;
      const fallbackMilestone = typeof opts.fallbackMilestone === "string" ? opts.fallbackMilestone : null;

      try {
        const result = await runTrackerReconcile(
          {
            dryRun,
            fallbackModule,
            fallbackMilestone,
          },
          {
            execaFn,
            promptFn: promptTrackerReconcileValue,
          },
        );

        console.log(`tracker reconcile: repo ${result.repo}`);

        if (!result.issueUpdates.length) {
          console.log("tracker reconcile: no issue updates planned.");
        } else {
          console.log(`tracker reconcile: planned issue updates=${result.issueUpdates.length}`);
          for (const update of result.issueUpdates) {
            const labels = update.addLabels.length ? update.addLabels.join(", ") : "-";
            const milestone = update.setMilestone ?? "-";
            console.log(`#${update.issueNumber} labels[${labels}] milestone[${milestone}]`);
          }
        }

        if (result.unresolvedIssueIds.length) {
          console.log(`tracker reconcile: unresolved issues=${result.unresolvedIssueIds.map((id) => `#${id}`).join(", ")}`);
        }

        if (result.commands.length) {
          console.log("\nPlanned commands:");
          for (const args of result.commands) {
            printGhCommand(args);
          }
        }

        if (result.degradedToPlanOnly) {
          console.log("\ntracker reconcile: plan-only mode (no changes applied).");
          if (result.planOnlyReason) {
            console.log(result.planOnlyReason);
          }
          return;
        }

        if (result.dryRun) {
          console.log("\ntracker reconcile: dry-run complete.");
          return;
        }

        if (result.applied) {
          console.log(`\ntracker reconcile: DONE (${result.issueUpdates.length} issue update(s))`);
          return;
        }

        console.log("\ntracker reconcile: no changes applied.");
      } catch (error) {
        console.error("tracker reconcile: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  const pr = program.command("pr").description("Pull request workflows");

  pr
    .command("open")
    .description("Create or reuse an open PR linked to an issue")
    .option("--issue <n>", "GitHub issue number override")
    .option("--branch <name>", "Branch override (defaults to active turn/current branch)")
    .option("--base <name>", "Base branch override (defaults to active turn/main)")
    .option("--dry-run", "Print planned PR payload without creating PR", false)
    .option("--skip-review-gate", "Bypass review gate and leave an audit marker on the PR", false)
    .action(async (opts) => {
      try {
        const result = await runPrOpenCommand(
          {
            issueOverride: opts.issue ?? null,
            branchOverride: opts.branch ?? null,
            baseBranchOverride: opts.base ?? null,
            dryRun: Boolean(opts.dryRun),
          },
          execaFn,
        );

        if (result.dryRun) {
          console.log(`pr open: dry-run issue=#${result.issueId} branch=${result.branch} base=${result.baseBranch}`);
          console.log(`title: ${result.title}`);
          console.log("body:");
          console.log(result.body);
        } else {
          const numberText = result.prNumber ? `#${result.prNumber}` : "(unknown)";
          const urlText = result.prUrl ?? "(no-url)";
          if (result.created) {
            console.log(`pr open: created ${numberText} ${urlText}`);
          } else {
            console.log(`pr open: already open ${numberText} ${urlText}`);
          }
          if (result.rationaleAutofilled) {
            console.log("pr open: rationale sections autofilled in existing PR body.");
          }
        }

        const skipReviewGate = Boolean(opts.skipReviewGate);
        if (skipReviewGate && result.dryRun) {
          console.log("pr open: review gate skipped (dry-run, no audit comment).");
          return;
        }

        const headSha = await resolveGitRefHeadSha(execaFn, result.branch);
        const shortHead = headSha.slice(0, 12);

        if (skipReviewGate) {
          if (result.prNumber) {
            const repo = await resolveRepoNameWithOwner(execaFn);
            await postReviewGateSkipComment({
              execaFn,
              repo,
              prNumber: result.prNumber,
              issueId: result.issueId,
              headSha,
              dryRun: result.dryRun,
            });
          }
          console.log(`pr open: review gate skipped for HEAD ${shortHead}.`);
          return;
        }

        let gateSatisfied = false;
        if (result.prNumber) {
          const repo = await resolveRepoNameWithOwner(execaFn);
          gateSatisfied = await hasReviewForHead(execaFn, repo, result.prNumber, headSha);
        }

        if (gateSatisfied) {
          console.log(`pr open: review gate satisfied for HEAD ${shortHead}.`);
          return;
        }

        if (!result.dryRun) {
          const currentBranch = await resolveCurrentBranchName(execaFn);
          if (currentBranch !== result.branch) {
            throw new Error(
              `pr open: review gate targets branch '${result.branch}' but current branch is '${currentBranch}'. Checkout '${result.branch}' or run with --skip-review-gate.`,
            );
          }
        }

        console.log(`pr open: review gate missing for HEAD ${shortHead}; running vibe review...`);
        const reviewResult = await runReviewCommand(
          {
            issueOverride: result.issueId,
            branchOverride: result.branch,
            baseBranchOverride: result.baseBranch,
            agentProvider: "auto",
            agentCmd: null,
            dryRun: result.dryRun,
            autofix: true,
            autopush: true,
            publish: true,
            maxAttempts: 5,
            strict: false,
            followupLabel: null,
          },
          execaFn,
        );
        console.log(`pr open: review termination=${reviewResult.terminationReason}`);
        if (reviewResult.rationaleAutofilled) {
          console.log("pr open: rationale sections autofilled in existing PR body.");
        }
        console.log(
          `pr open: review gate complete attempts=${reviewResult.attemptsUsed} unresolved=${reviewResult.unresolvedFindings.length}`,
        );
      } catch (error) {
        console.error("pr open: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("init")
    .description("Initialize agent-first .vibe scaffolding in current repository")
    .option("--dry-run", "Print planned changes without writing files", false)
    .option("--skip-tracker", "Skip tracker bootstrap gh operations", false)
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun);
      const skipTracker = Boolean(opts.skipTracker);

      try {
        console.log(`init: ${dryRun ? "dry-run" : "apply"} mode`);
        const scaffoldResult = await scaffoldVibeInit({ dryRun });
        printPathList("Created", scaffoldResult.created);
        printPathList("Updated", scaffoldResult.updated);

        if (!skipTracker) {
          console.log("\ninit: tracker bootstrap");
          await runTrackerBootstrap(execaFn, dryRun);
        } else {
          console.log("\ninit: tracker bootstrap skipped (--skip-tracker).");
        }

        if (dryRun) {
          console.log("\ninit: dry-run complete.");
        } else {
          console.log("\ninit: DONE");
        }
      } catch (error) {
        console.error("init: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("status")
    .description("Show active turn + tracker snapshot")
    .action(async () => {
      let gitStatusOutput = "";
      let currentBranch: string | null = null;

      try {
        const git = await execaFn("git", ["status", "-sb"], { stdio: "pipe" });
        gitStatusOutput = git.stdout;
        console.log(gitStatusOutput);
        currentBranch = parseCurrentBranchFromStatus(gitStatusOutput);
      } catch {
        console.log("git status: (not available)");
      }

      let activeTurnIssueId: number | null = null;
      try {
        const activeTurn = await readTurnContext();
        if (!activeTurn) {
          console.log("\nActive turn: none");
        } else {
          const errors = validateTurnContext(activeTurn);
          if (errors.length) {
            console.log(`\nActive turn: invalid (${errors.join(", ")})`);
          } else {
            activeTurnIssueId = activeTurn.issue_id;
            console.log(
              `\nActive turn: issue=${activeTurn.issue_id} branch=${activeTurn.branch} started_at=${activeTurn.started_at ?? "-"}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.log("\nActive turn: invalid (malformed turn.json)");
        } else {
          console.log("\nActive turn: unavailable");
        }
      }

      let openIssues: IssueSnapshot[] = [];
      let ghAvailable = false;
      try {
        openIssues = await listOpenIssueSnapshots(execaFn, 100);
        ghAvailable = true;
      } catch (error) {
        console.log("\nTracker snapshot: unavailable (gh issue list failed)");
        if (error instanceof Error) {
          console.log(String(error.message || error));
        }
      }

      if (ghAvailable) {
        printIssueBlock("In-progress issues", findInProgressIssues(openIssues), 10);
        printHygieneWarnings(openIssues);
      }

      if (ghAvailable && activeTurnIssueId) {
        try {
          const issue = await fetchIssueSnapshotByNumber(execaFn, activeTurnIssueId);
          if (issue) {
            const labels = issue.labels.length ? issue.labels.join(", ") : "-";
            console.log(`\nActive issue: #${issue.number} ${issue.state ?? "OPEN"} ${issue.title}`);
            console.log(`Active issue labels: ${labels}`);
            console.log(`Active issue milestone: ${issue.milestone ?? "-"}`);
          }
        } catch {
          console.log("\nActive issue: unavailable from gh");
        }
      }

      if (ghAvailable && currentBranch) {
        try {
          const prs = await listBranchPullRequestSnapshots(execaFn, currentBranch);
          console.log("\nBranch PRs:");
          if (!prs.length) {
            console.log("none");
          } else {
            for (const pr of prs) {
              console.log(`#${pr.number} ${pr.state ?? "-"} ${pr.title}${pr.url ? ` (${pr.url})` : ""}`);
            }
          }
        } catch {
          console.log("\nBranch PRs: unavailable");
        }
      }
    });

  program
    .command("review")
    .description("Run role-based review passes and publish final report to PR")
    .option("--issue <n>", "GitHub issue number override")
    .option("--agent-provider <provider>", "Review agent provider (auto|codex|claude|gemini|command)", "auto")
    .option("--agent-cmd <cmd>", "External review agent command (fallback: VIBE_REVIEW_AGENT_CMD)")
    .option("--dry-run", "Plan review run without mutating git/GitHub", false)
    .option("--no-autofix", "Disable autofix mode for the external review agent")
    .option("--no-autopush", "Disable automatic git commit/push at the end")
    .option("--no-publish", "Skip PR publication (summary/review/inline comments)")
    .option("--max-attempts <n>", "Maximum review attempts before creating follow-up issue", "5")
    .option("--strict", "Exit non-zero when unresolved findings remain after max attempts", false)
    .option("--followup-label <label>", "Override follow-up issue label (bug|enhancement)")
    .action(async (opts) => {
      const followupLabelRaw = typeof opts.followupLabel === "string" ? opts.followupLabel.trim().toLowerCase() : "";
      if (followupLabelRaw && followupLabelRaw !== "bug" && followupLabelRaw !== "enhancement") {
        console.error("review: --followup-label must be one of: bug, enhancement");
        process.exitCode = 1;
        return;
      }

      const parsedMaxAttempts = Number(opts.maxAttempts);
      if (!Number.isFinite(parsedMaxAttempts)) {
        console.error("review: --max-attempts must be a number.");
        process.exitCode = 1;
        return;
      }

      const providerRaw = typeof opts.agentProvider === "string" ? opts.agentProvider.trim().toLowerCase() : "auto";
      if (!REVIEW_AGENT_PROVIDER_VALUES.includes(providerRaw as (typeof REVIEW_AGENT_PROVIDER_VALUES)[number])) {
        console.error(`review: --agent-provider must be one of: ${REVIEW_AGENT_PROVIDER_VALUES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      try {
        const result = await runReviewCommand(
          {
            issueOverride: opts.issue ?? null,
            agentProvider: providerRaw,
            agentCmd: opts.agentCmd ?? null,
            dryRun: Boolean(opts.dryRun),
            autofix: Boolean(opts.autofix),
            autopush: Boolean(opts.autopush),
            publish: Boolean(opts.publish),
            maxAttempts: parsedMaxAttempts,
            strict: Boolean(opts.strict),
            followupLabel: followupLabelRaw ? (followupLabelRaw as "bug" | "enhancement") : null,
          },
          execaFn,
        );

        const issueText = result.issueId ? `#${result.issueId}` : "-";
        const branchText = result.branch ?? "-";
        console.log(`review: issue=${issueText} branch=${branchText}`);
        console.log(`review: provider=${result.provider} source=${result.providerSource}`);
        console.log(
          `review: resume_attempted=${result.resumeAttempted ? "yes" : "no"} resume_fallback=${result.resumeFallback ? "yes" : "no"}`,
        );
        if (result.providerHealedFromRuntime) {
          console.log(`review: provider_auto_heal=${result.providerHealedFromRuntime}->${result.provider}`);
        }
        console.log(`review: attempts=${result.attemptsUsed} unresolved=${result.unresolvedFindings.length}`);
        console.log(`review: termination=${result.terminationReason}`);
        if (result.rationaleAutofilled) {
          console.log("review: rationale sections autofilled in existing PR body.");
        }

        if (result.prNumber) {
          console.log(`review: pr=#${result.prNumber}`);
        } else {
          console.log("review: pr=(none)");
        }

        if (result.followUp?.url) {
          console.log(`review: follow-up=${result.followUp.url}`);
        } else if (result.followUp && !result.followUp.created) {
          console.log(`review: follow-up=(dry-run ${result.followUp.label})`);
        }

        if (result.committed) {
          console.log("review: committed and pushed autofix changes.");
        }

        console.log("\n" + result.summary);

        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
        }
      } catch (error) {
        const errorCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;

        if (errorCode === REVIEW_NO_ACTIVE_TURN_EXIT_CODE) {
          if (error instanceof Error && error.message) {
            console.error(error.message);
          } else {
            console.error("review: no active turn.");
          }
          console.error(REVIEW_REMEDIATION);
          process.exitCode = REVIEW_NO_ACTIVE_TURN_EXIT_CODE;
          return;
        }

        if (errorCode === REVIEW_INVALID_TURN_EXIT_CODE) {
          if (error instanceof Error && error.message) {
            console.error(error.message);
          } else {
            console.error("review: invalid active turn.");
          }
          console.error(REVIEW_REMEDIATION);
          process.exitCode = REVIEW_INVALID_TURN_EXIT_CODE;
          return;
        }

        console.error("review: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("preflight")
    .description("Show git + GitHub issue snapshot")
    .action(async () => {
      try {
        const git = await execaFn("git", ["status", "-sb"], { stdio: "pipe" });
        console.log(git.stdout);
      } catch {
        console.log("git status: (not available)");
      }

      let snapshots: IssueSnapshot[] = [];
      let ghIssueQueryOk = false;
      try {
        snapshots = await listOpenIssueSnapshots(execaFn, 100);
        ghIssueQueryOk = true;
        printIssueBlock("Open issues (top 10)", snapshots, 10);
      } catch (e) {
        console.log("\nOpen issues: (gh issue list not available here)");
        if (e instanceof Error) console.log(String(e.message || e));
      }

      if (ghIssueQueryOk) {
        printIssueBlock("In-progress issues", findInProgressIssues(snapshots), 10);
        printHygieneWarnings(snapshots);
      }

      try {
        const shouldHint = await shouldSuggestTrackerBootstrap();
        if (shouldHint) {
          console.log("\nTracker bootstrap suggested:");
          console.log("Detected .vibe without tracker taxonomy marker.");
          console.log("Run: node dist/cli.cjs tracker bootstrap --dry-run");
          console.log("Then: node dist/cli.cjs tracker bootstrap");
        }
      } catch {
        // Ignore hint failures: preflight must remain resilient.
      }
    });

  program
    .command("postflight")
    .description("Validate postflight artifact")
    .option("-f, --file <path>", "Path to postflight JSON", ".vibe/artifacts/postflight.json")
    .option("--apply", "Apply tracker updates using gh", false)
    .option("--dry-run", "Print gh commands without executing them", false)
    .action(async (opts) => {
      const fs = await import("node:fs/promises");

      try {
        const raw = await fs.readFile(opts.file, "utf8");
        const json = JSON.parse(raw);

        if (opts.apply) {
          const activeTurn = await readTurnContext();
          if (activeTurn) {
            const work =
              typeof json.work === "object" && json.work !== null ? (json.work as Record<string, unknown>) : {};
            json.work = work;

            const issueIdCandidate = work.issue_id;
            if (issueIdCandidate === undefined || issueIdCandidate === null || issueIdCandidate === "") {
              work.issue_id = activeTurn.issue_id;
            }

            const branchCandidate = work.branch;
            if (typeof branchCandidate !== "string" || !branchCandidate.trim()) {
              work.branch = activeTurn.branch;
            }
          }
        }

        const parsed = PostflightSchemaV1.safeParse(json);

        if (!parsed.success) {
          console.error("postflight: INVALID");
          console.error(parsed.error.format());
          process.exitCode = 1;
          return;
        }

        console.log("postflight: OK");
        console.log(`issue: ${parsed.data.work.issue_id} | branch: ${parsed.data.work.branch}`);

        if (!opts.apply) return;

        const issueIdRaw = parsed.data.work.issue_id;
        const issueId = normalizeGitHubIssueId(issueIdRaw);

        if (!issueId) {
          console.error("postflight --apply: work.issue_id debe ser el número de issue de GitHub (ej: 1, 42).");
          process.exitCode = 1;
          return;
        }

        await enforcePostflightApplyReviewGate({
          execaFn,
          issueId,
          branch: parsed.data.work.branch,
          dryRun: Boolean(opts.dryRun),
        });

        const updates = parsed.data.tracker_updates ?? [];
        const cmds = buildTrackerCommands(issueId, updates);
        const linkedPrNumbers = collectLinkedPrNumbers(updates);

        if (!cmds.length && !linkedPrNumbers.length) {
          console.log("postflight --apply: no hay tracker_updates aplicables.");
          return;
        }

        console.log("\nApplying updates:");
        for (const c of cmds) {
          printGhCommand(c.args);
          if (!opts.dryRun) {
            await runGhWithRetry(execaFn, c.args, { stdio: "inherit" });
          }
        }

        await syncPrBodiesWithIssueReference({
          execaFn,
          issueId,
          prNumbers: linkedPrNumbers,
          dryRun: Boolean(opts.dryRun),
        });

        console.log("\npostflight --apply: DONE");
      } catch (e) {
        console.error("postflight: ERROR");
        console.error(e);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv, execaFn: ExecaFn = execa): Promise<void> {
  const program = createProgram(execaFn);
  await program.parseAsync(argv);
}
