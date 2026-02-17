import { describe, expect, it, vi } from "vitest";

import { runPrOpenCommand } from "../src/core/pr-open";

describe("pr open core", () => {
  it("returns created=false on dry-run when no open PR exists", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrOpenCommand(
      {
        issueOverride: "6",
        branchOverride: "feature/custom",
        baseBranchOverride: "main",
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(false);
    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBeNull();
    expect(result.body).toContain("Fixes #6");
    expect(result.body).not.toContain("TODO:");
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("preserves dry-run flag when reusing an open PR", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 63,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/63",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrOpenCommand(
      {
        issueOverride: "6",
        branchOverride: "feature/custom",
        baseBranchOverride: "main",
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(false);
    expect(result.prNumber).toBe(63);
    expect(result.prUrl).toBe("https://example.test/pull/63");
  });
});
