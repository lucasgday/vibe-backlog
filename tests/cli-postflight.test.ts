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

    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["issue", "comment", "2", "--body", "Done."],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
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
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

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
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ body: "Implement turn context" }) };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["issue", "comment", "2", "--body", "Linked PR: #7"],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(2, "gh", ["pr", "view", "7", "--json", "body,url"], { stdio: "pipe" });
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
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
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ body: "Implement turn context\n\nFixes #2" }) };
      }
      return { stdout: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply"]);

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["issue", "comment", "2", "--body", "Linked PR: #7"],
      { stdio: "inherit" },
    );
    expect(execaMock).toHaveBeenNthCalledWith(2, "gh", ["pr", "view", "7", "--json", "body,url"], { stdio: "pipe" });
    expect(process.exitCode).toBeUndefined();
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
    await program.parseAsync(["node", "vibe", "postflight", "--file", postflightPath, "--apply", "--dry-run"]);

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
