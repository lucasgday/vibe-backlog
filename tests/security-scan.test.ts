import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSecurityScanRecordPath,
  readLastSecurityScan,
  resolveSecurityPolicy,
  runSecurityScan,
  writeLastSecurityScan,
  type SecurityScanRecord,
} from "../src/core/security-scan";

describe.sequential("security scan core", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-security-scan-core-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers explicit policy override over contract.yml", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "contract.yml"), "security:\n  gitleaks:\n    policy: fail\n", "utf8");

    const resolved = await resolveSecurityPolicy({ override: "warn" });

    expect(resolved.policy).toBe("warn");
    expect(resolved.source).toBe("flag");
  });

  it("reads policy from contract.yml when valid", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "contract.yml"), "security:\n  gitleaks:\n    policy: fail\n", "utf8");

    const resolved = await resolveSecurityPolicy({});

    expect(resolved.policy).toBe("fail");
    expect(resolved.source).toBe("contract");
    expect(resolved.warnings).toEqual([]);
  });

  it("falls back to warn when contract policy is invalid", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "contract.yml"), "security:\n  gitleaks:\n    policy: block\n", "utf8");

    const resolved = await resolveSecurityPolicy({});

    expect(resolved.policy).toBe("warn");
    expect(resolved.source).toBe("default");
    expect(resolved.warnings.some((warning) => warning.includes("invalid policy"))).toBe(true);
  });

  it("returns deterministic dry-run result without writing runtime record", async () => {
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "-lc") {
        return { stdout: "/usr/local/bin/gitleaks\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await runSecurityScan(
      {
        mode: "staged",
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.status).toBe("planned");
    expect(result.command).toBe("gitleaks git --staged --no-banner --redact");
    expect(result.recordWritten).toBe(false);
    expect(await readLastSecurityScan()).toBeNull();
    expect(
      execaMock.mock.calls.some(([cmd]) => cmd === "gitleaks"),
    ).toBe(false);
  });

  it("handles missing gitleaks in warn mode without failing and persists status", async () => {
    const execaMock = vi.fn(async () => {
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await runSecurityScan(
      {
        mode: "staged",
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.status).toBe("scanner-missing");
    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(true);

    const lastScan = await readLastSecurityScan();
    expect(lastScan?.status).toBe("scanner-missing");
    expect(lastScan?.policy).toBe("warn");
  });

  it("fails when gitleaks is missing and policy is fail", async () => {
    const execaMock = vi.fn(async () => {
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await runSecurityScan(
      {
        mode: "staged",
        policyOverride: "fail",
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.status).toBe("scanner-missing");
    expect(result.exitCode).toBe(1);
  });

  it("treats gitleaks exitCode=1 as findings and obeys policy", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "zsh" && args[0] === "-lc") {
        return { stdout: "/usr/local/bin/gitleaks\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "gitleaks") {
        return { stdout: "", stderr: "1 leak found", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const warnResult = await runSecurityScan(
      {
        mode: "history",
        dryRun: false,
      },
      execaMock as never,
    );

    const failResult = await runSecurityScan(
      {
        mode: "history",
        policyOverride: "fail",
        dryRun: false,
      },
      execaMock as never,
    );

    expect(warnResult.status).toBe("findings");
    expect(warnResult.exitCode).toBe(0);
    expect(failResult.status).toBe("findings");
    expect(failResult.exitCode).toBe(1);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gitleaks" && Array.isArray(args) && args[0] === "git" && args[1] === "--no-banner",
      ),
    ).toBe(true);
  });

  it("returns null for malformed runtime security-scan record", async () => {
    const recordPath = getSecurityScanRecordPath();
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, '{"version":1', "utf8");

    expect(await readLastSecurityScan()).toBeNull();
  });

  it("writes and reads back a valid runtime security-scan record", async () => {
    const record: SecurityScanRecord = {
      version: 1,
      scanned_at: "2026-02-17T00:00:00.000Z",
      mode: "staged",
      policy: "warn",
      status: "pass",
      findings_detected: false,
      gitleaks_available: true,
      command: "gitleaks git --staged --no-banner --redact",
      detail: null,
    };

    const filePath = await writeLastSecurityScan(record);
    expect(filePath).toBe(getSecurityScanRecordPath());

    const loaded = await readLastSecurityScan();
    expect(loaded).toEqual(record);
  });
});
