import { execa } from "execa";
import { z } from "zod";

type ExecaFn = typeof execa;

export const REVIEW_PASS_ORDER = ["implementation", "security", "quality", "ux", "ops"] as const;
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
};

export type RunReviewAgentParams = {
  execaFn: ExecaFn;
  command: string;
  input: ReviewAgentInput;
};

export async function runReviewAgent(params: RunReviewAgentParams): Promise<ReviewAgentOutput> {
  const command = params.command.trim();
  if (!command) {
    throw new Error("review agent command is required");
  }

  const response = await params.execaFn("zsh", ["-lc", command], {
    stdio: "pipe",
    input: `${JSON.stringify(params.input)}\n`,
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.stdout);
  } catch (error) {
    throw new Error(`review agent output is not valid JSON: ${String(error)}`);
  }

  const parsed = ReviewAgentOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`review agent output schema mismatch: ${parsed.error.message}`);
  }

  return parsed.data;
}

export function flattenReviewFindings(output: ReviewAgentOutput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const pass of output.passes) {
    findings.push(...pass.findings);
  }
  return findings;
}
