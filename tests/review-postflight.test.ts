import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendReviewSummaryToPostflight,
  createDefaultReviewPhaseTimings,
  upsertReviewPhaseTimingsInPostflight,
} from "../src/core/review-postflight";

describe.sequential("review postflight timing metrics", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let postflightPath = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-review-postflight-test-"));
    process.chdir(tempDir);
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    postflightPath = path.join(tempDir, ".vibe", "artifacts", "postflight.json");
    writeFileSync(postflightPath, JSON.stringify({ version: 1, tracker_updates: [] }, null, 2), "utf8");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stores null deltas on first persisted timing snapshot", async () => {
    const phaseTimings = createDefaultReviewPhaseTimings();
    phaseTimings.agent_invocation.elapsed_ms = 120;
    phaseTimings.agent_invocation.status = "completed";
    phaseTimings.agent_invocation.runs = 1;

    await appendReviewSummaryToPostflight({
      summary: "review summary",
      issueId: 91,
      branch: "codex/issue-91",
      phaseTimings,
      filePath: postflightPath,
    });

    const parsed = JSON.parse(readFileSync(postflightPath, "utf8")) as {
      review_metrics?: {
        phase_timings_delta_ms?: Record<string, number | null>;
      };
    };
    expect(parsed.review_metrics?.phase_timings_delta_ms?.agent_invocation).toBeNull();
  });

  it("caps timing history at 20 snapshots and tracks delta from previous snapshot", async () => {
    for (let i = 1; i <= 25; i += 1) {
      const phaseTimings = createDefaultReviewPhaseTimings();
      phaseTimings.agent_invocation.elapsed_ms = i;
      phaseTimings.agent_invocation.status = "completed";
      phaseTimings.agent_invocation.runs = 1;
      await upsertReviewPhaseTimingsInPostflight({
        issueId: 91,
        branch: "codex/issue-91",
        phaseTimings,
        filePath: postflightPath,
      });
    }

    const parsed = JSON.parse(readFileSync(postflightPath, "utf8")) as {
      review_metrics?: {
        phase_timings_delta_ms?: Record<string, number | null>;
        phase_timings_ms_history?: Array<{
          phase_timings_ms?: Record<string, { elapsed_ms?: number }>;
        }>;
      };
    };
    const history = parsed.review_metrics?.phase_timings_ms_history ?? [];
    expect(history).toHaveLength(20);
    expect(history[0]?.phase_timings_ms?.agent_invocation?.elapsed_ms).toBe(6);
    expect(history.at(-1)?.phase_timings_ms?.agent_invocation?.elapsed_ms).toBe(25);
    expect(parsed.review_metrics?.phase_timings_delta_ms?.agent_invocation).toBe(1);
  });
});
