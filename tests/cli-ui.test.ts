import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";

describe.sequential("cli ui serve", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-ui-test-"));
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

  it("fails fast when --port is outside valid range", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((entry) => String(entry)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "ui", "serve", "--port", "70000"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("ui serve: --port must be an integer between 0 and 65535."))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });
});
