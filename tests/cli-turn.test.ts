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
    expect(logs.some((line) => line.includes("review templates: created 5 file(s)"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});
