import { describe, expect, it } from "vitest";

import { flattenReviewFindings, ReviewAgentOutputSchema } from "../src/core/review-agent";

describe("review agent schema", () => {
  it("accepts valid output with all required passes", () => {
    const parsed = ReviewAgentOutputSchema.safeParse({
      version: 1,
      run_id: "run-1",
      passes: [
        { name: "implementation", summary: "ok", findings: [] },
        { name: "security", summary: "ok", findings: [] },
        { name: "quality", summary: "ok", findings: [] },
        { name: "ux", summary: "ok", findings: [] },
        { name: "ops", summary: "ok", findings: [] },
      ],
      autofix: {
        applied: true,
        summary: "done",
        changed_files: ["src/cli-program.ts"],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(flattenReviewFindings(parsed.data)).toEqual([]);
  });

  it("rejects output when pass set is incomplete", () => {
    const parsed = ReviewAgentOutputSchema.safeParse({
      version: 1,
      run_id: "run-2",
      passes: [
        { name: "implementation", summary: "ok", findings: [] },
        { name: "security", summary: "ok", findings: [] },
      ],
      autofix: {
        applied: false,
        changed_files: [],
      },
    });

    expect(parsed.success).toBe(false);
  });
});
