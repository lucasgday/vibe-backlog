import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";

describe.sequential("cli branch cleanup", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-branch-cleanup-test-"));
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

  it("prints deterministic summary in dry-run mode", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "for-each-ref") return { stdout: "feature/merged\torigin/feature/merged\t[gone]", stderr: "", exitCode: 0 };
      if (args[0] === "merge-base") return { stdout: "", stderr: "", exitCode: 0 };

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "branch", "cleanup", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("branch cleanup: base=origin/main current=main dry-run=yes"))).toBe(true);
    expect(logs.some((line) => line.includes("branch cleanup summary: detected=1 deleted=0 planned=1 skipped=0 errors=0"))).toBe(
      true,
    );
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "branch" && (args[1] === "-d" || args[1] === "-D"),
      ),
    ).toBe(false);
  });

  it("rejects --force-unmerged without --yes", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "branch", "cleanup", "--force-unmerged"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--force-unmerged requires --yes"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });
});
