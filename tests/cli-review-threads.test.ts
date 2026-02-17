import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";

function buildThreadsGraphqlResponse(threads: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads,
          },
        },
      },
    },
  });
}

function buildThread(id: string): Record<string, unknown> {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [
        {
          id: `comment-${id}`,
          body: "**[P2] Validate input**\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
          url: `https://example.test/comment/${id}`,
          path: "src/cli-program.ts",
          line: 42,
          originalLine: 42,
          author: { login: "bot" },
        },
      ],
    },
  };
}

describe.sequential("cli review threads resolve", () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("fails when no target mode is provided", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "threads", "resolve"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("provide exactly one target mode"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("fails when --all-unresolved and --thread-id are combined", async () => {
    const errors: string[] = [];
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "threads", "resolve", "--all-unresolved", "--thread-id", "PRRT_1"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("provide exactly one target mode"))).toBe(true);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("supports dry-run batch mode with inferred PR number", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/threads\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify([{ number: 51 }]) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return { stdout: buildThreadsGraphqlResponse([buildThread("PRRT_1")]) };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "threads", "resolve", "--all-unresolved", "--dry-run"]);

    expect(errors).toEqual([]);
    expect(process.exitCode, `logs=${logs.join(" || ")}`).toBeUndefined();
    expect(logs.some((line) => line.includes("review threads resolve: pr=#51"))).toBe(true);
    expect(logs.some((line) => line.includes("planned=1"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          Array.isArray(args) &&
          args[0] === "api" &&
          args[1] === "graphql" &&
          args.some((entry) => String(entry).includes("addPullRequestReviewThreadReply")),
      ),
    ).toBe(false);
  });

  it("resolves a single thread and reports failure exit code when thread is missing", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/threads\n" };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return { stdout: buildThreadsGraphqlResponse([buildThread("PRRT_1")]) };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "threads", "resolve", "--pr", "51", "--thread-id", "PRRT_missing"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((line) => line.includes("FAILED"))).toBe(true);
  });

  it("posts reply + resolve in single-thread mode", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/threads\n" };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return { stdout: buildThreadsGraphqlResponse([buildThread("PRRT_1")]) };
        }
        if (queryArg.includes("addPullRequestReviewThreadReply")) {
          return {
            stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://example.test/reply/1" } } } }),
          };
        }
        if (queryArg.includes("resolveReviewThread")) {
          return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }) };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "review", "threads", "resolve", "--pr", "51", "--thread-id", "PRRT_1", "--body", "manual"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("resolved=1"))).toBe(true);
  });
});
