import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { preserveProtectedSections } from "../src/core/init";

describe.sequential("cli update flows", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-update-test-"));
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

  it("checks self update and reports up-to-date", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "npm" && args[0] === "view") {
        return { stdout: JSON.stringify("0.1.0") };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "self", "update", "--check"]);

    expect(logs.some((line) => line.includes("self update: up-to-date (0.1.0)"))).toBe(true);
    expect(logs.some((line) => line.includes("latest: 0.1.0"))).toBe(true);
    expect(execaMock).toHaveBeenCalledWith("npm", ["view", "vibe-backlog", "version", "--json"], { stdio: "pipe" });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints machine-readable JSON for self update checks", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "npm" && args[0] === "view") {
        return { stdout: JSON.stringify("0.2.0") };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "self", "update", "--check", "--json"]);

    const payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(payload.kind).toBe("tool-self-update");
    expect(payload.executed).toBe(false);
    const check = payload.check as Record<string, unknown>;
    expect(check.status).toBe("update-available");
    expect(check.latestVersion).toBe("0.2.0");
  });

  it("keeps self update --json machine-readable when an update is executed", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "npm" && args[0] === "view") {
        return { stdout: JSON.stringify("0.2.0") };
      }
      if (cmd === "npm" && args[0] === "install" && args[1] === "-g") {
        expect(opts?.stdio).toBe("pipe");
        return { stdout: "installed\n" };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "self", "update", "--json"]);

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.kind).toBe("tool-self-update");
    expect(payload.executed).toBe(true);
    const check = payload.check as Record<string, unknown>;
    expect(check.status).toBe("update-available");
  });

  it("keeps self update check non-blocking when registry is unavailable", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "npm" && args[0] === "view") {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "self", "update", "--check"]);

    expect(logs.some((line) => line.includes("self update: unavailable"))).toBe(true);
    expect(logs.some((line) => line.includes("registry.npmjs.org"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("checks, previews, and applies scaffold updates while preserving protected user notes", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "init", "--skip-tracker"]);

    const metadataPath = path.join(tempDir, ".vibe", "scaffold.json");
    const agentsPath = path.join(tempDir, "AGENTS.md");
    unlinkSync(metadataPath);
    writeFileSync(
      agentsPath,
      [
        "# AGENTS",
        "",
        "<!-- vibe:user-notes:start -->",
        "keep-my-note",
        "<!-- vibe:user-notes:end -->",
        "",
        "<!-- vibe:agent-snippet:start -->",
        "old managed snippet body",
        "<!-- vibe:agent-snippet:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    logs.length = 0;
    await program.parseAsync(["node", "vibe", "update", "--check"]);
    expect(logs.some((line) => line.includes("scaffold update: update-available"))).toBe(true);
    expect(logs.some((line) => line.includes("metadata missing"))).toBe(true);

    const agentsBeforeDryRun = readFileSync(agentsPath, "utf8");
    logs.length = 0;
    await program.parseAsync(["node", "vibe", "update", "--dry-run"]);
    expect(logs.some((line) => line.includes("scaffold update: dry-run mode"))).toBe(true);
    expect(logs.some((line) => line.includes("Diff preview:"))).toBe(true);
    expect(logs.some((line) => line.includes("AGENTS.md"))).toBe(true);
    expect(logs.some((line) => line.includes("keep-my-note"))).toBe(false);
    expect(logs.some((line) => line.includes("[vibe protected section redacted in preview]"))).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toBe(agentsBeforeDryRun);
    expect(existsSync(metadataPath)).toBe(false);

    logs.length = 0;
    await program.parseAsync(["node", "vibe", "update"]);
    expect(logs.some((line) => line.includes("scaffold update: DONE"))).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);

    const agentsAfterApply = readFileSync(agentsPath, "utf8");
    expect(agentsAfterApply).toContain("keep-my-note");
    expect(agentsAfterApply).toContain("Run `node dist/cli.cjs preflight` before implementation.");
    expect(agentsAfterApply).not.toContain("old managed snippet body");

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.scaffold_template_version).toBe(2);

    logs.length = 0;
    await program.parseAsync(["node", "vibe", "update", "--check"]);
    expect(logs.some((line) => line.includes("scaffold update: up-to-date"))).toBe(true);

    const metadataAfterApply = readFileSync(metadataPath, "utf8");
    const agentsAfterSecondSnapshot = readFileSync(agentsPath, "utf8");
    logs.length = 0;
    await program.parseAsync(["node", "vibe", "update"]);
    expect(logs.some((line) => line.includes("status: up-to-date"))).toBe(true);
    expect(logs.some((line) => line.includes("scaffold update: no changes needed."))).toBe(true);
    expect(logs.some((line) => line.includes("Diff preview:"))).toBe(false);
    expect(readFileSync(metadataPath, "utf8")).toBe(metadataAfterApply);
    expect(readFileSync(agentsPath, "utf8")).toBe(agentsAfterSecondSnapshot);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints machine-readable JSON for scaffold update checks", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "update", "--check", "--json"]);

    const payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(payload.kind).toBe("scaffold-update-check");
    expect(payload.check_only).toBe(true);
    expect(payload.status).toBe("not-initialized");
  });
});

describe("preserveProtectedSections", () => {
  it("keeps protected marker blocks from current content when template changes surrounding text", () => {
    const template = [
      "before-new",
      "<!-- vibe:user-notes:start -->",
      "template-note",
      "<!-- vibe:user-notes:end -->",
      "after-new",
      "",
    ].join("\n");
    const current = [
      "before-old",
      "<!-- vibe:user-notes:start -->",
      "user-custom-note",
      "<!-- vibe:user-notes:end -->",
      "after-old",
      "",
    ].join("\n");

    const merged = preserveProtectedSections(template, current);

    expect(merged).toContain("before-new");
    expect(merged).toContain("after-new");
    expect(merged).toContain("user-custom-note");
    expect(merged).not.toContain("template-note");
  });
});
