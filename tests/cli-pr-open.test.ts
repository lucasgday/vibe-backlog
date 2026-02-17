import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { buildReviewPolicyKey } from "../src/core/review-pr";
import { writeTurnContext } from "../src/core/turn";

const PR_OPEN_POLICY_KEY = buildReviewPolicyKey({
  autofix: true,
  autopush: true,
  publish: true,
  strict: false,
  maxAttempts: 5,
});

function buildAgentOutput(runId: string, findingsCount = 0): string {
  const findings =
    findingsCount > 0
      ? [
          {
            id: "f-1",
            pass: "security",
            severity: "P2",
            title: "Validate input",
            body: "Input must be sanitized.",
            file: "src/cli-program.ts",
            line: 42,
          },
        ]
      : [];

  return JSON.stringify({
    version: 1,
    run_id: runId,
    passes: [
      { name: "implementation", summary: "ok", findings: [] },
      { name: "security", summary: "ok", findings },
      { name: "quality", summary: "ok", findings: [] },
      { name: "ux", summary: "ok", findings: [] },
      { name: "ops", summary: "ok", findings: [] },
    ],
    autofix: {
      applied: false,
      summary: "none",
      changed_files: [],
    },
  });
}

describe.sequential("cli pr open", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;
  let originalReviewAgentCmd: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-pr-open-test-"));
    process.chdir(tempDir);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    originalReviewAgentCmd = process.env.VIBE_REVIEW_AGENT_CMD;
    delete process.env.VIBE_REVIEW_AGENT_CMD;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (originalReviewAgentCmd === undefined) {
      delete process.env.VIBE_REVIEW_AGENT_CMD;
    } else {
      process.env.VIBE_REVIEW_AGENT_CMD = originalReviewAgentCmd;
    }
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
        expect(body).not.toContain("TODO:");
        expect(body).toContain("Fixes #6");
        return { stdout: "https://example.test/pull/60\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && /repos\/acme\/demo\/issues\/60\/comments\?per_page=100&page=1/.test(String(args[1] ?? ""))) {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/60/comments"
      ) {
        return { stdout: JSON.stringify({ id: 1 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--skip-review-gate"]);

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
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body\n\n## Architecture decisions\n- done\n\n## Why these decisions were made\n- done",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && /repos\/acme\/demo\/issues\/61\/comments\?per_page=100&page=1/.test(String(args[1] ?? ""))) {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/61/comments"
      ) {
        return { stdout: JSON.stringify({ id: 1 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--skip-review-gate"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: already open #61 https://example.test/pull/61"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("autofills rationale placeholders on existing PR body", async () => {
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
              number: 66,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/66",
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
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: [
              "## Summary",
              "- Existing",
              "",
              "## Architecture decisions",
              "- TODO: fill architecture",
              "",
              "## Why these decisions were made",
              "- TODO: fill why",
              "",
              "## Alternatives considered / rejected",
              "- TODO: fill alternatives",
              "",
              "## Extra section",
              "- keep me",
              "",
              "Fixes #6",
            ].join("\n"),
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
        const bodyIndex = args.findIndex((entry) => entry === "--body");
        const body = bodyIndex >= 0 ? String(args[bodyIndex + 1] ?? "") : "";
        expect(body).toContain("## Architecture decisions");
        expect(body).toContain("## Why these decisions were made");
        expect(body).toContain("## Alternatives considered / rejected");
        expect(body).not.toContain("TODO:");
        expect(body).toContain("## Extra section");
        expect(body).toContain("Fixes #6");
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && /repos\/acme\/demo\/issues\/66\/comments\?per_page=100&page=1/.test(String(args[1] ?? ""))) {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/66/comments"
      ) {
        return { stdout: JSON.stringify({ id: 2 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--skip-review-gate"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr open: rationale sections autofilled in existing PR body."))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "edit",
      ),
    ).toBe(true);
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
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && /repos\/acme\/demo\/issues\/62\/comments\?per_page=100&page=1/.test(String(args[1] ?? ""))) {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/62/comments"
      ) {
        return { stdout: JSON.stringify({ id: 1 }) };
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
      "--skip-review-gate",
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
      "--skip-review-gate",
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

  it("skips auto-review when current head already has a review marker", async () => {
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
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body\n\n## Architecture decisions\n- done",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              body: "<!-- vibe:review-summary -->\n<!-- vibe:review-head:abc123def -->\nsummary",
            },
          ]),
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
    expect(logs.some((line) => line.includes("review gate satisfied for HEAD abc123def"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
  });

  it("skips auto-review when head marker and matching policy marker are present", async () => {
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
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body\n\n## Architecture decisions\n- done",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              body: `<!-- vibe:review-summary -->\\n<!-- vibe:review-head:abc123def -->\\n<!-- vibe:review-policy:${PR_OPEN_POLICY_KEY} -->\\nsummary`,
            },
          ]),
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
    expect(logs.some((line) => line.includes("review gate satisfied for HEAD abc123def"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
  });

  it("reruns review when policy marker exists but does not match gate policy", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const mismatchedPolicyKey = buildReviewPolicyKey({
      autofix: false,
      autopush: true,
      publish: true,
      strict: false,
      maxAttempts: 5,
    });
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "issue-6-vibe-pr-open\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
            milestone: null,
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 61,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/61",
              headRefOid: "abc123",
              body: "Fixes #6",
              baseRefName: "main",
            },
          ]),
        };
      }
      if (cmd === "zsh") {
        return { stdout: buildAgentOutput("run-pr-open-policy-mismatch") };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "abc123def" }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              body: `<!-- vibe:review-summary -->\\n<!-- vibe:review-head:abc123def -->\\n<!-- vibe:review-policy:${mismatchedPolicyKey} -->\\nsummary`,
            },
          ]),
        };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "PATCH" &&
        args[3] === "repos/acme/demo/issues/comments/10"
      ) {
        return { stdout: JSON.stringify({ id: 10 }) };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/61/comments"
      ) {
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/61/comments?per_page=100&page=1") {
        return { stdout: "[]" };
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
    expect(logs.some((line) => line.includes("review gate missing for HEAD abc123def"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(true);
  });

  it("reruns review when --force-review is set even if gate markers match", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "issue-6-vibe-pr-open\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
            milestone: null,
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 61,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/61",
              headRefOid: "abc123",
              body: "Fixes #6",
              baseRefName: "main",
            },
          ]),
        };
      }
      if (cmd === "zsh") {
        return { stdout: buildAgentOutput("run-pr-open-forced") };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "abc123def" }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              body: `<!-- vibe:review-summary -->\\n<!-- vibe:review-head:abc123def -->\\n<!-- vibe:review-policy:${PR_OPEN_POLICY_KEY} -->\\nsummary`,
            },
          ]),
        };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "PATCH" &&
        args[3] === "repos/acme/demo/issues/comments/10"
      ) {
        return { stdout: JSON.stringify({ id: 10 }) };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/61/comments"
      ) {
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/61/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--force-review"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("--force-review set"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(true);
  });

  it("runs auto-review when gate marker is missing for HEAD", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "issue-6-vibe-pr-open\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
            milestone: null,
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 61,
              title: "feat: add vibe pr open command",
              url: "https://example.test/pull/61",
              headRefOid: "abc123",
              body: "Fixes #6",
              baseRefName: "main",
            },
          ]),
        };
      }
      if (cmd === "zsh") {
        return { stdout: buildAgentOutput("run-pr-open-gate") };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "abc123def" }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/61/comments"
      ) {
        return { stdout: JSON.stringify({ id: 9001 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/61/comments?per_page=100&page=1") {
        return { stdout: "[]" };
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
    expect(logs.some((line) => line.includes("review gate missing for HEAD abc123def"))).toBe(true);
    expect(logs.some((line) => line.includes("review gate complete attempts=1 unresolved=0"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(true);
  });

  it("supports --skip-review-gate with auditable PR marker comment", async () => {
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
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/61/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/61/comments"
      ) {
        expect(args.join(" ")).toContain("vibe:review-gate-skipped");
        return { stdout: JSON.stringify({ id: 9010 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--skip-review-gate"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review gate skipped for HEAD abc123def"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
  });

  it("fails when --skip-review-gate and --force-review are combined", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--skip-review-gate", "--force-review"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--skip-review-gate and --force-review cannot be combined"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("uses target branch HEAD for gate checks when --branch differs from checkout", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 81,
              title: "feat: target branch PR",
              url: "https://example.test/pull/81",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "target branch issue",
            url: "https://example.test/issues/6",
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "feature/custom") {
        return { stdout: "abcdef1234567890\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/81/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 1,
              body: "<!-- vibe:review-summary -->\n<!-- vibe:review-head:abcdef1234567890 -->\nsummary",
            },
          ]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--issue", "6", "--branch", "feature/custom"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("review gate satisfied for HEAD abcdef123456"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "rev-parse" && args[1] === "feature/custom",
      ),
    ).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
  });

  it("fails gate if target branch is not checked out before mutable auto-review", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 82,
              title: "feat: target branch PR",
              url: "https://example.test/pull/82",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "target branch issue",
            url: "https://example.test/issues/6",
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "## Summary\n- Existing body",
          }),
        };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "feature/custom") {
        return { stdout: "targetsha1234567890\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/82/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--issue", "6", "--branch", "feature/custom"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("targets branch 'feature/custom' but current branch is 'main'"))).toBe(true);
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(false);
  });

  it("runs review in dry-run mode when gate is active", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "issue-6-vibe-pr-open\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] !== "--abbrev-ref") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
            milestone: null,
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "zsh") {
        return { stdout: buildAgentOutput("run-pr-open-gate-dry") };
      }
      throw new Error(`unexpected command in dry-run: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "zsh")).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          ((args[0] === "api" && args[1] === "--method") || (args[0] === "pr" && args[1] === "review")),
      ),
    ).toBe(false);
  });

  it("fails when auto-review fails after PR creation and keeps PR open", async () => {
    process.env.VIBE_REVIEW_AGENT_CMD = "cat";
    await writeTurnContext({
      issue_id: 6,
      branch: "issue-6-vibe-pr-open",
      base_branch: "main",
      started_at: "2026-02-16T00:00:00.000Z",
      issue_title: "vibe pr open",
    });
    mkdirSync(path.join(tempDir, ".vibe", "artifacts"), { recursive: true });
    writeFileSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");

    const logs: string[] = [];
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "issue-6-vibe-pr-open\n" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "abc123def\n" };
      }
      if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "feat: add vibe pr open command with issue linkage",
            url: "https://example.test/issues/6",
            milestone: null,
          }),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://example.test/pull/70\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/70/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (cmd === "zsh") {
        return { stdout: "invalid-json" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "open"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((line) => line.includes("pr open: created #70 https://example.test/pull/70"))).toBe(true);
    expect(errors.some((line) => line.includes("pr open: ERROR"))).toBe(true);
  });
});
