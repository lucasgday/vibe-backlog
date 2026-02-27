import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POSTFLIGHT_PATH = path.join(".vibe", "artifacts", "postflight.json");

type JsonRecord = Record<string, unknown>;

export const REVIEW_PHASE_TIMING_KEYS = [
  "agent_invocation",
  "thread_auto_resolve",
  "lifecycle_finding_totals",
  "publish_review_artifacts",
  "pending_draft_cleanup_pre_thread_resolve",
  "pending_draft_cleanup_post_publish",
  "pending_draft_cleanup_total",
] as const;

export type ReviewPhaseTimingKey = (typeof REVIEW_PHASE_TIMING_KEYS)[number];
export type ReviewPhaseTimingStatus = "completed" | "failed" | "skipped";

export type ReviewPhaseTiming = {
  elapsed_ms: number;
  status: ReviewPhaseTimingStatus;
  runs: number;
  error: string | null;
};

export type ReviewPhaseTimings = Record<ReviewPhaseTimingKey, ReviewPhaseTiming>;

export function createDefaultReviewPhaseTimings(): ReviewPhaseTimings {
  const timings = {} as ReviewPhaseTimings;
  for (const key of REVIEW_PHASE_TIMING_KEYS) {
    timings[key] = {
      elapsed_ms: 0,
      status: "skipped",
      runs: 0,
      error: null,
    };
  }
  return timings;
}

export type AppendReviewPostflightParams = {
  summary: string;
  issueId: number;
  branch: string;
  phaseTimings?: ReviewPhaseTimings;
  filePath?: string;
};

export async function appendReviewSummaryToPostflight(params: AppendReviewPostflightParams): Promise<string> {
  const filePath = path.resolve(process.cwd(), params.filePath ?? DEFAULT_POSTFLIGHT_PATH);
  const raw = await readFile(filePath, "utf8");

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("postflight artifact must be a JSON object");
  }

  const root = parsed as JsonRecord;

  const workRaw = typeof root.work === "object" && root.work !== null ? (root.work as JsonRecord) : {};
  if (workRaw.issue_id === undefined || workRaw.issue_id === null || workRaw.issue_id === "") {
    workRaw.issue_id = params.issueId;
  }
  if (typeof workRaw.branch !== "string" || !workRaw.branch.trim()) {
    workRaw.branch = params.branch;
  }
  root.work = workRaw;

  if (params.phaseTimings) {
    const reviewMetricsRaw =
      typeof root.review_metrics === "object" && root.review_metrics !== null && !Array.isArray(root.review_metrics)
        ? (root.review_metrics as JsonRecord)
        : {};
    reviewMetricsRaw.phase_timings_ms = params.phaseTimings;
    root.review_metrics = reviewMetricsRaw;
  }

  const trackerUpdatesRaw = root.tracker_updates;
  const trackerUpdates = Array.isArray(trackerUpdatesRaw) ? trackerUpdatesRaw.slice() : [];
  trackerUpdates.push({
    type: "comment_append",
    body: params.summary,
  });
  root.tracker_updates = trackerUpdates;

  await writeFile(filePath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return filePath;
}
