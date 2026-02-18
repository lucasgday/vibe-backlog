import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { PR_READY_FREEZE_GUIDANCE } from "../src/core/pr-ready";
import { PR_OPEN_REVIEW_GATE_POLICY_KEY, REVIEW_SUMMARY_MARKER } from "../src/core/review-pr";

function buildReviewSummaryBody(headSha: string): string {
  return [
    REVIEW_SUMMARY_MARKER,
    `<!-- vibe:review-head:${headSha.toLowerCase()} -->`,
    `<!-- vibe:review-policy:${PR_OPEN_REVIEW_GATE_POLICY_KEY} -->`,
    "summary",
  ].join("\n");
}

describe.sequential("cli pr ready", () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("prints READY output with freeze guidance", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "ready", "--pr", "99"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("pr ready: READY #99 https://example.test/pull/99"))).toBe(true);
    expect(logs.some((line) => line.includes(PR_READY_FREEZE_GUIDANCE))).toBe(true);
  });

  it("prints NOT READY with remediation command on stale merge state", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "UNKNOWN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "ready", "--pr", "99"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((line) => line.includes("pr ready: NOT READY #99 https://example.test/pull/99"))).toBe(true);
    expect(logs.some((line) => line.includes("Remediation: node dist/cli.cjs pr ready --pr 99 --refresh --wait-seconds 30"))).toBe(
      true,
    );
  });

  it("validates --pr as positive integer", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "ready", "--pr", "abc"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("pr ready: --pr must be a positive integer."))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("resolves target PR by branch when --pr is omitted", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ number: 56, url: "https://example.test/pull/56" }]),
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 56,
            url: "https://example.test/pull/56",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/56/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "pr", "ready", "--branch", "codex/issue-56-pr-ready-merge-readiness"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          args[0] === "pr" &&
          args[1] === "list" &&
          args[2] === "--head" &&
          args[3] === "codex/issue-56-pr-ready-merge-readiness",
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("pr ready: READY #56 https://example.test/pull/56"))).toBe(true);
  });
});
