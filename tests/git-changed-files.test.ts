import { describe, expect, it, vi } from "vitest";

import { listChangedFilesForRationale } from "../src/core/git-changed-files";

describe("listChangedFilesForRationale", () => {
  it("prefers origin base ref over local base ref when both exist", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("git");

      if (args.join(" ") === "rev-parse --verify --quiet origin/main") return { stdout: "base-remote-sha\n" };
      if (args.join(" ") === "rev-parse --verify --quiet issue-83-dynamic-pr-rationale") return { stdout: "head-sha\n" };
      if (args.join(" ") === "diff --name-only origin/main...issue-83-dynamic-pr-rationale") {
        return { stdout: "src/core/pr-rationale.ts\ntests/pr-rationale.test.ts\n" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const files = await listChangedFilesForRationale(execaMock as never, {
      baseBranch: "main",
      branch: "issue-83-dynamic-pr-rationale",
    });

    expect(files).toEqual(["src/core/pr-rationale.ts", "tests/pr-rationale.test.ts"]);
    expect(
      execaMock.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.join(" ") === "rev-parse --verify --quiet main",
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) => Array.isArray(args) && args.join(" ") === "diff --name-only main...issue-83-dynamic-pr-rationale"),
    ).toBe(false);
  });

  it("falls back to local base ref when origin base ref is unavailable", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("git");

      if (args.join(" ") === "rev-parse --verify --quiet origin/main") throw new Error("missing ref");
      if (args.join(" ") === "rev-parse --verify --quiet main") return { stdout: "base-local-sha\n" };
      if (args.join(" ") === "rev-parse --verify --quiet issue-83-dynamic-pr-rationale") return { stdout: "head-sha\n" };
      if (args.join(" ") === "diff --name-only main...issue-83-dynamic-pr-rationale") return { stdout: "README.md\n" };

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const files = await listChangedFilesForRationale(execaMock as never, {
      baseBranch: "main",
      branch: "issue-83-dynamic-pr-rationale",
    });

    expect(files).toEqual(["README.md"]);
  });

  it("falls back to HEAD when target branch ref cannot be resolved locally", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("git");

      if (args.join(" ") === "rev-parse --verify --quiet origin/main") return { stdout: "base-remote-sha\n" };
      if (args.join(" ") === "rev-parse --verify --quiet issue-83-dynamic-pr-rationale") throw new Error("missing head ref");
      if (args.join(" ") === "rev-parse --verify --quiet HEAD") return { stdout: "head-current-sha\n" };
      if (args.join(" ") === "diff --name-only origin/main...HEAD") return { stdout: "src/core/pr-open.ts\n" };

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const files = await listChangedFilesForRationale(execaMock as never, {
      baseBranch: "main",
      branch: "issue-83-dynamic-pr-rationale",
    });

    expect(files).toEqual(["src/core/pr-open.ts"]);
    expect(
      execaMock.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.join(" ") === "diff --name-only origin/main...issue-83-dynamic-pr-rationale",
      ),
    ).toBe(false);
  });
});

