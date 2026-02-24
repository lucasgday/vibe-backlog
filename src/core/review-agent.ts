import { execa } from "execa";
import { z } from "zod";
import type { ReviewAgentExecutionPlan } from "./review-provider";

type ExecaFn = typeof execa;

export const REVIEW_PASS_ORDER = ["implementation", "security", "quality", "ux", "growth", "ops"] as const;
export type ReviewPassName = (typeof REVIEW_PASS_ORDER)[number];

export const ReviewSeveritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewFindingKindSchema = z.enum([
  "defect",
  "regression",
  "security",
  "improvement",
  "docs",
  "refactor",
  "test",
]);
export type ReviewFindingKind = z.infer<typeof ReviewFindingKindSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  pass: z.enum(REVIEW_PASS_ORDER),
  severity: ReviewSeveritySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  file: z.string().min(1).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  kind: ReviewFindingKindSchema.nullable().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewPassResultSchema = z.object({
  name: z.enum(REVIEW_PASS_ORDER),
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
});
export type ReviewPassResult = z.infer<typeof ReviewPassResultSchema>;

export const ReviewAutofixSchema = z.object({
  applied: z.boolean(),
  summary: z.string().nullable().optional(),
  changed_files: z.array(z.string().min(1)).default([]),
});
export type ReviewAutofix = z.infer<typeof ReviewAutofixSchema>;

function hasAllPassesOnce(passes: ReviewPassResult[]): boolean {
  if (passes.length !== REVIEW_PASS_ORDER.length) return false;
  const names = new Set(passes.map((pass) => pass.name));
  return REVIEW_PASS_ORDER.every((name) => names.has(name));
}

export const ReviewAgentOutputSchema = z
  .object({
    version: z.literal(1),
    run_id: z.string().min(1),
    passes: z.array(ReviewPassResultSchema),
    autofix: ReviewAutofixSchema,
  })
  .superRefine((value, ctx) => {
    if (!hasAllPassesOnce(value.passes)) {
      ctx.addIssue({
        code: "custom",
        message: `passes must include exactly once: ${REVIEW_PASS_ORDER.join(", ")}`,
        path: ["passes"],
      });
    }
  });
export type ReviewAgentOutput = z.infer<typeof ReviewAgentOutputSchema>;

export type ReviewAgentInput = {
  version: 1;
  workspace_root: string;
  repo: string;
  issue: {
    id: number;
    title: string;
    url: string | null;
  };
  branch: string;
  base_branch: string;
  pr: {
    number: number;
    url: string | null;
  };
  attempt: number;
  max_attempts: number;
  autofix: boolean;
  passes: readonly ReviewPassName[];
  review_policy?: {
    compute_class: string;
    pass_profile: string;
    active_passes: readonly ReviewPassName[];
    skipped_passes: readonly ReviewPassName[];
    agent_invocation_retry_budget: number;
  };
};

export type RunReviewAgentParams = {
  execaFn: ExecaFn;
  plan: ReviewAgentExecutionPlan;
  input: ReviewAgentInput;
  invocationRetry?: {
    maxInvocations: number;
  };
};

export type RunReviewAgentResult = {
  output: ReviewAgentOutput;
  resumeAttempted: boolean;
  resumeFallback: boolean;
  runner: "command" | "codex" | "claude" | "gemini";
};

type ProviderExecutionPlan = Exclude<ReviewAgentExecutionPlan, { mode: "command" }>;
type CodexExecutionPlan = ProviderExecutionPlan & { provider: "codex" };
type ClaudeOrGeminiExecutionPlan = ProviderExecutionPlan & { provider: "claude" | "gemini" };

