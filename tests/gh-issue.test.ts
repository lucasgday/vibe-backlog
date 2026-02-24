import { constants } from "node:fs";
import { accessSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIssueWithBodyFile } from "../src/core/gh-issue";

function assertMissing(pathname: string) {
  expect(() => accessSync(pathname, constants.F_OK)).toThrow();
}

function walkFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir);
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      paths.push(...walkFiles(fullPath));
      continue;
    }
    if (fullPath.endsWith(".ts")) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function extractIssueCreateArrayLiterals(source: string): string[] {
  const regex = /\[[^\]]*["']issue["']\s*,\s*["']create["'][^\]]*\]/gs;
  return Array.from(source.matchAll(regex), (match) => match[0]);
}

describe("gh issue helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates issues with --body-file and cleans up temp file", async () => {
    let bodyFilePath = "";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

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
    expect(logs).toContain("issue create: mode=body_file labels=2 milestone=yes");
    assertMissing(bodyFilePath);
  });

  it("cleans up temp file when gh issue create fails", async () => {
    let bodyFilePath = "";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
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
    expect(logs).toContain("issue create: mode=body_file labels=0 milestone=no");
    assertMissing(bodyFilePath);
  });

  it("enforces --body-file across all gh issue create command literals in src/core", () => {
    const sourceRoot = path.join(process.cwd(), "src", "core");
    const files = walkFiles(sourceRoot);
    const snippets = files.flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return extractIssueCreateArrayLiterals(source).map((snippet) => ({ filePath, snippet }));
    });

    expect(snippets.length).toBeGreaterThan(0);
    for (const { filePath, snippet } of snippets) {
      expect(snippet, `${filePath} should use --body-file`).toContain("--body-file");
      expect(snippet, `${filePath} must not use inline --body`).not.toMatch(/["']--body["']/);
    }
  });
});
