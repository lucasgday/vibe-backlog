import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTurnContextPath, writeTurnContext } from "../src/core/turn";

type AgentFinding = {
  id: string;
  pass: "implementation" | "security" | "quality" | "ux" | "growth" | "ops";
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  body: string;
  file: string;
  line: number;
};

function buildAgentOutput(params: {
  runId: string;
  findingsCount: number;
  severity?: "P0" | "P1" | "P2" | "P3";
  findingTitle?: string;
  autofixApplied?: boolean;
  changedFiles?: string[];
  findings?: AgentFinding[];
}): string {
  const severity = params.severity ?? "P2";
  const findings =
    params.findings ??
    (params.findingsCount > 0
      ? [
          {
            id: "f-1",
            pass: "security",
            severity,
            title: params.findingTitle ?? "Validate user input",
            body: "Input path needs validation.",
            file: "src/cli-program.ts",
            line: 42,
          } satisfies AgentFinding,
        ]
      : []);

  return JSON.stringify({
    version: 1,
    run_id: params.runId,
    passes: [
      { name: "implementation", summary: "ok", findings: [] },
      { name: "security", summary: "security pass", findings: findings.filter((finding) => finding.pass === "security") },
      { name: "quality", summary: "ok", findings: [] },
      { name: "ux", summary: "ok", findings: [] },
      { name: "growth", summary: "growth pass", findings: findings.filter((finding) => finding.pass === "growth") },
      { name: "ops", summary: "ok", findings: [] },
    ],
    autofix: {
      applied: params.autofixApplied ?? true,
      summary: "Applied deterministic fixes",
      changed_files: params.changedFiles ?? (findings.length > 0 ? ["src/cli-program.ts"] : []),
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

  it("returns exit code 2 when issue context cannot be resolved", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/no-issue\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--agent-cmd", "cat"]);

    expect(process.exitCode).toBe(2);
    expect(errors.some((line) => line.includes("unable to resolve issue context"))).toBe(true);
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
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/no-issue\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--agent-cmd", "cat"]);

    expect(process.exitCode).toBe(3);
    expect(errors.some((line) => line.includes("malformed turn.json"))).toBe(true);
  });

  it("runs without active turn when --issue is provided", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/no-issue\n" };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "abc123def\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "issue override", url: "https://example.test/issues/42", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-override", findingsCount: 0 }) };
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--dry-run", "--issue", "42"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review: issue=#42"))).toBe(true);
  });

  it("infers issue id from branch name when no turn exists", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "issue-77-new-flow\n" };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "abc123def\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "branch inferred", url: "https://example.test/issues/77", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-branch", findingsCount: 0 }) };
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review: issue=#77"))).toBe(true);
  });

  it("falls back to open PR body autoclose reference when branch has no issue id", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/release-branch\n" };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "abc123def\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 9,
              body: "## Summary\n\nFixes #88",
              baseRefName: "develop",
              url: "https://example.test/pull/9",
              headRefOid: "abc123def",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "pr body inferred", url: "https://example.test/issues/88", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-pr-body", findingsCount: 0 }) };
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review: issue=#88"))).toBe(true);
    expect(logs.some((line) => line.includes("review: pr=#9"))).toBe(true);
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
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => String(entry).startsWith("query=")) ?? "";
        if (String(queryArg).includes("reviewThreads(first:100")) {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            }),
          };
        }
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
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          args[0] === "api" &&
          args[1] === "graphql" &&
          args.some((entry) => String(entry).includes("reviewThreads(first:100")),
      ),
    ).toBe(true);
  });

  it("autofills rationale placeholders when reusing an existing PR", async () => {
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

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 99,
              url: "https://example.test/pull/99",
              headRefOid: "abc123",
              body: [
                "## Summary",
                "- Existing",
                "",
                "## Architecture decisions",
                "- TODO: fill architecture",
                "",
                "## Why these decisions",
                "- TODO: fill why",
                "",
                "## Alternatives considered",
                "- TODO: fill alternatives",
              ].join("\n"),
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
        const bodyIndex = args.findIndex((entry) => entry === "--body");
        const body = bodyIndex >= 0 ? String(args[bodyIndex + 1] ?? "") : "";
        expect(body).not.toContain("TODO:");
        expect(body).toContain("## Architecture decisions");
        expect(body).toContain("## Why these decisions");
        expect(body).toContain("## Alternatives considered");
        return { stdout: "" };
      }
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-rationale-autofill", findingsCount: 0 }) };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "edit",
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("review: rationale sections autofilled in existing PR body."))).toBe(true);
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

  it("creates follow-up issue with all unresolved findings across passes", async () => {
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

    let createdIssueBody = "";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") {
        return {
          stdout: buildAgentOutput({
            runId: "run-growth-followup",
            findingsCount: 0,
            findings: [
              {
                id: "f-security",
                pass: "security",
                severity: "P2",
                title: "Validate server input path",
                body: "Server path input lacks canonicalization.",
                file: "src/core/review.ts",
                line: 101,
              },
              {
                id: "f-growth",
                pass: "growth",
                severity: "P2",
                title: "Improve signup activation prompt",
                body: "Onboarding step lacks targeted nudge for first success milestone.",
                file: "src/ui/onboarding.tsx",
                line: 48,
              },
            ],
          }),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        const bodyFileIndex = args.findIndex((entry) => entry === "--body-file");
        const bodyFilePath = bodyFileIndex >= 0 ? String(args[bodyFileIndex + 1] ?? "") : "";
        createdIssueBody = bodyFilePath ? readFileSync(bodyFilePath, "utf8") : "";
        return { stdout: "https://example.test/issues/202\n" };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "1", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(createdIssueBody).toContain("Validate server input path");
    expect(createdIssueBody).toContain("Improve signup activation prompt");
  });

  it("includes non-growth findings in follow-up issue regardless of severity", async () => {
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

    let createdIssueBody = "";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123" }]) };
      if (cmd === "zsh") {
        return {
          stdout: buildAgentOutput({
            runId: "run-growth-followup-critical",
            findingsCount: 0,
            findings: [
              {
                id: "f-security-low",
                pass: "security",
                severity: "P3",
                title: "Clarify callback validation logging",
                body: "Improve log context around callback validation edge cases.",
                file: "src/core/auth.ts",
                line: 22,
              },
              {
                id: "f-growth",
                pass: "growth",
                severity: "P2",
                title: "Improve signup activation prompt",
                body: "Onboarding step lacks targeted nudge for first success milestone.",
                file: "src/ui/onboarding.tsx",
                line: 48,
              },
            ],
          }),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        const bodyFileIndex = args.findIndex((entry) => entry === "--body-file");
        const bodyFilePath = bodyFileIndex >= 0 ? String(args[bodyFileIndex + 1] ?? "") : "";
        createdIssueBody = bodyFilePath ? readFileSync(bodyFilePath, "utf8") : "";
        return { stdout: "https://example.test/issues/203\n" };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "1", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(createdIssueBody).toContain("Improve signup activation prompt");
    expect(createdIssueBody).toContain("Clarify callback validation logging");
  });

  it("stops after first unresolved attempt when autofix is not applied without creating follow-up", async () => {
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
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") {
        agentRuns += 1;
        return {
          stdout: buildAgentOutput({
            runId: "run-no-autofix",
            findingsCount: 1,
            autofixApplied: false,
            changedFiles: [],
          }),
        };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "5", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(agentRuns).toBe(1);
    expect(logs.some((line) => line.includes("review: termination=no-autofix"))).toBe(true);
    expect(logs.some((line) => line.includes("Termination: early-stop (reason=no-autofix)"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("stops early when autofix reports no changed files", async () => {
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
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") {
        agentRuns += 1;
        return {
          stdout: buildAgentOutput({
            runId: "run-no-autofix-changes",
            findingsCount: 1,
            autofixApplied: true,
            changedFiles: [],
          }),
        };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "5", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(agentRuns).toBe(1);
    expect(logs.some((line) => line.includes("review: termination=no-autofix-changes"))).toBe(true);
    expect(logs.some((line) => line.includes("Termination: early-stop (reason=no-autofix-changes)"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("stops on same finding fingerprints across attempts", async () => {
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
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") {
        agentRuns += 1;
        return {
          stdout: buildAgentOutput({
            runId: `run-same-${agentRuns}`,
            findingsCount: 1,
            changedFiles: ["src/cli-program.ts"],
          }),
        };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--max-attempts", "5", "--no-publish", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(agentRuns).toBe(2);
    expect(logs.some((line) => line.includes("review: termination=same-fingerprints"))).toBe(true);
    expect(logs.some((line) => line.includes("Termination: early-stop (reason=same-fingerprints)"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "create",
      ),
    ).toBe(false);
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

  it("persists artifacts before final commit/push and publishes summary with final head", async () => {
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

    const executed: string[] = [];
    let statusCalls = 0;
    const finalHead = "feedface1234567890";

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      executed.push([cmd, ...args].join(" "));

      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${finalHead}\n` };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        statusCalls += 1;
        if (statusCalls === 1) return { stdout: "" };
        if (statusCalls === 2) return { stdout: " M .vibe/artifacts/postflight.json\n M .vibe/reviews/34/implementation.md\n" };
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "add" && args[1] === "-A") {
        const postflightPath = path.join(tempDir, ".vibe", "artifacts", "postflight.json");
        expect(existsSync(postflightPath)).toBe(true);
        const postflight = readFileSync(postflightPath, "utf8");
        expect(postflight).toContain("Termination: completed");
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "[codex/issue-34-vibe-review abc1234] review\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "push") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-persist", findingsCount: 0 }) };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") return { stdout: "" };
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3] === "repos/acme/demo/issues/99/comments") {
        expect(args.join(" ")).toContain(`vibe:review-head:${finalHead}`);
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => String(entry).startsWith("query=")) ?? "";
        if (String(queryArg).includes("reviewThreads(first:100")) {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            }),
          };
        }
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: finalHead }) };
      return { stdout: "" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review"]);

    expect(process.exitCode).toBeUndefined();
    const addIndex = executed.findIndex((entry) => entry.startsWith("git add -A"));
    const commitIndex = executed.findIndex((entry) => entry.startsWith("git commit -m"));
    const pushIndex = executed.findIndex((entry) => entry.startsWith("git push"));
    expect(addIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(addIndex);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("keeps review successful when thread auto-resolve has partial failures", async () => {
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

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "feedface1234567890\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-partial-thread-resolve", findingsCount: 0 }) };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") return { stdout: "" };
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3] === "repos/acme/demo/issues/99/comments") {
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "feedface1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => String(entry).startsWith("query=")) ?? "";
        if (String(queryArg).includes("reviewThreads(first:100")) {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: "PRRT_1",
                          isResolved: false,
                          isOutdated: false,
                          comments: {
                            nodes: [
                              {
                                id: "comment-1",
                                body: "**[P2] Validate input paths**\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
                                url: "https://example.test/comment/1",
                                path: "src/cli-program.ts",
                                line: 42,
                                originalLine: 42,
                                author: { login: "review-bot" },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          };
        }
        if (String(queryArg).includes("addPullRequestReviewThreadReply")) {
          return { stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://example.test/reply/1" } } } }) };
        }
        if (String(queryArg).includes("resolveReviewThread")) {
          return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } } }) };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--no-autopush"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review: threads selected=1 resolved=0 failed=1"))).toBe(true);
    expect(logs.some((line) => line.includes("review: thread auto-resolve warning"))).toBe(true);
  });

  it("fails when tracked changes remain after autopush persistence check", async () => {
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

    let statusCalls = 0;
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "codex/issue-34-vibe-review\n" };
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        statusCalls += 1;
        if (statusCalls === 1) return { stdout: "" };
        if (statusCalls === 2) return { stdout: " M .vibe/artifacts/postflight.json\n" };
        return { stdout: " M src/core/review.ts\n" };
      }
      if (cmd === "git" && args[0] === "add") return { stdout: "" };
      if (cmd === "git" && args[0] === "commit") return { stdout: "[branch abc123] review\n", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[0] === "push") return { stdout: "" };
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view")
        return { stdout: JSON.stringify({ title: "review command", url: "https://example.test/issues/34", milestone: null }) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
        return { stdout: JSON.stringify([{ number: 99, url: "https://example.test/pull/99", headRefOid: "abc123", body: "Fixes #34" }]) };
      if (cmd === "zsh") return { stdout: buildAgentOutput({ runId: "run-persist-error", findingsCount: 0 }) };
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "--no-publish"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("artifacts persistence incomplete"))).toBe(true);
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
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          !(args[0] === "pr" && args[1] === "list"),
      ),
    ).toBe(false);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
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
