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
  computeFindingFingerprint,
  createReviewFollowUpIssue,
  fetchIssueSnapshot,
  publishReviewToPullRequest,
  resolveOrCreateReviewPullRequest,
  resolveRepoNameWithOwner,
  type FollowUpIssue,
} from "./review-pr";
import { appendReviewSummaryToPostflight } from "./review-postflight";
import { resolveReviewThreads, type ReviewThreadsResolveResult } from "./review-threads";
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

function summarizeSeverity(findings: ReviewFinding[]): Record<"P0" | "P1" | "P2" | "P3", number> {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

function formatPassResult(pass: ReviewPassResult): string {
  return `- ${pass.name}: ${pass.findings.length} finding(s)`;
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

function selectFollowUpFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const growthFindings = findings.filter((finding) => finding.pass === "growth");
  if (growthFindings.length === 0) {
    return findings;
  }

  const highSeverityNonGrowth = findings.filter(
    (finding) => finding.pass !== "growth" && (finding.severity === "P0" || finding.severity === "P1"),
  );
  return [...growthFindings, ...highSeverityNonGrowth];
}

function formatTermination(terminationReason: ReviewTerminationReason): string {
  if (terminationReason === "completed" || terminationReason === "max-attempts") {
    return terminationReason;
  }
  return `early-stop (reason=${terminationReason})`;
}

function buildOutcomeSummaryMarkdown(params: {
  issueId: number;
  issueTitle: string;
  prNumber: number | null;
  attemptsUsed: number;
  maxAttempts: number;
  output: ReviewAgentOutput;
  unresolvedFindings: ReviewFinding[];
  followUp: FollowUpIssue | null;
  provider: "command" | "codex" | "claude" | "gemini";
  providerSource: "flag" | "env" | "runtime" | "host" | "bin";
  resumeAttempted: boolean;
  resumeFallback: boolean;
  providerHealedFromRuntime: "codex" | "claude" | "gemini" | null;
  terminationReason: ReviewTerminationReason;
}): string {
  const severity = summarizeSeverity(params.unresolvedFindings);
  const lines = [
    "## vibe review",
    `- Issue: #${params.issueId} ${params.issueTitle}`,
    `- PR: ${params.prNumber ? `#${params.prNumber}` : "-"}`,
    `- Agent provider: ${params.provider} (source: ${params.providerSource})`,
    `- Resume: attempted=${params.resumeAttempted ? "yes" : "no"}, fallback=${params.resumeFallback ? "yes" : "no"}`,
    `- Run ID: ${params.output.run_id}`,
    `- Attempts: ${params.attemptsUsed}/${params.maxAttempts}`,
    `- Termination: ${formatTermination(params.terminationReason)}`,
    `- Unresolved findings: ${params.unresolvedFindings.length}`,
    `- Severity: P0=${severity.P0}, P1=${severity.P1}, P2=${severity.P2}, P3=${severity.P3}`,
  ];
  if (params.providerHealedFromRuntime) {
    lines.push(`- Provider auto-heal: ${params.providerHealedFromRuntime} -> ${params.provider}`);
  }

  if (params.followUp?.url) {
    lines.push(`- Follow-up issue: ${params.followUp.url} (${params.followUp.label})`);
  } else if (params.followUp && !params.followUp.created) {
    lines.push(`- Follow-up issue: dry-run (${params.followUp.label})`);
  }

  lines.push("", "### Pass Results");
  for (const pass of params.output.passes) {
    lines.push(formatPassResult(pass));
  }

  if (params.unresolvedFindings.length) {
    lines.push("", "### Unresolved Findings");
    for (const finding of params.unresolvedFindings) {
      lines.push(formatFindingLine(finding));
    }
  } else {
    lines.push("", "### Unresolved Findings", "- none");
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

  const unresolvedFindings = flattenReviewFindings(finalOutput);
  const followUpFindings = selectFollowUpFindings(unresolvedFindings);
  let followUp: FollowUpIssue | null = null;

  const previewSummary = buildOutcomeSummaryMarkdown({
    issueId: context.issueId,
    issueTitle: issue.title,
    prNumber: pr.number || null,
    attemptsUsed,
    maxAttempts,
    output: finalOutput,
    unresolvedFindings,
    followUp: null,
    provider: providerRunner,
    providerSource: executionPlan.source,
    resumeAttempted,
    resumeFallback,
    providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
    terminationReason,
  });

  const followUpPreviewSummary =
    followUpFindings === unresolvedFindings
      ? previewSummary
      : buildOutcomeSummaryMarkdown({
          issueId: context.issueId,
          issueTitle: issue.title,
          prNumber: pr.number || null,
          attemptsUsed,
          maxAttempts,
          output: finalOutput,
          unresolvedFindings: followUpFindings,
          followUp: null,
          provider: providerRunner,
          providerSource: executionPlan.source,
          resumeAttempted,
          resumeFallback,
          providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
          terminationReason,
        });

  if (unresolvedFindings.length > 0 && terminationReason === "max-attempts") {
    followUp = await createReviewFollowUpIssue({
      execaFn,
      sourceIssueId: context.issueId,
      sourceIssueTitle: issue.title,
      findings: followUpFindings,
      reviewSummary: followUpPreviewSummary,
      milestoneTitle: issue.milestone,
      dryRun: options.dryRun,
      overrideLabel: options.followupLabel,
    });
  }

  const summary = buildOutcomeSummaryMarkdown({
    issueId: context.issueId,
    issueTitle: issue.title,
    prNumber: pr.number || null,
    attemptsUsed,
    maxAttempts,
    output: finalOutput,
    unresolvedFindings,
    followUp,
    provider: providerRunner,
    providerSource: executionPlan.source,
    resumeAttempted,
    resumeFallback,
    providerHealedFromRuntime: executionPlan.mode === "provider" ? executionPlan.healedFromRuntime : null,
    terminationReason,
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

  let threadResolution: ReviewThreadsResolveResult | null = null;
  let threadResolutionWarning: string | null = null;
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
  };
}
