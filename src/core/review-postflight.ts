import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POSTFLIGHT_PATH = path.join(".vibe", "artifacts", "postflight.json");

type JsonRecord = Record<string, unknown>;

export type AppendReviewPostflightParams = {
  summary: string;
  issueId: number;
  branch: string;
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
