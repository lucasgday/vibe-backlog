import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";

describe.sequential("cli postflight --apply", () => {
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-test-"));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies tracker updates including issue_close via gh commands", async () => {
    const postflightPath = path.join(tempDir, "postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [
            { type: "comment_append", body: "Done." },
            { type: "issue_close", body: "Closed by postflight." },
          ],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["pr", "list", "--head", "issue-2-example", "--state", "open", "--json", "number"],
      { stdio: "pipe" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["issue", "comment", "2", "--body", "Done."],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "gh",
      ["issue", "close", "2", "--comment", "Closed by postflight."],
      { stdio: "inherit" },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects non-numeric issue_id before applying updates", async () => {
    const postflightPath = path.join(tempDir, "invalid-issue-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: "2abc",
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "issue_close", body: "Closed by postflight." }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(execaMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("links PR body with Fixes token when link_pr is present", async () => {
    const postflightPath = path.join(tempDir, "link-pr-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "link_pr", pr_number: 7 }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ body: "Implement turn context" }) };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(execaMock).toHaveBeenCalledTimes(4);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["pr", "list", "--head", "issue-2-example", "--state", "open", "--json", "number"],
      { stdio: "pipe" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["issue", "comment", "2", "--body", "Linked PR: #7"],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(3, "gh", ["pr", "view", "7", "--json", "body,url"], { stdio: "pipe" });
    expect(execaMock).toHaveBeenNthCalledWith(
      4,
      "gh",
      ["pr", "edit", "7", "--body", "Implement turn context\n\nFixes #2"],
      { stdio: "inherit" },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("does not rewrite PR body when issue link already exists", async () => {
    const postflightPath = path.join(tempDir, "link-pr-existing-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "link_pr", pr_number: 7 }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ body: "Implement turn context\n\nFixes #2" }) };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["pr", "list", "--head", "issue-2-example", "--state", "open", "--json", "number"],
      { stdio: "pipe" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["issue", "comment", "2", "--body", "Linked PR: #7"],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(3, "gh", ["pr", "view", "7", "--json", "body,url"], { stdio: "pipe" });
    expect(process.exitCode).toBeUndefined();
  });

  it("blocks postflight apply when open PR head has no review marker", async () => {
    const postflightPath = path.join(tempDir, "review-gate-missing-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "Done." }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const errors: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 7 }]) };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "abc123def456" }) };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/issues/7/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        throw new Error("should not apply updates when review gate fails");
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("review gate missing"))).toBe(true);
  });

  it("allows postflight apply when review marker exists for open PR head", async () => {
    const postflightPath = path.join(tempDir, "review-gate-ok-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "Done." }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 7 }]) };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "abc123def456" }) };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/issues/7/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 1,
              body: "<!-- vibe:review-summary -->\n<!-- vibe:review-head:abc123def456 -->\nsummary",
            },
          ]),
        };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        return { stdout: "" };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "issue" && args[1] === "comment",
      ),
    ).toBe(true);
  });

  it("review gate uses PR headRefOid without requiring local branch ref", async () => {
    const postflightPath = path.join(tempDir, "review-gate-remote-branch-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "feature/non-local-branch",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "Done." }],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 9 }]) };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "f00dbabe1234" }) };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/issues/9/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              id: 1,
              body: "<!-- vibe:review-summary -->\n<!-- vibe:review-head:f00dbabe1234 -->\nsummary",
            },
          ]),
        };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        return { stdout: "" };
      }
      if (args[0] === "rev-parse") {
        throw new Error("should not read local ref for review gate");
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "rev-parse",
      ),
    ).toBe(false);
  });

  it("runs automatic branch cleanup even when tracker updates are empty", async () => {
    const postflightPath = path.join(tempDir, "cleanup-auto-no-updates.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-17T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "" }],
          next_actions: ["Cleanup branches."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Recreate branch from remote if needed.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "for-each-ref") return { stdout: "feature/merged\torigin/feature/merged\t[gone]\nmain\torigin/main\t" };
      if (args[0] === "merge-base") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature/merged") return { stdout: "" };
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

    expect(process.exitCode).toBeUndefined();
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "git" && Array.isArray(args) && args[0] === "branch" && args[1] === "-d" && args[2] === "feature/merged",
      ),
    ).toBe(true);
  });

  it("supports postflight --apply --dry-run cleanup planning without deleting branches", async () => {
    const postflightPath = path.join(tempDir, "cleanup-auto-dry-run.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-17T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "" }],
          next_actions: ["Cleanup branches."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Recreate branch from remote if needed.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "for-each-ref") return { stdout: "feature/merged\torigin/feature/merged\t[gone]" };
      if (args[0] === "merge-base") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--dry-run"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("postflight --apply: branch cleanup"))).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "fetch" && args[1] === "--prune",
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "branch" && (args[1] === "-d" || args[1] === "-D"),
      ),
    ).toBe(false);
  });

  it("skips automatic cleanup when --skip-branch-cleanup is provided", async () => {
    const postflightPath = path.join(tempDir, "cleanup-skip.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-17T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "" }],
          next_actions: ["Cleanup branches."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Recreate branch from remote if needed.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--skip-branch-cleanup"]);

    expect(process.exitCode).toBeUndefined();
    expect(execaMock.mock.calls.some(([cmd]) => cmd === "git")).toBe(false);
  });

  it("warns and continues when automatic branch cleanup fails", async () => {
    const postflightPath = path.join(tempDir, "cleanup-warning.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-17T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [{ type: "comment_append", body: "" }],
          next_actions: ["Cleanup branches."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Recreate branch from remote if needed.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const errors: string[] = [];
    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "", stderr: "fatal: not a git repository", exitCode: 1 };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

    expect(process.exitCode).toBeUndefined();
    expect(errors.some((line) => line.includes("branch cleanup warning (continuing)"))).toBe(true);
    expect(logs.some((line) => line.includes("postflight --apply: DONE"))).toBe(true);
  });

  it("prints a deterministic dry-run command plan without executing gh", async () => {
    const postflightPath = path.join(tempDir, "dry-run-postflight.json");
    writeFileSync(
      postflightPath,
      JSON.stringify(
        {
          version: 1,
          meta: {
            timestamp: "2026-02-13T00:00:00.000Z",
            actor: "agent",
            mode: "cli",
          },
          work: {
            issue_id: 2,
            branch: "issue-2-example",
            base_branch: "main",
          },
          checks: {
            tests: {
              ran: true,
              result: "pass",
            },
          },
          tracker_updates: [
            { type: "comment_append", body: "Dry-run comment." },
            { type: "label_add", label: "status:in-review" },
            { type: "label_remove", label: "status:backlog" },
            { type: "status", to: "status:done" },
            { type: "link_pr", pr_number: 7 },
            { type: "issue_close", body: "Dry-run close." },
          ],
          next_actions: ["Merge branch."],
          risks: {
            summary: "Low risk.",
            rollback_plan: "Revert commit.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = vi.fn(async () => ({ stdout: "" }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync([
      "node",
      "vibe",
      "postflight",
      "--file",
      postflightPath,
      "--apply",
      "--dry-run",
      "--skip-branch-cleanup",
    ]);

    expect(execaMock).not.toHaveBeenCalled();
    expect(logs).toMatchInlineSnapshot(`
      [
        "postflight: OK",
        "issue: 2 | branch: issue-2-example",
        "
      Applying updates:",
        "$ gh issue comment 2 --body Dry-run comment.",
        "$ gh issue edit 2 --add-label status:in-review",
        "$ gh issue edit 2 --remove-label status:backlog",
        "$ gh issue edit 2 --add-label status:done",
        "$ gh issue comment 2 --body Linked PR: #7",
        "$ gh issue close 2 --comment Dry-run close.",
        "$ gh pr view 7 --json body,url",
        "$ gh pr edit 7 --body <existing-body>\\n\\nFixes #2",
        "
      postflight --apply: DONE",
      ]
    `);
    expect(process.exitCode).toBeUndefined();
  });
});