function buildProviderPrompt(input: ReviewAgentInput): string {
  const passEnum = REVIEW_PASS_ORDER.join("|");
  const activePassList = input.review_policy?.active_passes?.join(", ") || REVIEW_PASS_ORDER.join(", ");
  const skippedPassList = input.review_policy?.skipped_passes?.join(", ") || "none";
  const instructions = [
    "You are a code review pass runner.",
    "Pass guidance:",
    "- implementation/security/quality/ops: keep findings concrete and tied to changed behavior.",
    "- ux: act as a Senior Product Designer + Design Systems reviewer. Prioritize system consistency over subjective aesthetics.",
    "- ux: focus on spacing, typography, hierarchy, iconography/illustration consistency, states, and accessibility.",
    "- ux: propose actionable fixes with concrete values/tokens when applicable (px, spacing tokens, type sizes, radius, target sizes).",
    "- ux: if UI context is partial, state assumptions explicitly (for example: 8pt grid, 16px body type, 44px minimum targets).",
    "- growth: identify product growth opportunities (activation, retention, conversion, instrumentation, experiment gaps) grounded in evidence from the diff/context.",
    "- growth: each finding should include a concrete next action suitable for a follow-up issue.",
    "- Treat `.vibe/reviews/<issue>/*.md` and `.vibe/artifacts/postflight.json` as expected review artifacts; do not flag them as unplanned/unexpected by themselves.",
    `- Active passes for this run (policy): ${activePassList}.`,
    `- Skipped passes for this run (policy): ${skippedPassList}.`,
    "- Output MUST still include all 6 passes exactly once.",
    '- For any pass skipped by policy, return summary="skipped by policy" and findings=[].',
    "- keep severities strictly in P0|P1|P2|P3.",
    "Return ONLY a JSON object (no markdown) matching this schema:",
    `{"version":1,"run_id":"string","passes":[{"name":"${passEnum}","summary":"string","findings":[{"id":"string","pass":"${passEnum}","severity":"P0|P1|P2|P3","title":"string","body":"string","file":"string|null","line":1,"kind":"defect|regression|security|improvement|docs|refactor|test|null"}]}],"autofix":{"applied":true,"summary":"string|null","changed_files":["string"]}}`,
    "",
    "Review context JSON:",
    JSON.stringify(input, null, 2),
  ];
  return instructions.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const execaError = error as Error & {
    stderr?: unknown;
    stdout?: unknown;
    shortMessage?: unknown;
    message?: unknown;
  };
  const parts: string[] = [];
  if (typeof execaError.message === "string" && execaError.message.trim()) parts.push(execaError.message);
  if (typeof execaError.shortMessage === "string" && execaError.shortMessage.trim()) parts.push(execaError.shortMessage);
  if (typeof execaError.stderr === "string" && execaError.stderr.trim()) parts.push(execaError.stderr);
  if (typeof execaError.stdout === "string" && execaError.stdout.trim()) parts.push(execaError.stdout);
  return parts.join("\n");
}

function isRetryableReviewAgentInvocationError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  if (!text) return false;
  return (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("connection reset") ||
    text.includes("temporary failure") ||
    text.includes("temporarily unavailable") ||
    text.includes("rate limit") ||
    /\b429\b/.test(text) ||
    /\b502\b/.test(text) ||
    /\b503\b/.test(text) ||
    /\b504\b/.test(text)
  );
}

async function runWithInvocationRetry<T>(
  fn: () => Promise<T>,
  policy?: { maxInvocations: number },
): Promise<T> {
  const maxInvocations = Math.max(1, Math.trunc(policy?.maxInvocations ?? 1));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxInvocations; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxInvocations && isRetryableReviewAgentInvocationError(error);
      if (!canRetry) {
        throw error;
      }
      const delayMs = Math.min(250 * attempt, 750);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("review agent invocation failed");
}

function parseJsonCandidate(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectJsonCandidates(raw: string): unknown[] {
  const candidates: unknown[] = [];
  const whole = parseJsonCandidate(raw);
  if (whole !== null) {
    candidates.push(whole);
  }

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseJsonCandidate(line);
    if (parsed !== null) {
      candidates.push(parsed);
    }
  }

  const codeBlockRegex = /```json\s*([\s\S]*?)```/gi;
  let blockMatch: RegExpExecArray | null = codeBlockRegex.exec(raw);
  while (blockMatch) {
    const parsed = parseJsonCandidate(blockMatch[1] ?? "");
    if (parsed !== null) {
      candidates.push(parsed);
    }
    blockMatch = codeBlockRegex.exec(raw);
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const objectChunk = raw.slice(firstBrace, lastBrace + 1);
    const parsed = parseJsonCandidate(objectChunk);
    if (parsed !== null) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function collectNestedValues(value: unknown): unknown[] {
  const nested: unknown[] = [];
  if (typeof value === "string") {
    const parsed = parseJsonCandidate(value);
    if (parsed !== null) {
      nested.push(parsed);
    }
    return nested;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      nested.push(entry, ...collectNestedValues(entry));
    }
    return nested;
  }

  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      nested.push(entry, ...collectNestedValues(entry));
    }
  }
  return nested;
}

function parseReviewAgentOutputFromText(raw: string): ReviewAgentOutput {
  const candidates = collectJsonCandidates(raw);
  for (const candidate of candidates) {
    const direct = ReviewAgentOutputSchema.safeParse(candidate);
    if (direct.success) {
      return direct.data;
    }

    for (const nested of collectNestedValues(candidate)) {
      const parsed = ReviewAgentOutputSchema.safeParse(nested);
      if (parsed.success) {
        return parsed.data;
      }
    }
  }

  const snippet = raw.trim().slice(0, 500);
  throw new Error(`review agent output schema mismatch. Sample output: ${snippet}`);
}

