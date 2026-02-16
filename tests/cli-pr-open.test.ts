import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { writeTurnContext } from "../src/core/turn";

describe.sequential("cli pr open", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-pr-open-test-"));
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

  it("validates --issue as a positive integer", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--issue", "abc", "--branch", "feat/x"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--issue debe ser un entero positivo"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("creates PR from active turn with deterministic architecture sections", async () => {
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        const full = args.join(" ");
        expect(full).toContain("--base main");
        expect(full).toContain("--head issue-6-vibe-pr-open");

        const bodyIndex = args.findIndex((entry) => entry === "--body");
        const body = bodyIndex >= 0 ? String(args[bodyIndex + 1] ?? "") : "";
        expect(body).toContain("## Architecture decisions");
        expect(body).toContain("## Why these decisions were made");
        expect(body).toContain("## Alternatives considered / rejected");
        expect(body).toContain("TODO:");
        expect(body).toContain("Fixes #6");
        return { stdout: "https://example.test/pull/60\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: created #60 https://example.test/pull/60"))).toBe(true);
  });

  it("handles already-open PR path gracefully", async () => {
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 61,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/61",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: already open #61 https://example.test/pull/61"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("allows explicit args without active turn", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        const full = args.join(" ");
        expect(full).toContain("--base develop");
        expect(full).toContain("--head feature/custom");
        return { stdout: "https://example.test/pull/62\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync([
      "node",
      "vibe",
      "pr",
      "open",
      "--issue",
      "6",
      "--branch",
      "feature/custom",
      "--base",
      "develop",
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: created #62 https://example.test/pull/62"))).toBe(true);
  });

  it("keeps dry-run output path when branch already has an open PR", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 63,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/63",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
          }),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync([
      "node",
      "vibe",
      "pr",
      "open",
      "--issue",
      "6",
      "--branch",
      "feature/custom",
      "--dry-run",
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: dry-run issue=#6 branch=feature/custom base=main"))).toBe(true);
    expect(logs.some((line) => line.includes("body:"))).toBe(true);
    expect(logs.some((line) => line.includes("pr open: already open"))).toBe(false);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "create",
      ),
    ).toBe(false);
  });
});
