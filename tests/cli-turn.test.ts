import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { REVIEW_TEMPLATE_FILE_NAMES } from "../src/core/reviews";
import { getTurnContextPath } from "../src/core/turn";

describe.sequential("cli turn start", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-turn-test-"));
    process.chdir(tempDir);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates turn context and review templates on turn start", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "origin/main\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { stdout: "0\t0\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main...origin/main\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [origin/main] sync\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view" && args[2] === "12") {
        return { stdout: "Auto-create review templates\n" };
      }
      if (cmd === "git" && args[0] === "show-ref") {
        return { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "checkout" && args[1] === "-b") {
        return { stdout: "" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "12"]);

    const turnPath = getTurnContextPath();
    expect(existsSync(turnPath)).toBe(true);
    expect(readFileSync(turnPath, "utf8")).toContain('"issue_id": 12');

    const reviewDir = path.join(tempDir, ".vibe", "reviews", "12");
    for (const fileName of REVIEW_TEMPLATE_FILE_NAMES) {
      expect(existsSync(path.join(reviewDir, fileName))).toBe(true);
    }

    const checkoutCreate = execaMock.mock.calls.find(
      ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "checkout" && args[1] === "-b",
    );
    expect(checkoutCreate).toBeDefined();
    expect(String(checkoutCreate?.[1]?.[2] ?? "")).toMatch(/^issue-12-/);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "fetch" && args[1] === "origin",
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes(`review templates: created ${REVIEW_TEMPLATE_FILE_NAMES.length} file(s)`))).toBe(
      true,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("ignores bracketed commit subject metadata when no upstream exists", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [behind 1] chore: note in subject\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view" && args[2] === "42") {
        return { stdout: "guard follow-up\n" };
      }
      if (cmd === "git" && args[0] === "show-ref") {
        return { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "checkout" && args[1] === "-b") {
        return { stdout: "" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "42"]);

    const turnPath = getTurnContextPath();
    expect(existsSync(turnPath)).toBe(true);
    expect(readFileSync(turnPath, "utf8")).toContain('"issue_id": 42');
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "checkout" && args[1] === "-b",
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes(`review templates: created ${REVIEW_TEMPLATE_FILE_NAMES.length} file(s)`))).toBe(
      true,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("ignores descriptor-like bracket subject when branch has no upstream", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [origin/main: behind 1] chore: descriptor-like subject\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view" && args[2] === "43") {
        return { stdout: "descriptor-like subject\n" };
      }
      if (cmd === "git" && args[0] === "show-ref") {
        return { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "checkout" && args[1] === "-b") {
        return { stdout: "" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "43"]);

    const turnPath = getTurnContextPath();
    expect(existsSync(turnPath)).toBe(true);
    expect(readFileSync(turnPath, "utf8")).toContain('"issue_id": 43');
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "checkout" && args[1] === "-b",
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes(`review templates: created ${REVIEW_TEMPLATE_FILE_NAMES.length} file(s)`))).toBe(
      true,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("blocks turn start when current branch is behind upstream", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "origin/main\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { stdout: "0\t2\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main...origin/main [behind 2]\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [origin/main: behind 2] sync\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "41"]);

    const turnPath = getTurnContextPath();
    expect(existsSync(turnPath)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("remote state guard blocked branch creation"))).toBe(true);
    expect(errors.some((line) => line.includes("git pull --ff-only origin main"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "checkout" && args[1] === "-b",
      ),
    ).toBe(false);
  });

  it("blocks turn start when current branch diverged from upstream", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "origin/main\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { stdout: "1\t3\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main...origin/main [ahead 1, behind 3]\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [origin/main: ahead 1, behind 3] sync\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "41"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("diverged"))).toBe(true);
    expect(errors.some((line) => line.includes("git rebase origin/main"))).toBe(true);
  });

  it("blocks turn start when current branch already has closed or merged PRs", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch" && args[1] === "origin") {
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "--abbrev-ref" &&
        args[2] === "--symbolic-full-name" &&
        args[3] === "main@{upstream}"
      ) {
        return { stdout: "origin/main\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { stdout: "0\t0\n", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main...origin/main\n" };
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "-vv") {
        return { stdout: "* main 0f00baa [origin/main] sync\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 101, title: "merged", state: "MERGED", url: "https://example.test/pr/101" },
            { number: 102, title: "closed", state: "CLOSED", url: "https://example.test/pr/102" },
          ]),
        };
      }

      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "turn", "start", "--issue", "41"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("closed/merged PRs"))).toBe(true);
    expect(errors.some((line) => line.includes("#101 (MERGED)"))).toBe(true);
    expect(errors.some((line) => line.includes("git checkout main"))).toBe(true);
  });
});
