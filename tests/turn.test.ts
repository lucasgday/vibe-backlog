import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildTurnBranch,
  clearTurnContext,
  getTurnContextPath,
  readTurnContext,
  slugifyTurnText,
  validateTurnContext,
  writeTurnContext,
} from "../src/core/turn";

describe.sequential("turn context", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-turn-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes and reads turn context in runtime folder", async () => {
    const startedAt = "2026-02-13T00:00:00.000Z";
    const payload = {
      issue_id: 2,
      branch: "issue-2-turn-context",
      base_branch: "main",
      started_at: startedAt,
      issue_title: "Turn context",
    };

    const filePath = await writeTurnContext(payload);
    expect(filePath).toBe(getTurnContextPath());

    const persisted = readFileSync(filePath, "utf8");
    expect(persisted).toContain('"issue_id": 2');

    const loaded = await readTurnContext();
    expect(loaded).toEqual(payload);
  });

  it("returns null when no active turn exists", async () => {
    const turn = await readTurnContext();
    expect(turn).toBeNull();
  });

  it("clears turn context file", async () => {
    await writeTurnContext({
      issue_id: 2,
      branch: "issue-2-turn-context",
      base_branch: "main",
      started_at: "2026-02-13T00:00:00.000Z",
      issue_title: "Turn context",
    });

    expect(await clearTurnContext()).toBe(true);
    expect(await readTurnContext()).toBeNull();
    expect(await clearTurnContext()).toBe(false);
  });

  it("slugifies titles and builds issue branch", () => {
    expect(slugifyTurnText("  Add New API: v2 (MVP)!  ")).toBe("add-new-api-v2-mvp");
    expect(buildTurnBranch(2, "Fix auth flow")).toBe("issue-2-fix-auth-flow");
    expect(buildTurnBranch(2, "###")).toBe("issue-2-issue-2");
  });

  it("validates required turn context fields", () => {
    expect(
      validateTurnContext({
        issue_id: 2,
        branch: "issue-2-turn-context",
        base_branch: "main",
      }),
    ).toEqual([]);

    expect(
      validateTurnContext({
        issue_id: 0,
        branch: "",
        base_branch: " ",
      }),
    ).toEqual(["issue_id", "branch", "base_branch"]);
  });
});
