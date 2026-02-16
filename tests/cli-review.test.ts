import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTurnContextPath, writeTurnContext } from "../src/core/turn";

function buildAgentOutput(params: { runId: string; findingsCount: number; severity?: "P0" | "P1" | "P2" | "P3" }): string {
  const severity = params.severity ?? "P2";
  const finding =
    params.findingsCount > 0
      ? [
          {
            id: "f-1",
            pass: "security",
            severity,
            title: "Validate user input",
            body: "Input path needs validation.",
            file: "src/cli-program.ts",
            line: 42,
          },
        ]
      : [];

  return JSON.stringify({
    version: 1,
    run_id: params.runId,
    passes: [
      { name: "implementation", summary: "ok", findings: [] },
      { name: "security", summary: "security pass", findings: finding },
      { name: "quality", summary: "ok", findings: [] },
      { name: "ux", summary: "ok", findings: [] },
      { name: "ops", summary: "ok", findings: [] },
    ],
    autofix: {
      applied: true,
      summary: "Applied deterministic fixes",
      changed_files: [],
    },
  });
}

describe.sequential("cli review", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;
  const envKeys = [
    "VIBE_REVIEW_AGENT_CMD",
    "VIBE_REVIEW_CODEX_CMD",
    "VIBE_REVIEW_CLAUDE_CMD",
    "VIBE_REVIEW_GEMINI_CMD",
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_CI",
    "__CFBundleIdentifier",
  ] as const;
  let originalEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-review-test-"));
    process.chdir(tempDir);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns exit code 2 when no active turn exists", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--agent-cmd", "cat"]);

    expect(process.exitCode).toBe(2);
    expect(errors).toContain("review: no active turn.");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("fails with exit 1 on invalid --agent-provider", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--agent-provider", "invalid-provider"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--agent-provider must be one of"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("returns exit code 3 when turn.json is malformed", async () => {
    const turnPath = getTurnContextPath();
    mkdirSync(path.dirname(turnPath), { recursive: true });
    writeFileSync(turnPath, '{"issue_id": 34, "branch": "codex/issue-34-vibe-review",', "utf8");

    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--agent-cmd", "cat"]);

    expect(process.exitCode).toBe(3);
    expect(errors.some((line) => line.includes("malformed turn.json"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("fails with exit 1 when no provider is available", async () => {
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });

    const errors: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("no agent provider available"))).toBe(true);
  });

  it("creates PR when branch has no open PR", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: "https://example.test/pull/55\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view")
        return { stdout: JSON.stringify({ number: 55, url: "https://example.test/pull/55", headRefOid: "abc123" }) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-create-pr", findingsCount: 0 }) };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") return { stdout: "" };
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/55/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3] === "repos/acme/demo/issues/55/comments") {
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/55/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "create",
      ),
    ).toBe(true);
  });

  it("retries up to max attempts and returns strict exit code 4 when unresolved remain", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    let agentRuns = 0;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") {
        agentRuns += 1;
        return { stdout: buildAgentOutput({ runId: `run-${agentRuns}`, findingsCount: 1, severity: "P1" }) };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") return { stdout: "https://example.test/issues/200\n" };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--strict", "--max-attempts", "2", "--no-publish", "--no-autopush"]);

    expect(agentRuns).toBe(2);
    expect(process.exitCode).toBe(4);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "create",
      ),
    ).toBe(true);
  });

  it("keeps exit 0 when unresolved remain and strict mode is disabled", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-no-strict", findingsCount: 1 }) };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") return { stdout: "https://example.test/issues/201\n" };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync([
      "node",
      "vibe",
      "review",
      "--max-attempts",
      "1",
      "--followup-label",
      "enhancement",
      "--no-publish",
      "--no-autopush",
    ]);

    expect(process.exitCode).toBeUndefined();
    const issueCreateCall = execaMock.mock.calls.find(
      ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "create",
    );
    expect(issueCreateCall).toBeDefined();
    expect(String(issueCreateCall?.[1] ?? "")).toContain("enhancement");
  });

  it("dry-run avoids mutating git and GitHub", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-dry", findingsCount: 0 }) };
      throw new Error(`unexpected command in dry-run: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "git" &&
          Array.isArray(args) &&
          (args[0] === "add" || args[0] === "commit" || args[0] === "push"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          ((args[0] === "pr" && args[1] === "review") || (args[0] === "api" && args[1] === "--method")),
      ),
    ).toBe(false);
    expect(existsSync(path.join(tempDir, ".vibe", "reviews"))).toBe(false);
  });

  it("blocks autopush on main branch", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 34,
      branch: "main",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });

    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "main\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-main", findingsCount: 0 }) };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--no-publish"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("autopush blocked on main branch"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "gh")).toBe(false);
  });

  it("attempts codex resume first and falls back to standard codex exec", async () => {
    process.env.CODEX_THREAD_ID = "thread-123";
    await writeTurnContext({
      issue_id: 34,
      branch: "codex/issue-34-vibe-review",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "review command",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh" && args[0] === "-lc" && args[1] === "command -v codex") return { stdout: "/usr/bin/codex\n", exitCode: 0 };
      if (cmd === "codex" && args[0] === "exec" && args[1] === "resume")
        return { stdout: "not-json", stderr: "", exitCode: 1 };
      if (cmd === "codex" && args[0] === "exec" && args[1] === "--skip-git-repo-check") {
        return { stdout: buildAgentOutput({ runId: "run-resume-fallback", findingsCount: 0 }) };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "1", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "codex" && Array.isArray(args) && args[0] === "exec" && args[1] === "resume",
      ),
    ).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "codex" &&
          Array.isArray(args) &&
          args[0] === "exec" &&
          args[1] === "--skip-git-repo-check",
      ),
    ).toBe(true);
  });
});
