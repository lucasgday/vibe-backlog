import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { writeTurnContext } from "../src/core/turn";

describe.sequential("cli status and preflight snapshots", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-status-test-"));
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

  it("prints status with ongoing issues, hygiene warnings, active issue labels, and branch PRs", async () => {
    await writeTurnContext({
      issue_id: 13,
      branch: "codex/issue-13-vibe-status",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe status",
    });

    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## codex/issue-13-vibe-status\n M src/cli-program.ts" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 13,
              title: "feat: add vibe status command for turn + tracker snapshot",
              state: "OPEN",
              labels: [{ name: "status:in-progress" }, { name: "module:cli" }],
              milestone: { title: "CLI usable (repos con .vibe)" },
              updatedAt: "2026-02-16T16:00:00Z",
              url: "https://example.test/issues/13",
            },
            {
              number: 40,
              title: "chore: cleanup stale docs",
              state: "OPEN",
              labels: [{ name: "documentation" }],
              milestone: null,
              updatedAt: "2026-02-16T15:00:00Z",
              url: "https://example.test/issues/40",
            },
            {
              number: 41,
              title: "fix: preflight formatting",
              state: "OPEN",
              labels: [{ name: "bug" }],
              milestone: { title: "CLI usable (repos con .vibe)" },
              updatedAt: "2026-02-16T14:00:00Z",
              url: "https://example.test/issues/41",
            },
          ]),
        };
      }
      if (args[0] === "issue" && args[1] === "view" && args[2] === "13") {
        return {
          stdout: JSON.stringify({
            number: 13,
            title: "feat: add vibe status command for turn + tracker snapshot",
            state: "OPEN",
            labels: [{ name: "status:in-progress" }, { name: "module:cli" }],
            milestone: { title: "CLI usable (repos con .vibe)" },
            updatedAt: "2026-02-16T16:00:00Z",
            url: "https://example.test/issues/13",
          }),
        };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 99,
              title: "feat: add status snapshot",
              state: "OPEN",
              url: "https://example.test/pull/99",
            },
          ]),
        };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "status"]);

    expect(logs.some((line) => line.includes("Active turn: issue=13"))).toBe(true);
    expect(logs.some((line) => line.includes("In-progress issues:"))).toBe(true);
    expect(logs.some((line) => line.includes("13\tOPEN\tfeat: add vibe status command for turn + tracker snapshot"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("Tracker hygiene warnings:"))).toBe(true);
    expect(logs).toContain("missing milestone: #40");
    expect(logs).toContain("missing module label: #40, #41");
    expect(logs.some((line) => line.includes("Active issue labels: status:in-progress, module:cli"))).toBe(true);
    expect(logs.some((line) => line.includes("Branch PRs:"))).toBe(true);
    expect(logs.some((line) => line.includes("#99 OPEN feat: add status snapshot"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints preflight in-progress section and hygiene warnings", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              title: "feat: preflight snapshot",
              state: "OPEN",
              labels: [{ name: "status:in-progress" }, { name: "module:tracker" }],
              milestone: { title: "CLI usable (repos con .vibe)" },
              updatedAt: "2026-02-16T13:00:00Z",
              url: "https://example.test/issues/7",
            },
          ]),
        };
      }
      if (cmd === "zsh" && args[0] === "-lc") {
        return { stdout: "/usr/local/bin/gitleaks\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "preflight"]);

    expect(logs.some((line) => line.includes("Open issues (top 10):"))).toBe(true);
    expect(logs.some((line) => line.includes("In-progress issues:"))).toBe(true);
    expect(logs.some((line) => line.includes("Tracker hygiene warnings:"))).toBe(true);
    expect(logs.some((line) => line.includes("Security scan:"))).toBe(true);
    expect(logs.some((line) => line.includes("gitleaks: available"))).toBe(true);
    expect(logs.some((line) => line.includes("none"))).toBe(true);
  });

  it("keeps preflight non-blocking when security probe fails", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "zsh" && args[0] === "-lc") {
        throw new Error("security probe unavailable");
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "preflight"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("Security scan:"))).toBe(true);
    expect(logs.some((line) => line.includes("gitleaks: missing"))).toBe(true);
  });

  it("keeps status non-blocking when gh is unavailable", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## main" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        throw new Error("error connecting to api.github.com");
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "status"]);

    expect(logs.some((line) => line.includes("Tracker snapshot: unavailable (gh issue list failed)"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("uses dotted branch names when querying branch PR snapshots", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "-sb") {
        return { stdout: "## release/1.2...origin/release/1.2 [ahead 1]" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "status"]);

    expect(execaMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "list", "--head", "release/1.2", "--state", "all", "--json", "number,title,state,url"],
      { stdio: "pipe" },
    );
    expect(logs.some((line) => line.includes("Branch PRs:"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});
