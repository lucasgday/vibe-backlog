import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTurnContextPath, writeTurnContext } from "../src/core/turn";

describe.sequential("cli guard", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-guard-test-"));
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

  it("fails when there is no active turn", async () => {
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "guard"]);

    expect(execaMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errors).toContain("guard: no active turn.");
    expect(errors).toContain("Run: node dist/cli.cjs turn start --issue <n>");
  });

  it("passes when active turn context is valid", async () => {
    await writeTurnContext({
      issue_id: 10,
      branch: "issue-10-vibe-guard",
      base_branch: "main",
      started_at: "2026-02-14T00:00:00.000Z",
      issue_title: "Add vibe guard",
    });

    const execaMock = vi.fn(async () => ({ stdout: "" }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "guard"]);

    expect(execaMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(logs).toContain("guard: OK issue=10 branch=issue-10-vibe-guard base_branch=main");
  });

  it("fails when active turn context is invalid", async () => {
    const turnPath = getTurnContextPath();
    mkdirSync(path.dirname(turnPath), { recursive: true });
    writeFileSync(
      turnPath,
      `${JSON.stringify(
        {
          issue_id: 10,
          base_branch: "main",
          started_at: "2026-02-14T00:00:00.000Z",
          issue_title: "Invalid turn",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const execaMock = vi.fn(async () => ({ stdout: "" }));
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "guard"]);

    expect(execaMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
    expect(errors).toContain("guard: invalid active turn (missing/invalid: branch).");
  });
});
