import { describe, expect, it } from "vitest";

import { flattenReviewFindings, REVIEW_PASS_ORDER, ReviewAgentOutputSchema, runReviewAgent } from "../src/core/review-agent";

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

  it("parses valid review JSON even with noisy command output", async () => {
    const validOutput = {
      version: 1,
      run_id: "run-noisy",
      passes: [
        { name: "implementation", summary: "ok", findings: [] },
        { name: "security", summary: "ok", findings: [] },
        { name: "quality", summary: "ok", findings: [] },
        { name: "ux", summary: "ok", findings: [] },
        { name: "ops", summary: "ok", findings: [] },
      ],
      autofix: {
        applied: false,
        changed_files: [],
      },
    };

    const execaMock = async () => ({
      stdout: `INFO starting run\\n${JSON.stringify(validOutput)}\\nINFO done`,
    });

    const result = await runReviewAgent({
      execaFn: execaMock as never,
      plan: {
        mode: "command",
        provider: "command",
        source: "flag",
        command: "cat",
        runtimePath: "/tmp/review-provider.json",
        autoMode: false,
        resumeThreadId: null,
        healedFromRuntime: null,
      },
      input: {
        version: 1,
        workspace_root: "/tmp/repo",
        repo: "acme/demo",
        issue: {
          id: 34,
          title: "review command",
          url: null,
        },
        branch: "codex/issue-34-vibe-review",
        base_branch: "main",
        pr: {
          number: 99,
          url: null,
        },
        attempt: 1,
        max_attempts: 5,
        autofix: true,
        passes: REVIEW_PASS_ORDER,
      },
    });

    expect(result.output.run_id).toBe("run-noisy");
    expect(result.runner).toBe("command");
  });
});
