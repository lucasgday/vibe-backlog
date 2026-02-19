import { describe, expect, it, vi } from "vitest";

import { resolveReviewThreads, summarizeReviewThreadLifecycleTotals } from "../src/core/review-threads";

function buildThreadPayload(params: {
  id: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  body?: string;
  path?: string;
  line?: number;
  authorLogin?: string;
  extraComments?: Array<{
    id: string;
    body: string;
    url: string;
    path: string;
    line: number;
    originalLine: number;
    authorLogin: string;
  }>;
}): Record<string, unknown> {
  return {
    id: params.id,
    isResolved: params.isResolved ?? false,
    isOutdated: params.isOutdated ?? false,
    comments: {
      nodes: [
        {
          id: `comment-${params.id}`,
          body:
            params.body ??
            "**[P2] Validate input paths**\n\nPath sanitization is required.\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
          url: `https://example.test/comment/${params.id}`,
          path: params.path ?? "src/cli-program.ts",
          line: params.line ?? 42,
          originalLine: params.line ?? 42,
          author: { login: params.authorLogin ?? "review-bot" },
        },
        ...((params.extraComments ?? []).map((comment) => ({
          id: comment.id,
          body: comment.body,
          url: comment.url,
          path: comment.path,
          line: comment.line,
          originalLine: comment.originalLine,
          author: { login: comment.authorLogin },
        })) as Array<Record<string, unknown>>),
      ],
    },
  };
}

function buildThreadsGraphqlResponse(threads: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
            nodes: threads,
          },
        },
      },
    },
  });
}

