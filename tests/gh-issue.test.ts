import { constants } from "node:fs";
import { accessSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createIssueWithBodyFile } from "../src/core/gh-issue";

function assertMissing(pathname: string) {
  expect(() => accessSync(pathname, constants.F_OK)).toThrow();
}

describe("gh issue helper", () => {
  it("creates issues with --body-file and cleans up temp file", async () => {
    let bodyFilePath = "";

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("gh");
      expect(args.slice(0, 2)).toEqual(["issue", "create"]);
      expect(args).toContain("--body-file");
      expect(args).not.toContain("--body");
      expect(args.join(" ")).toContain("--label bug");
      expect(args.join(" ")).toContain("--label status:backlog");
      expect(args.join(" ")).toContain("--milestone CLI usable (repos con .vibe)");

      const bodyFileFlagIndex = args.findIndex((entry) => entry === "--body-file");
      bodyFilePath = String(args[bodyFileFlagIndex + 1] ?? "");
      expect(bodyFilePath.length).toBeGreaterThan(0);
      const body = readFileSync(bodyFilePath, "utf8");
      expect(body).toContain("## Context");
      expect(body).toContain("Long markdown body");

      return { stdout: "https://example.test/issues/901\n" };
    });

    const result = await createIssueWithBodyFile({
      execaFn: execaMock as never,
      title: "policy(cli): enforce body-file",
      body: "## Context\n\nLong markdown body\n\n- item a\n- item b",
      labels: ["bug", "status:backlog"],
      milestoneTitle: "CLI usable (repos con .vibe)",
    });

    expect(result.stdout).toContain("/issues/901");
    expect(execaMock).toHaveBeenCalledTimes(1);
    assertMissing(bodyFilePath);
  });

  it("cleans up temp file when gh issue create fails", async () => {
    let bodyFilePath = "";
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      const bodyFileFlagIndex = args.findIndex((entry) => entry === "--body-file");
      bodyFilePath = String(args[bodyFileFlagIndex + 1] ?? "");
      throw new Error("gh unavailable");
    });

    await expect(
      createIssueWithBodyFile({
        execaFn: execaMock as never,
        title: "x",
        body: "y",
      }),
    ).rejects.toThrow("gh unavailable");

    expect(execaMock).toHaveBeenCalledTimes(1);
    assertMissing(bodyFilePath);
  });
});