async function runShellCommand(execaFn: ExecaFn, command: string, input: string): Promise<string> {
  const response = await execaFn("zsh", ["-lc", command], {
    stdio: "pipe",
    input,
  });
  return response.stdout;
}

async function runCodexProvider(params: {
  execaFn: ExecaFn;
  plan: CodexExecutionPlan;
  prompt: string;
}): Promise<{ stdout: string; resumeAttempted: boolean; resumeFallback: boolean }> {
  const { execaFn, plan, prompt } = params;

  if (plan.providerCommandOverride) {
    const stdout = await runShellCommand(execaFn, plan.providerCommandOverride, prompt);
    return {
      stdout,
      resumeAttempted: false,
      resumeFallback: false,
    };
  }

  const binary = plan.providerBinary ?? "codex";

  if (plan.resumeThreadId) {
    const resumed = await execaFn(binary, ["exec", "resume", plan.resumeThreadId, "-"], {
      stdio: "pipe",
      input: prompt,
      reject: false,
    });

    const resumedExitCode = typeof resumed.exitCode === "number" ? resumed.exitCode : 1;
    if (resumedExitCode === 0) {
      try {
        parseReviewAgentOutputFromText(resumed.stdout);
        return {
          stdout: resumed.stdout,
          resumeAttempted: true,
          resumeFallback: false,
        };
      } catch {
        // Fall through to regular codex execution.
      }
    }

    const fallback = await execaFn(binary, ["exec", "--skip-git-repo-check", "-"], {
      stdio: "pipe",
      input: prompt,
    });
    return {
      stdout: fallback.stdout,
      resumeAttempted: true,
      resumeFallback: true,
    };
  }

  const standard = await execaFn(binary, ["exec", "--skip-git-repo-check", "-"], {
    stdio: "pipe",
    input: prompt,
  });
  return {
    stdout: standard.stdout,
    resumeAttempted: false,
    resumeFallback: false,
  };
}

async function runClaudeOrGeminiProvider(params: {
  execaFn: ExecaFn;
  plan: ClaudeOrGeminiExecutionPlan;
  prompt: string;
}): Promise<string> {
  const { execaFn, plan, prompt } = params;
  if (plan.providerCommandOverride) {
    return runShellCommand(execaFn, plan.providerCommandOverride, prompt);
  }

  const binary = plan.providerBinary ?? plan.provider;
  const response = await execaFn(binary, ["-p", prompt], { stdio: "pipe" });
  return response.stdout;
}

export async function runReviewAgent(params: RunReviewAgentParams): Promise<RunReviewAgentResult> {
  if (params.plan.mode === "command") {
    const command = params.plan.command.trim();
    if (!command) {
      throw new Error("review agent command is required");
    }
    const stdout = await runWithInvocationRetry(
      () => runShellCommand(params.execaFn, command, `${JSON.stringify(params.input)}\n`),
      params.invocationRetry,
    );
    return {
      output: parseReviewAgentOutputFromText(stdout),
      resumeAttempted: false,
      resumeFallback: false,
      runner: "command",
    };
  }

  const prompt = buildProviderPrompt(params.input);
  if (params.plan.provider === "codex") {
    const result = await runWithInvocationRetry(
      () =>
        runCodexProvider({
          execaFn: params.execaFn,
          plan: params.plan as CodexExecutionPlan,
          prompt,
        }),
      params.invocationRetry,
    );
    return {
      output: parseReviewAgentOutputFromText(result.stdout),
      resumeAttempted: result.resumeAttempted,
      resumeFallback: result.resumeFallback,
      runner: "codex",
    };
  }

  if (params.plan.provider === "claude" || params.plan.provider === "gemini") {
    const stdout = await runWithInvocationRetry(
      () =>
        runClaudeOrGeminiProvider({
          execaFn: params.execaFn,
          plan: params.plan as ClaudeOrGeminiExecutionPlan,
          prompt,
        }),
      params.invocationRetry,
    );
    return {
      output: parseReviewAgentOutputFromText(stdout),
      resumeAttempted: false,
      resumeFallback: false,
      runner: params.plan.provider,
    };
  }

  throw new Error(`review agent provider not implemented: ${String((params.plan as { provider?: unknown }).provider)}`);
}

export function flattenReviewFindings(output: ReviewAgentOutput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const pass of output.passes) {
    findings.push(...pass.findings);
  }
  return findings;
}
