import { appendFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import {
  flattenReviewFindings,
  REVIEW_PASS_ORDER,
  runReviewAgent,
  type ReviewAgentOutput,
  type ReviewFinding,
  type ReviewPassResult,
} from "./review-agent";
import { persistReviewProviderSelection, resolveReviewAgentExecutionPlan } from "./review-provider";
import {
  buildReviewSummaryBody,
  buildReviewPolicyKey,
  closeResolvedReviewFollowUpIssues,
  computeFindingFingerprint,
  createReviewFollowUpIssue,
  fetchIssueSnapshot,
  publishReviewToPullRequest,
  resolveOrCreateReviewPullRequest,
  resolveRepoNameWithOwner,
  type FollowUpIssue,
} from "./review-pr";
import { appendReviewSummaryToPostflight } from "./review-postflight";
import {
  resolveReviewThreads,
  summarizeReviewThreadLifecycleTotals,
  type ReviewThreadsResolveResult,
} from "./review-threads";
import { ensureIssueReviewTemplates, getIssueReviewDirectory } from "./reviews";
import { readTurnContext, validateTurnContext } from "./turn";
import { runGhWithRetry } from "./gh-retry";

export const REVIEW_NO_ACTIVE_TURN_EXIT_CODE = 2;
export const REVIEW_INVALID_TURN_EXIT_CODE = 3;
export const REVIEW_UNRESOLVED_FINDINGS_EXIT_CODE = 4;
export const REVIEW_REMEDIATION = "Run: node dist/cli.cjs review --issue <n> (or: node dist/cli.cjs turn start --issue <n>)";
type ExecaFn = typeof execa;

export type ReviewTerminationReason =
  | "completed"
  | "max-attempts"
  | "no-autofix"
  | "no-autofix-changes"
  | "same-fingerprints";

export type ReviewCommandOptions = {
  issueOverride?: string | number | null;
  branchOverride?: string | null;
  baseBranchOverride?: string | null;
  agentCmd?: string | null;
  agentProvider?: string | null;
  dryRun: boolean;
  autofix: boolean;
  autopush: boolean;
  publish: boolean;
  maxAttempts: number;
  strict: boolean;
  followupLabel: "bug" | "enhancement" | null;
};

export type ReviewCommandResult = {
  exitCode: number;
  branch: string | null;
  issueId: number | null;
  issueTitle: string | null;
  prNumber: number | null;
  attemptsUsed: number;
  unresolvedFindings: ReviewFinding[];
  summary: string;
  followUp: FollowUpIssue | null;
  runId: string | null;
  committed: boolean;
  provider: "command" | "codex" | "claude" | "gemini";
  providerSource: "flag" | "env" | "runtime" | "host" | "bin";
  resumeAttempted: boolean;
  resumeFallback: boolean;
  providerHealedFromRuntime: "codex" | "claude" | "gemini" | null;
  terminationReason: ReviewTerminationReason;
  rationaleAutofilled: boolean;
  threadResolution: ReviewThreadsResolveResult | null;
  threadResolutionWarning: string | null;
  findingTotalsSource: "current-run" | "lifecycle";
  findingTotalsWarning: string | null;
};

type ReviewRunContext = {
  issueId: number;
  branch: string;
  baseBranch: string;
  currentBranch: string;
};

type ReviewBranchPrSnapshot = {
  body: string | null;
  baseRefName: string | null;
};

type ReviewFindingTotals = {
  observed: number;
  unresolved: number;
  resolved: number;
  source: "current-run" | "lifecycle";
  warning: string | null;
};

type SeverityCounts = Record<"P0" | "P1" | "P2" | "P3", number>;

function parseIssueIdOverride(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeMaxAttempts(value: number): number {
  if (!Number.isFinite(value)) return 5;
  const rounded = Math.trunc(value);
  if (rounded < 1) return 1;
  if (rounded > 20) return 20;
  return rounded;
}

async function resolveCurrentBranch(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" });
  const branch = response.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("review: unable to resolve current git branch");
  }
  return branch;
}

async function resolveCurrentHeadSha(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("git", ["rev-parse", "HEAD"], { stdio: "pipe" });
  const sha = response.stdout.trim();
  if (!sha) {
    throw new Error("review: unable to resolve current HEAD sha");
  }
  return sha;
}

function inferIssueIdFromBranch(branch: string): number | null {
  const issuePattern = /(?:^|\/)issue-(\d+)(?:-|$)/i;
  const workflowPattern = /(?:^|\/)(?:feat|fix|chore|docs|refactor|test)\/(\d+)(?:-|$)/i;

  const issueMatch = issuePattern.exec(branch);
  if (issueMatch) {
    const parsed = Number(issueMatch[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  const workflowMatch = workflowPattern.exec(branch);
  if (workflowMatch) {
    const parsed = Number(workflowMatch[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  return null;
}

function parseJsonArray(stdout: string, context: string): Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function extractIssueIdFromPrBody(body: string): number | null {
  const regex = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  let match: RegExpExecArray | null = regex.exec(body);
  while (match) {
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
    match = regex.exec(body);
  }
  return null;
}

async function findOpenPrByBranch(execaFn: ExecaFn, branch: string): Promise<ReviewBranchPrSnapshot | null> {
  const listed = await runGhWithRetry(
    execaFn,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,body,baseRefName"],
    { stdio: "pipe" },
  );
  const rows = parseJsonArray(listed.stdout, "review: gh pr list");
  for (const row of rows) {
    const body = parseNullableString(row.body);
    const baseRefName = parseNullableString(row.baseRefName);
    return { body, baseRefName };
  }
  return null;
}

async function isWorkingTreeClean(execaFn: ExecaFn): Promise<boolean> {
  const response = await execaFn("git", ["status", "--porcelain"], { stdio: "pipe" });
  return response.stdout.trim() === "";
}

async function hasTrackedWorkingTreeChanges(execaFn: ExecaFn): Promise<boolean> {
  const response = await execaFn("git", ["status", "--porcelain"], { stdio: "pipe" });
  for (const rawLine of response.stdout.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line) continue;
    if (line.startsWith("?? ")) continue;
    return true;
  }
  return false;
}

async function resolveReviewRunContext(
  execaFn: ExecaFn,
  issueOverride: string | number | null | undefined,
  branchOverride: string | null | undefined,
  baseBranchOverride: string | null | undefined,
): Promise<ReviewRunContext> {
  const overrideProvided = issueOverride !== undefined && issueOverride !== null && String(issueOverride).trim() !== "";
  const parsedOverride = parseIssueIdOverride(issueOverride);
  if (overrideProvided && parsedOverride === null) {
    throw new Error("review: --issue debe ser un entero positivo.");
  }

  const currentBranch = await resolveCurrentBranch(execaFn);
  const overrideBranch = typeof branchOverride === "string" ? branchOverride.trim() : "";
  const branch = overrideBranch || currentBranch;
  const overrideBaseBranch = typeof baseBranchOverride === "string" ? baseBranchOverride.trim() : "";

  let activeTurn: Awaited<ReturnType<typeof readTurnContext>> = null;
  let invalidTurnReason: string | null = null;
  try {
    activeTurn = await readTurnContext();
  } catch (error) {
    if (error instanceof SyntaxError) {
      invalidTurnReason = "malformed turn.json";
      activeTurn = null;
    } else {
      throw error;
    }
  }

  const hasTurn = activeTurn !== null;
  const turnErrors = hasTurn ? validateTurnContext(activeTurn) : [];
  const validTurn = hasTurn && turnErrors.length === 0 ? activeTurn : null;
  const turnMatchesBranch = validTurn !== null && validTurn.branch === branch;

  if (hasTurn && !validTurn) {
    invalidTurnReason = `missing/invalid: ${turnErrors.join(", ")}`;
  }

  const branchInferredIssue = inferIssueIdFromBranch(branch);

  let prSnapshot: ReviewBranchPrSnapshot | null = null;
  try {
    prSnapshot = await findOpenPrByBranch(execaFn, branch);
  } catch {
    prSnapshot = null;
  }

  const prBodyInferredIssue = prSnapshot?.body ? extractIssueIdFromPrBody(prSnapshot.body) : null;

  const issueId = parsedOverride ?? (turnMatchesBranch ? validTurn?.issue_id : null) ?? branchInferredIssue ?? prBodyInferredIssue ?? null;
  if (!issueId || !Number.isSafeInteger(issueId) || issueId <= 0) {
    if (invalidTurnReason) {
      const invalid = new Error(`review: invalid active turn (${invalidTurnReason}).`);
      (invalid as Error & { code?: number }).code = REVIEW_INVALID_TURN_EXIT_CODE;
      throw invalid;
    }
    const unresolved = new Error("review: unable to resolve issue context (use --issue <n>).");
    (unresolved as Error & { code?: number }).code = REVIEW_NO_ACTIVE_TURN_EXIT_CODE;
    throw unresolved;
  }

  const baseBranch = overrideBaseBranch || (turnMatchesBranch ? validTurn?.base_branch : null) || prSnapshot?.baseRefName || "main";
  return {
    issueId,
    branch,
    baseBranch,
    currentBranch,
  };
}

function summarizeSeverity(findings: ReviewFinding[]): SeverityCounts {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

type PassFindingStats = {
  name: ReviewPassResult["name"];
  total: number;
  unresolved: number;
  resolved: number;
};

function formatPassResult(stats: PassFindingStats): string {
  return `- ${stats.name}: total=${stats.total} unresolved=${stats.unresolved} resolved=${stats.resolved}`;
}

function formatFindingLine(finding: ReviewFinding): string {
  const location =
    finding.file && finding.line
      ? ` (${finding.file}:${finding.line})`
      : finding.file
        ? ` (${finding.file})`
        : "";
  return `- [${finding.severity}] ${finding.title}${location}`;
}

function buildFindingsFingerprintKey(findings: ReviewFinding[]): string {
  if (!findings.length) return "";
  return findings.map((finding) => computeFindingFingerprint(finding)).sort().join(",");
}

function dedupeFindingsByFingerprint(findings: ReviewFinding[]): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(finding);
    if (!deduped.has(fingerprint)) {
      deduped.set(fingerprint, finding);
    }
  }
  return Array.from(deduped.values());
}

function computeResolvedFindings(allFindings: ReviewFinding[], unresolvedFindings: ReviewFinding[]): ReviewFinding[] {
  if (allFindings.length === 0) return [];
  const unresolvedFingerprints = new Set(unresolvedFindings.map((finding) => computeFindingFingerprint(finding)));
  return allFindings.filter((finding) => !unresolvedFingerprints.has(computeFindingFingerprint(finding)));
}

function toFindingKey(finding: ReviewFinding): string {
  const normalizedFile = normalizeLifecycleMergePath(finding.file ?? null);
  return `fingerprint:${computeFindingFingerprint({ ...finding, file: normalizedFile })}`;
}

function normalizeCanonicalKeyPart(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLifecycleMergePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalizeMacPrivatePrefix = (input: string): string => {
    return input.startsWith("/private/") ? input.slice("/private".length) : input;
  };

  if (path.isAbsolute(trimmed)) {
    const absolutePath = path.resolve(trimmed);
    const cwdPath = process.cwd();
    const relative = path.relative(cwdPath, absolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }

    const macRelative = path.relative(normalizeMacPrivatePrefix(cwdPath), normalizeMacPrivatePrefix(absolutePath));
    if (macRelative && !macRelative.startsWith("..") && !path.isAbsolute(macRelative)) {
      return macRelative.split(path.sep).join("/");
    }
  }
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || null;
}

function toCanonicalFindingKey(finding: ReviewFinding): string | null {
  const normalizedFile = normalizeCanonicalKeyPart(normalizeLifecycleMergePath(finding.file ?? null));
  const normalizedTitle = normalizeCanonicalKeyPart(finding.title);
  const normalizedLine = typeof finding.line === "number" && finding.line > 0 ? String(finding.line) : "";
  if (!normalizedFile && !normalizedLine && !normalizedTitle) {
    return null;
  }
  return `canonical:${normalizedFile}|${normalizedLine}|${normalizedTitle}`;
}

function buildCanonicalFindingKeyMap(findings: ReviewFinding[]): Map<string, Set<string>> {
  const mapping = new Map<string, Set<string>>();
  for (const finding of findings) {
    const canonicalKey = toCanonicalFindingKey(finding);
    if (!canonicalKey) continue;
    const primaryFindingKey = toFindingKey(finding);
    const existing = mapping.get(canonicalKey);
    if (existing) {
      existing.add(primaryFindingKey);
      continue;
    }
    mapping.set(canonicalKey, new Set([primaryFindingKey]));
  }
  return mapping;
}

function mapLifecycleFindingKeyToCurrentFindingKey(
  lifecycleKey: string,
  currentCanonicalFindingKeyMap: Map<string, Set<string>>,
): string | null {
  if (!lifecycleKey.startsWith("canonical:")) {
    return lifecycleKey;
  }
  const matchingCurrentKeys = currentCanonicalFindingKeyMap.get(lifecycleKey);
  if (!matchingCurrentKeys || matchingCurrentKeys.size === 0) {
    return lifecycleKey;
  }
  if (matchingCurrentKeys.size === 1) {
    const [singleMatch] = matchingCurrentKeys;
    return singleMatch ?? lifecycleKey;
  }
  return null;
}

function mapLifecycleFindingEntries(
  lifecycleKeys: string[],
  currentCanonicalFindingKeyMap: Map<string, Set<string>>,
): Array<{ originalKey: string; mappedKey: string | null }> {
  return lifecycleKeys.map((lifecycleKey) => ({
    originalKey: lifecycleKey,
    mappedKey: mapLifecycleFindingKeyToCurrentFindingKey(lifecycleKey, currentCanonicalFindingKeyMap),
  }));
}

function mapLifecycleFindingKeys(
  lifecycleKeys: string[],
  currentCanonicalFindingKeyMap: Map<string, Set<string>>,
): Set<string> {
  const mapped = new Set<string>();
  for (const entry of mapLifecycleFindingEntries(lifecycleKeys, currentCanonicalFindingKeyMap)) {
    const mappedKey = entry.mappedKey;
    if (mappedKey) {
      mapped.add(mappedKey);
    }
  }
  return mapped;
}

function toFindingKeySet(findings: ReviewFinding[]): Set<string> {
  return new Set(findings.map((finding) => toFindingKey(finding)));
}

function buildPassFindingStats(
  passResults: ReviewPassResult[],
  allFindings: ReviewFinding[],
  unresolvedFindings: ReviewFinding[],
): PassFindingStats[] {
  const totals = new Map<string, number>();
  const unresolved = new Map<string, number>();

  for (const finding of allFindings) {
    totals.set(finding.pass, (totals.get(finding.pass) ?? 0) + 1);
  }

  for (const finding of unresolvedFindings) {
    unresolved.set(finding.pass, (unresolved.get(finding.pass) ?? 0) + 1);
  }

  return passResults.map((pass) => {
    const total = totals.get(pass.name) ?? 0;
    const open = unresolved.get(pass.name) ?? 0;
    return {
      name: pass.name,
      total,
      unresolved: open,
      resolved: Math.max(0, total - open),
    };
  });
}

function formatTermination(terminationReason: ReviewTerminationReason): string {
  if (terminationReason === "completed" || terminationReason === "max-attempts") {
    return terminationReason;
  }
  return `early-stop (reason=${terminationReason})`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function buildOutcomeSummaryMarkdown(params: {
  issueId: number;
  issueTitle: string;
  prNumber: number | null;
  attemptsUsed: number;
  maxAttempts: number;
  output: ReviewAgentOutput;
  allFindings: ReviewFinding[];
  resolvedFindings: ReviewFinding[];
  unresolvedFindings: ReviewFinding[];
  followUp: FollowUpIssue | null;
  closedFollowUpIssueNumbers: number[];
  followUpCloseWarnings: string[];
  provider: "command" | "codex" | "claude" | "gemini";
  providerSource: "flag" | "env" | "runtime" | "host" | "bin";
  resumeAttempted: boolean;
  resumeFallback: boolean;
  providerHealedFromRuntime: "codex" | "claude" | "gemini" | null;
  terminationReason: ReviewTerminationReason;
  findingTotals: ReviewFindingTotals;
  severityTotals: SeverityCounts;
}): string {
  const passStats = buildPassFindingStats(params.output.passes, params.allFindings, params.unresolvedFindings);
  const lines = [
    "## vibe review",
    `- Issue: #${params.issueId} ${params.issueTitle}`,
    `- PR: ${params.prNumber ? `#${params.prNumber}` : "-"}`,
    `- Agent provider: ${params.provider} (source: ${params.providerSource})`,
    `- Resume: attempted=${params.resumeAttempted ? "yes" : "no"}, fallback=${params.resumeFallback ? "yes" : "no"}`,
    `- Run ID: ${params.output.run_id}`,
    `- Attempts: ${params.attemptsUsed}/${params.maxAttempts}`,
    `- Termination: ${formatTermination(params.terminationReason)}`,
    `- Findings observed: ${params.findingTotals.observed}`,
    `- Unresolved findings: ${params.findingTotals.unresolved}`,
    `- Resolved findings: ${params.findingTotals.resolved}`,
    `- Severity: P0=${params.severityTotals.P0}, P1=${params.severityTotals.P1}, P2=${params.severityTotals.P2}, P3=${params.severityTotals.P3}`,
  ];
  if (params.findingTotals.source === "lifecycle") {
    lines.push("- Findings totals scope: lifecycle (PR threads + current run)");
  }
  if (params.findingTotals.warning) {
    lines.push(`- Findings totals warning: ${params.findingTotals.warning}`);
  }
  if (params.providerHealedFromRuntime) {
    lines.push(`- Provider auto-heal: ${params.providerHealedFromRuntime} -> ${params.provider}`);
  }

  if (params.followUp?.url) {
    lines.push(`- Follow-up issue: ${params.followUp.url} (${params.followUp.label})`);
  } else if (params.followUp && !params.followUp.created) {
    lines.push(`- Follow-up issue: dry-run (${params.followUp.label})`);
  }

  lines.push("", "### Follow-up Closure");
  if (params.closedFollowUpIssueNumbers.length) {
    lines.push(`- Closed follow-ups: ${params.closedFollowUpIssueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ")}`);
  } else {
    lines.push("- none");
  }
  if (params.followUpCloseWarnings.length) {
    lines.push("", "### Follow-up Closure Warnings");
    for (const warning of params.followUpCloseWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("", "### Pass Results");
  for (const passStat of passStats) {
    lines.push(formatPassResult(passStat));
  }

  if (params.unresolvedFindings.length) {
    lines.push("", "### Unresolved Findings");
    for (const finding of params.unresolvedFindings) {
      lines.push(formatFindingLine(finding));
    }
  } else {
    lines.push("", "### Unresolved Findings", "- none");
  }

  if (params.resolvedFindings.length) {
    lines.push("", "### Resolved Findings");
    for (const finding of params.resolvedFindings) {
      lines.push(formatFindingLine(finding));
    }
  } else {
    lines.push("", "### Resolved Findings", "- none");
  }

  return lines.join("\n");
}

async function appendPassRunLog(params: {
  issueId: number;
  attempt: number;
  maxAttempts: number;
  pass: ReviewPassResult;
  runId: string;
  autofixApplied: boolean;
  changedFiles: string[];
}): Promise<void> {
  const filePath = path.join(getIssueReviewDirectory(params.issueId), `${params.pass.name}.md`);
  const timestamp = new Date().toISOString();
  const lines = [
    "",
    `## Run ${timestamp}`,
    `- run_id: ${params.runId}`,
    `- attempt: ${params.attempt}/${params.maxAttempts}`,
    `- findings: ${params.pass.findings.length}`,
    `- autofix_applied: ${params.autofixApplied ? "yes" : "no"}`,
  ];

  if (params.changedFiles.length) {
    lines.push(`- changed_files: ${params.changedFiles.join(", ")}`);
  }

  lines.push("", "### Summary", params.pass.summary, "", "### Findings");
  if (!params.pass.findings.length) {
    lines.push("- none");
  } else {
    for (const finding of params.pass.findings) {
      lines.push(formatFindingLine(finding));
    }
  }

  await appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function commitAndPushChanges(execaFn: ExecaFn, runId: string): Promise<boolean> {
  const clean = await isWorkingTreeClean(execaFn);
  if (clean) return false;

  await execaFn("git", ["add", "-A"], { stdio: "inherit" });
  const commitMessage = `chore(review): apply vibe review autofix (run ${runId})`;
  const commit = await execaFn("git", ["commit", "-m", commitMessage], { stdio: "pipe", reject: false });
  if (commit.exitCode !== 0) {
    if (commit.stdout.includes("nothing to commit") || commit.stderr.includes("nothing to commit")) {
      return false;
    }
    throw new Error(`review: git commit failed: ${commit.stderr || commit.stdout}`);
  }

  await execaFn("git", ["push"], { stdio: "inherit" });
  return true;
}

export async function runReviewCommand(
  options: ReviewCommandOptions,
  execaFn: ExecaFn = execa,
): Promise<ReviewCommandResult> {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const reviewPolicyKey = buildReviewPolicyKey({
    autofix: options.autofix,
    autopush: options.autopush,
    publish: options.publish,
    strict: options.strict,
    maxAttempts,
  });

  const context = await resolveReviewRunContext(
    execaFn,
    options.issueOverride,
    options.branchOverride,
    options.baseBranchOverride,
  );

  if (!options.dryRun) {
    if (context.branch !== context.currentBranch) {
      throw new Error(
        `review: target branch '${context.branch}' is not checked out (current: '${context.currentBranch}'). Checkout the target branch or use --dry-run.`,
      );
    }
    const clean = await isWorkingTreeClean(execaFn);
    if (!clean) {
      throw new Error("review: working tree is not clean. Commit/stash changes or use --dry-run.");
    }
  }

  if (!options.dryRun && options.autopush && context.branch === "main") {
    throw new Error("review: autopush blocked on main branch.");
  }

  const executionPlan = await resolveReviewAgentExecutionPlan({
    execaFn,
    agentCmdOption: options.agentCmd,
    agentProviderOption: options.agentProvider,
  });
  if (!options.dryRun) {
    await persistReviewProviderSelection(executionPlan);
  }

  const issue = await fetchIssueSnapshot(execaFn, context.issueId);
  const repo = await resolveRepoNameWithOwner(execaFn);
  const pr = await resolveOrCreateReviewPullRequest({
    execaFn,
    issueId: context.issueId,
    issueTitle: issue.title,
    branch: context.branch,
    baseBranch: context.baseBranch,
    dryRun: options.dryRun,
  });

  if (!options.dryRun) {
    await ensureIssueReviewTemplates(context.issueId);
  }

  let finalOutput: ReviewAgentOutput | null = null;
  let attemptsUsed = 0;
  let resumeAttempted = false;
  let resumeFallback = false;
  let providerRunner: "command" | "codex" | "claude" | "gemini" =
    executionPlan.mode === "command" ? "command" : executionPlan.provider;
  let terminationReason: ReviewTerminationReason = "max-attempts";
  let previousFingerprintKey: string | null = null;
  const allFindingsByFingerprint = new Map<string, ReviewFinding>();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;

    const run = await runReviewAgent({
      execaFn,
      plan: executionPlan,
      input: {
        version: 1,
        workspace_root: process.cwd(),
        repo,
        issue: {
          id: context.issueId,
          title: issue.title,
          url: issue.url,
        },
        branch: context.branch,
        base_branch: context.baseBranch,
        pr: {
          number: pr.number,
          url: pr.url,
        },
        attempt,
        max_attempts: maxAttempts,
        autofix: options.autofix,
        passes: REVIEW_PASS_ORDER,
      },
    });

    const output = run.output;
    finalOutput = output;
    providerRunner = run.runner;
    resumeAttempted = resumeAttempted || run.resumeAttempted;
    resumeFallback = resumeFallback || run.resumeFallback;
    if (!options.dryRun) {
      for (const pass of output.passes) {
        await appendPassRunLog({
          issueId: context.issueId,
          attempt,
          maxAttempts,
          pass,
          runId: output.run_id,
          autofixApplied: output.autofix.applied,
          changedFiles: output.autofix.changed_files,
        });
      }
    }

    const findings = flattenReviewFindings(output);
    for (const finding of findings) {
      const fingerprint = computeFindingFingerprint(finding);
      if (!allFindingsByFingerprint.has(fingerprint)) {
        allFindingsByFingerprint.set(fingerprint, finding);
      }
    }
    if (!findings.length) {
      terminationReason = "completed";
      break;
    }

    if (attempt >= maxAttempts) {
      terminationReason = "max-attempts";
      break;
    }

    if (!options.autofix || !output.autofix.applied) {
      terminationReason = "no-autofix";
      break;
    }

    if (output.autofix.changed_files.length === 0) {
      terminationReason = "no-autofix-changes";
      break;
    }

    const currentFingerprintKey = buildFindingsFingerprintKey(findings);
    if (previousFingerprintKey !== null && currentFingerprintKey === previousFingerprintKey) {
      terminationReason = "same-fingerprints";
      break;
    }
    previousFingerprintKey = currentFingerprintKey;
  }

  if (!finalOutput) {
    throw new Error("review: agent did not return any output.");
  }

  const unresolvedFindings = dedupeFindingsByFingerprint(flattenReviewFindings(finalOutput));
  const allFindings = Array.from(allFindingsByFingerprint.values());
  const resolvedFindings = computeResolvedFindings(allFindings, unresolvedFindings);
  const currentRunSeverityTotals = summarizeSeverity(unresolvedFindings);
  const currentRunFindingTotals: ReviewFindingTotals = {
    observed: allFindings.length,
    unresolved: unresolvedFindings.length,
    resolved: resolvedFindings.length,
    source: "current-run",
    warning: null,
  };

  let followUp: FollowUpIssue | null = null;
  let closedFollowUpIssueNumbers: number[] = [];
  let followUpCloseWarnings: string[] = [];
  let threadResolution: ReviewThreadsResolveResult | null = null;
  let threadResolutionWarning: string | null = null;

  const previewSummary = buildOutcomeSummaryMarkdown({
    issueId: context.issueId,
    issueTitle: issue.title,
    prNumber: pr.number || null,
    attemptsUsed,
    maxAttempts,
    output: finalOutput,
    allFindings,
    resolvedFindings,
    unresolvedFindings,
    followUp: null,
    closedFollowUpIssueNumbers: [],
    followUpCloseWarnings: [],
    provider: providerRunner,
    providerSource: executionPlan.source,
    resumeAttempted,
    resumeFallback,
    providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
    terminationReason,
    findingTotals: currentRunFindingTotals,
    severityTotals: currentRunSeverityTotals,
  });

  if (unresolvedFindings.length > 0 && terminationReason === "max-attempts") {
    followUp = await createReviewFollowUpIssue({
      execaFn,
      sourceIssueId: context.issueId,
      sourceIssueTitle: issue.title,
      findings: unresolvedFindings,
      reviewSummary: previewSummary,
      milestoneTitle: issue.milestone,
      dryRun: options.dryRun,
      overrideLabel: options.followupLabel,
    });
  }
  if (unresolvedFindings.length === 0 && !options.dryRun) {
    const closeResult = await closeResolvedReviewFollowUpIssues({
      execaFn,
      sourceIssueId: context.issueId,
      runId: finalOutput.run_id,
    });
    closedFollowUpIssueNumbers = closeResult.closedIssueNumbers;
    followUpCloseWarnings = closeResult.warnings;
  }

  if (options.publish && !options.dryRun && unresolvedFindings.length === 0 && pr.number > 0) {
    try {
      threadResolution = await resolveReviewThreads(
        {
          prNumber: pr.number,
          threadIds: [],
          allUnresolved: true,
          bodyOverride: null,
          dryRun: false,
          vibeManagedOnly: true,
        },
        execaFn,
      );

      if (threadResolution.failed > 0) {
        threadResolutionWarning = `review: thread auto-resolve warning selected=${threadResolution.selectedThreads} resolved=${threadResolution.resolved} failed=${threadResolution.failed}.`;
      }
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      threadResolutionWarning = `review: thread auto-resolve warning ${message}`;
    }
  }

  let severityTotals = currentRunSeverityTotals;
  let findingTotals = currentRunFindingTotals;
  if (!options.dryRun && pr.number > 0) {
    try {
      const lifecycleTotals = await summarizeReviewThreadLifecycleTotals(
        {
          prNumber: pr.number,
          vibeManagedOnly: true,
        },
        execaFn,
      );

      const currentObservedFindingKeys = toFindingKeySet(allFindings);
      const currentUnresolvedFindingKeys = toFindingKeySet(unresolvedFindings);
      const currentResolvedFindingKeys = toFindingKeySet(resolvedFindings);
      const currentCanonicalFindingKeyMap = buildCanonicalFindingKeyMap(allFindings);
      const lifecycleUnresolvedEntries = mapLifecycleFindingEntries(
        lifecycleTotals.unresolvedFindingKeys,
        currentCanonicalFindingKeyMap,
      );
      const lifecycleUnresolvedFindingKeys = new Set(
        lifecycleUnresolvedEntries
          .map((entry) => entry.mappedKey)
          .filter((mappedKey): mappedKey is string => Boolean(mappedKey)),
      );
      const lifecycleResolvedFindingKeys = mapLifecycleFindingKeys(
        lifecycleTotals.resolvedFindingKeys,
        currentCanonicalFindingKeyMap,
      );

      const observedFindingKeys = new Set([
        ...currentObservedFindingKeys,
        ...lifecycleUnresolvedFindingKeys,
        ...lifecycleResolvedFindingKeys,
      ]);
      const unresolvedFindingKeys = new Set([...currentUnresolvedFindingKeys, ...lifecycleUnresolvedFindingKeys]);
      const resolvedFindingKeys = new Set([...currentResolvedFindingKeys, ...lifecycleResolvedFindingKeys]);
      for (const unresolvedFindingKey of unresolvedFindingKeys) {
        resolvedFindingKeys.delete(unresolvedFindingKey);
      }

      const observed = observedFindingKeys.size;
      const unresolved = unresolvedFindingKeys.size;
      const resolved = Math.max(resolvedFindingKeys.size, Math.max(0, observed - unresolved));
      findingTotals = {
        observed,
        unresolved,
        resolved,
        source: "lifecycle",
        warning: null,
      };

      const mergedSeverityTotals: SeverityCounts = { ...currentRunSeverityTotals };
      for (const lifecycleEntry of lifecycleUnresolvedEntries) {
        const mappedKey = lifecycleEntry.mappedKey;
        if (!mappedKey) continue;
        if (currentUnresolvedFindingKeys.has(mappedKey)) continue;
        const lifecycleSeverity = lifecycleTotals.unresolvedSeverityByFindingKey[lifecycleEntry.originalKey];
        if (lifecycleSeverity) {
          mergedSeverityTotals[lifecycleSeverity] += 1;
        }
      }
      severityTotals = mergedSeverityTotals;
    } catch (error) {
      findingTotals = {
        ...currentRunFindingTotals,
        warning: `lifecycle unavailable (${formatErrorMessage(error)}); using current-run totals`,
      };
      severityTotals = currentRunSeverityTotals;
    }
  }

  const summary = buildOutcomeSummaryMarkdown({
    issueId: context.issueId,
    issueTitle: issue.title,
    prNumber: pr.number || null,
    attemptsUsed,
    maxAttempts,
    output: finalOutput,
    allFindings,
    resolvedFindings,
    unresolvedFindings,
    followUp,
    closedFollowUpIssueNumbers,
    followUpCloseWarnings,
    provider: providerRunner,
    providerSource: executionPlan.source,
    resumeAttempted,
    resumeFallback,
    providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
    terminationReason,
    findingTotals,
    severityTotals,
  });

  if (!options.dryRun) {
    await appendReviewSummaryToPostflight({
      summary,
      issueId: context.issueId,
      branch: context.branch,
    });
  }

  let committed = false;
  if (!options.dryRun && options.autopush) {
    committed = await commitAndPushChanges(execaFn, finalOutput.run_id);
    const trackedChangesRemain = await hasTrackedWorkingTreeChanges(execaFn);
    if (trackedChangesRemain) {
      throw new Error("review: artifacts persistence incomplete (tracked changes remain after autopush).");
    }
  }

  let summaryHeadSha: string | null = null;
  try {
    summaryHeadSha = await resolveCurrentHeadSha(execaFn);
  } catch {
    summaryHeadSha = null;
  }

  if (options.publish) {
    await publishReviewToPullRequest({
      execaFn,
      repo,
      pr,
      summaryBody: buildReviewSummaryBody(summary, summaryHeadSha, { policyKey: reviewPolicyKey }),
      findings: unresolvedFindings,
      dryRun: options.dryRun,
    });
  }

  const exitCode = unresolvedFindings.length > 0 && options.strict ? REVIEW_UNRESOLVED_FINDINGS_EXIT_CODE : 0;

  return {
    exitCode,
    branch: context.branch,
    issueId: context.issueId,
    issueTitle: issue.title,
    prNumber: pr.number || null,
    attemptsUsed,
    unresolvedFindings,
    summary,
    followUp,
    runId: finalOutput.run_id,
    committed,
    provider: providerRunner,
    providerSource: executionPlan.source,
    resumeAttempted,
    resumeFallback,
    providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
    terminationReason,
    rationaleAutofilled: pr.rationaleAutofilled,
    threadResolution,
    threadResolutionWarning,
    findingTotalsSource: findingTotals.source,
    findingTotalsWarning: findingTotals.warning,
  };
}
