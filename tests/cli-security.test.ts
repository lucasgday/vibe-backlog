import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";

describe.sequential("cli security scan", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-security-test-"));
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

  it("runs dry-run with staged default and contract policy", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "contract.yml"), "security:\n  gitleaks:\n    policy: warn\n", "utf8");

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gitleaks" && args[0] === "version") {
        return { stdout: "8.24.2\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "security", "scan", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("security scan: mode=staged policy=warn source=contract dry-run=yes"))).toBe(true);
    expect(logs.some((line) => line.includes("planned command: gitleaks git --staged --no-banner --redact"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd, args]) => cmd === "gitleaks" && Array.isArray(args) && args[0] === "version")).toBe(
      true,
    );
    expect(
      execaMock.mock.calls.some(([cmd, args]) => cmd === "gitleaks" && Array.isArray(args) && args[0] !== "version"),
    ).toBe(false);
  });

  it("rejects invalid --mode values", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "security", "scan", "--mode", "bad-mode"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--mode must be one of"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("fails when policy=fail and gitleaks is unavailable", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async () => {
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "security", "scan", "--policy", "fail"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((line) => line.includes("gitleaks: missing"))).toBe(true);
    expect(logs.some((line) => line.includes("security scan remediation:"))).toBe(true);
  });

  it("keeps warn mode non-blocking when findings are detected", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gitleaks" && args[0] === "version") {
        return { stdout: "8.24.2\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "gitleaks" && args[0] !== "version") {
        return { stdout: "", stderr: "1 leak found", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "security", "scan", "--mode", "working-tree"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("scan status: findings"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gitleaks" &&
          Array.isArray(args) &&
          args[0] === "dir" &&
          args[1] === "." &&
          args[2] === "--no-banner",
      ),
    ).toBe(true);
  });
});
