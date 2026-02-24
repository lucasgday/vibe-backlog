import { REVIEW_PASS_ORDER, type ReviewPassName } from "./review-agent";

export const REVIEW_COMPUTE_CLASS_VALUES = ["L1-fast", "L2-standard", "L3-deep", "L4-critical"] as const;
export type ReviewComputeClass = (typeof REVIEW_COMPUTE_CLASS_VALUES)[number];

export const REVIEW_PASS_PROFILE_VALUES = ["full", "docs-only"] as const;
export type ReviewPassProfile = (typeof REVIEW_PASS_PROFILE_VALUES)[number];

export type ReviewFlowKind = "review" | "pr-open-gate";

export type ResolvedReviewExecutionPolicy = {
  flow: ReviewFlowKind;
  computeClass: ReviewComputeClass;
  passProfile: ReviewPassProfile;
  activePasses: readonly ReviewPassName[];
  skippedPasses: readonly ReviewPassName[];
  agentInvocationRetryBudget: number;
};

type ResolveReviewExecutionPolicyParams = {
  flow: ReviewFlowKind;
  computeClassOverride?: string | null;
  issueTitle: string;
  issueLabels: string[];
};

function normalizeClassToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeReviewComputeClass(value: string | null | undefined): ReviewComputeClass | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const normalized = normalizeClassToken(raw);
  if (normalized === "l1-fast") return "L1-fast";
  if (normalized === "l2-standard") return "L2-standard";
  if (normalized === "l3-deep") return "L3-deep";
  if (normalized === "l4-critical") return "L4-critical";
  return null;
}

export function defaultReviewComputeClass(flow: ReviewFlowKind): ReviewComputeClass {
  return flow === "pr-open-gate" ? "L2-standard" : "L3-deep";
}

export function reviewAgentInvocationRetryBudgetForClass(computeClass: ReviewComputeClass): number {
  if (computeClass === "L1-fast") return 1;
  if (computeClass === "L2-standard") return 2;
  if (computeClass === "L3-deep") return 3;
  return 4;
}

function normalizeLabels(labels: string[]): string[] {
  return labels
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function moduleLabels(labels: string[]): string[] {
  return normalizeLabels(labels).filter((label) => label.startsWith("module:"));
}

function hasDocsOnlyModuleSignal(labels: string[]): boolean {
  const modules = moduleLabels(labels);
  if (modules.length === 0) return false;
  return modules.every((label) => label === "module:docs");
}

function titleStartsWithDocs(title: string): boolean {
  return title.trim().toLowerCase().startsWith("docs:");
}

function hasUiModuleLabel(labels: string[]): boolean {
  return moduleLabels(labels).includes("module:ui");
}

export function resolveReviewPassProfile(params: {
  computeClass: ReviewComputeClass;
  issueTitle: string;
  issueLabels: string[];
}): ReviewPassProfile {
  if (params.computeClass === "L4-critical") return "full";
  if (hasDocsOnlyModuleSignal(params.issueLabels)) return "docs-only";
  if (titleStartsWithDocs(params.issueTitle) && !hasUiModuleLabel(params.issueLabels)) return "docs-only";
  return "full";
}

export function resolveReviewPassSelection(passProfile: ReviewPassProfile): {
  activePasses: readonly ReviewPassName[];
  skippedPasses: readonly ReviewPassName[];
} {
  if (passProfile !== "docs-only") {
    return {
      activePasses: REVIEW_PASS_ORDER,
      skippedPasses: [],
    };
  }

  const skipped = new Set<ReviewPassName>(["ux", "growth"]);
  const active = REVIEW_PASS_ORDER.filter((pass) => !skipped.has(pass));
  return {
    activePasses: active,
    skippedPasses: REVIEW_PASS_ORDER.filter((pass) => skipped.has(pass)),
  };
}

export function resolveReviewExecutionPolicy(params: ResolveReviewExecutionPolicyParams): ResolvedReviewExecutionPolicy {
  const computeClass = normalizeReviewComputeClass(params.computeClassOverride) ?? defaultReviewComputeClass(params.flow);
  const passProfile = resolveReviewPassProfile({
    computeClass,
    issueTitle: params.issueTitle,
    issueLabels: params.issueLabels,
  });
  const passSelection = resolveReviewPassSelection(passProfile);

  return {
    flow: params.flow,
    computeClass,
    passProfile,
    activePasses: passSelection.activePasses,
    skippedPasses: passSelection.skippedPasses,
    agentInvocationRetryBudget: reviewAgentInvocationRetryBudgetForClass(computeClass),
  };
}
