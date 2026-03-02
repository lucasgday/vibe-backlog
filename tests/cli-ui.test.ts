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
    vi.doUnmock("../src/ui/cockpit");
    vi.resetModules();
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

  it("blocks non-loopback hosts unless --allow-remote is explicit", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((entry) => String(entry)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "ui", "serve", "--host", "0.0.0.0"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("host '0.0.0.0' is non-loopback"))).toBe(true);
  });

  it("runs lifecycle start->shutdown path when SIGINT is emitted", async () => {
    const logs: string[] = [];
    const stopCockpitServer = vi.fn(async () => undefined);
    const startCockpitServer = vi.fn(async () => ({
      server: {
        close: (callback: (error?: Error | null) => void): void => callback(null),
      },
      workspaceRoot: tempDir,
      host: "127.0.0.1",
      port: 4173,
      url: "http://127.0.0.1:4173",
    }));
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((entry) => String(entry)).join(" "));
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      process.exitCode = code ?? 0;
      return undefined as never;
    }) as never);

    vi.resetModules();
    vi.doMock("../src/ui/cockpit", () => ({
      startCockpitServer,
      stopCockpitServer,
    }));
    const { createProgram: createProgramWithMock } = await import("../src/cli-program");
    const program = createProgramWithMock(execaMock as never);
    await program.parseAsync(["node", "vibe", "ui", "serve", "--host", "127.0.0.1", "--port", "4173"]);

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startCockpitServer).toHaveBeenCalledTimes(1);
    expect(stopCockpitServer).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes("ui: serving local cockpit at http://127.0.0.1:4173"))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