describe("review threads resolve core", () => {
  it("summarizes lifecycle totals by fingerprint with unresolved precedence", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([
              buildThreadPayload({
                id: "PRRT_unresolved",
                isResolved: false,
                body:
                  "**[P2] Validate input paths**\n\nPath sanitization is required.\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
              }),
              buildThreadPayload({
                id: "PRRT_resolved_same_fingerprint",
                isResolved: true,
                body:
                  "**[P2] Validate input paths**\n\nPath sanitization is required.\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
              }),
              buildThreadPayload({
                id: "PRRT_resolved_unique",
                isResolved: true,
                body:
                  "**[P2] Add retry guard**\n\nTimeouts need retry.\n\nPass: `ops`\n\n<!-- vibe:fingerprint:def456abc123 -->",
              }),
            ]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const totals = await summarizeReviewThreadLifecycleTotals(
      {
        prNumber: 51,
      },
      execaMock as never,
    );

    expect(totals).toEqual({
      observed: 2,
      unresolved: 1,
      resolved: 1,
      unresolvedSeverity: {
        P0: 0,
        P1: 0,
        P2: 1,
        P3: 0,
      },
      unresolvedFindingKeys: ["fingerprint:abc123def456"],
      resolvedFindingKeys: ["fingerprint:def456abc123"],
    });
  });

  it("plans dry-run for all unresolved threads without mutations", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/dedupe\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify([{ number: 51 }]) };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([
              buildThreadPayload({ id: "PRRT_1", isResolved: false }),
              buildThreadPayload({ id: "PRRT_2", isResolved: true }),
            ]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: null,
        threadIds: [],
        allUnresolved: true,
        bodyOverride: null,
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.prNumber).toBe(51);
    expect(result.planned).toBe(1);
    expect(result.selectedThreads).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.items[0]?.planned).toBe(true);
    expect(result.items[0]?.title).toContain("Validate input paths");
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

  it("filters unresolved selection to vibe-managed threads when requested", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([
              buildThreadPayload({ id: "PRRT_vibe", isResolved: false }),
              buildThreadPayload({
                id: "PRRT_human",
                isResolved: false,
                body: "**Nit**\n\nCan we rename this variable?",
              }),
            ]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: [],
        allUnresolved: true,
        bodyOverride: null,
        dryRun: true,
        vibeManagedOnly: true,
      },
      execaMock as never,
    );

    expect(result.totalThreads).toBe(2);
    expect(result.selectedThreads).toBe(1);
    expect(result.planned).toBe(1);
    expect(result.items[0]?.threadId).toBe("PRRT_vibe");
  });

  it("does not auto-select mixed human+bot threads when vibeManagedOnly is enabled", async () => {
    const mixedThread = {
      id: "PRRT_mixed",
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            id: "comment-bot",
            body: "**[P2] Validate input paths**\n\nPass: `security`\n\n<!-- vibe:fingerprint:abc123def456 -->",
            url: "https://example.test/comment/mixed-bot",
            path: "src/cli-program.ts",
            line: 42,
            originalLine: 42,
            author: { login: "review-bot" },
          },
          {
            id: "comment-human",
            body: "I still see this reproducing in edge case X.",
            url: "https://example.test/comment/mixed-human",
            path: "src/cli-program.ts",
            line: 42,
            originalLine: 42,
            author: { login: "human-reviewer" },
          },
        ],
      },
    };

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([mixedThread]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: [],
        allUnresolved: true,
        bodyOverride: null,
        dryRun: true,
        vibeManagedOnly: true,
      },
      execaMock as never,
    );

    expect(result.totalThreads).toBe(1);
    expect(result.selectedThreads).toBe(0);
    expect(result.planned).toBe(0);
  });

  it("selects connector-authored unresolved threads when vibeManagedOnly is enabled", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([
              buildThreadPayload({
                id: "PRRT_connector",
                isResolved: false,
                authorLogin: "chatgpt-codex-connector",
                body:
                  "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Keep non-growth findings in follow-up issue payload**",
              }),
              buildThreadPayload({
                id: "PRRT_other",
                isResolved: false,
                authorLogin: "human-reviewer",
                body: "**Nit**\n\nCan we rename this variable?",
              }),
            ]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: [],
        allUnresolved: true,
        bodyOverride: null,
        dryRun: true,
        vibeManagedOnly: true,
      },
      execaMock as never,
    );

    expect(result.totalThreads).toBe(2);
    expect(result.selectedThreads).toBe(1);
    expect(result.planned).toBe(1);
    expect(result.items[0]?.threadId).toBe("PRRT_connector");
  });

  it("replies and resolves a single thread using override body", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/dedupe\n" };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([buildThreadPayload({ id: "PRRT_1", isResolved: false })]),
          };
        }
        if (queryArg.includes("addPullRequestReviewThreadReply")) {
          expect(args.join(" ")).toContain("body=manual override");
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

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: ["PRRT_1"],
        allUnresolved: false,
        bodyOverride: "manual override",
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.replied).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.items[0]?.replyUrl).toBe("https://example.test/reply/1");
    expect(result.items[0]?.resolved).toBe(true);
  });

  it("marks missing thread ids as failed without mutating", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/dedupe\n" };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([buildThreadPayload({ id: "PRRT_existing", isResolved: false })]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: ["PRRT_missing"],
        allUnresolved: false,
        bodyOverride: null,
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.failed).toBe(1);
    expect(result.items[0]?.reason).toContain("not found");
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

  it("reports failure when resolve mutation does not resolve thread", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/dedupe\n" };
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([buildThreadPayload({ id: "PRRT_1", isResolved: false })]),
          };
        }
        if (queryArg.includes("addPullRequestReviewThreadReply")) {
          return {
            stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://example.test/reply/1" } } } }),
          };
        }
        if (queryArg.includes("resolveReviewThread")) {
          return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } } }) };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: ["PRRT_1"],
        allUnresolved: false,
        bodyOverride: null,
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.replied).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.items[0]?.failed).toBe(true);
  });

  it("does not require resolving current branch when --pr is provided", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        throw new Error("should not resolve current branch when prNumber is set");
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") return { stdout: "acme/demo\n" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "abcdef1234567890" }) };
      if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("reviewThreads(first:100")) {
          return {
            stdout: buildThreadsGraphqlResponse([buildThreadPayload({ id: "PRRT_1", isResolved: false })]),
          };
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await resolveReviewThreads(
      {
        prNumber: 51,
        threadIds: ["PRRT_1"],
        allUnresolved: false,
        bodyOverride: null,
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.prNumber).toBe(51);
    expect(result.branch).toBe(null);
    expect(result.planned).toBe(1);
  });
});
