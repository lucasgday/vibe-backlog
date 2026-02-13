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
});
