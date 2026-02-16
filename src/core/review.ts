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
  createReviewFollowUpIssue,
  fetchIssueSnapshot,
  publishReviewToPullRequest,
  resolveOrCreateReviewPullRequest,
  resolveRepoNameWithOwner,
  type FollowUpIssue,
} from "./review-pr";
import { appendReviewSummaryToPostflight } from "./review-postflight";
import { ensureIssueReviewTemplates, getIssueReviewDirectory } from "./reviews";
import { readTurnContext, validateTurnContext } from "./turn";

export const REVIEW_NO_ACTIVE_TURN_EXIT_CODE = 2;
export const REVIEW_INVALID_TURN_EXIT_CODE = 3;
export const REVIEW_UNRESOLVED_FINDINGS_EXIT_CODE = 4;
export const REVIEW_REMEDIATION = "Run: node dist/cli.cjs turn start --issue <n>";
type ExecaFn = typeof execa;

export type ReviewCommandOptions = {
  issueOverride?: string | number | null;
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
};

type ReviewRunContext = {
  issueId: number;
  branch: string;
  baseBranch: string;
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
  if (!branch) {
    throw new Error("review: unable to resolve current git branch");
  }
  return branch;
}

async function isWorkingTreeClean(execaFn: ExecaFn): Promise<boolean> {
  const response = await execaFn("git", ["status", "--porcelain"], { stdio: "pipe" });
  return response.stdout.trim() === "";
}

async function resolveReviewRunContext(execaFn: ExecaFn, issueOverride: string | number | null | undefined): Promise<ReviewRunContext> {
  let activeTurn;
  try {
    activeTurn = await readTurnContext();
  } catch (error) {
    if (error instanceof SyntaxError) {
      const invalid = new Error("review: invalid active turn (malformed turn.json).");
      (invalid as Error & { code?: number }).code = REVIEW_INVALID_TURN_EXIT_CODE;
      throw invalid;
    }
    throw error;
  }

  if (!activeTurn) {
    const noTurn = new Error("review: no active turn.");
    (noTurn as Error & { code?: number }).code = REVIEW_NO_ACTIVE_TURN_EXIT_CODE;
    throw noTurn;
  }

  const turnErrors = validateTurnContext(activeTurn);
  if (turnErrors.length) {
    const invalid = new Error(`review: invalid active turn (missing/invalid: ${turnErrors.join(", ")}).`);
    (invalid as Error & { code?: number }).code = REVIEW_INVALID_TURN_EXIT_CODE;
    throw invalid;
  }

  const overrideProvided = issueOverride !== undefined && issueOverride !== null && String(issueOverride).trim() !== "";
  const parsedOverride = parseIssueIdOverride(issueOverride);
  if (overrideProvided && parsedOverride === null) {
    throw new Error("review: --issue debe ser un entero positivo.");
  }

  const issueId = parsedOverride ?? activeTurn.issue_id;
  if (!Number.isSafeInteger(issueId) || issueId <= 0) {
    throw new Error("review: --issue debe ser un entero positivo.");
  }

  const branch = await resolveCurrentBranch(execaFn);
  return {
    issueId,
    branch,
    baseBranch: activeTurn.base_branch,
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

  const context = await resolveReviewRunContext(execaFn, options.issueOverride);

  if (!options.dryRun) {
    const clean = await isWorkingTreeClean(execaFn);
    if (!clean) {
      throw new Error("review: working tree is not clean. Commit/stash changes or use --dry-run.");
    }
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

  await ensureIssueReviewTemplates(context.issueId);

  let finalOutput: ReviewAgentOutput | null = null;
  let attemptsUsed = 0;
  let resumeAttempted = false;
  let resumeFallback = false;
  let providerRunner: "command" | "codex" | "claude" | "gemini" =
    executionPlan.mode === "command" ? "command" : executionPlan.provider;

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

    const findings = flattenReviewFindings(output);
    if (!findings.length) {
      break;
    }
  }

  if (!finalOutput) {
    throw new Error("review: agent did not return any output.");
  }

  const unresolvedFindings = flattenReviewFindings(finalOutput);
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
  });

  if (unresolvedFindings.length > 0) {
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
  });

  let committed = false;
  if (!options.dryRun && options.autopush) {
    if (context.branch === "main") {
      throw new Error("review: autopush blocked on main branch.");
    }
    committed = await commitAndPushChanges(execaFn, finalOutput.run_id);
  }

  if (options.publish) {
    await publishReviewToPullRequest({
      execaFn,
      repo,
      pr,
      summaryBody: buildReviewSummaryBody(summary),
      findings: unresolvedFindings,
      dryRun: options.dryRun,
    });
  }

  if (!options.dryRun) {
    await appendReviewSummaryToPostflight({
      summary,
      issueId: context.issueId,
      branch: context.branch,
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
  };
}
