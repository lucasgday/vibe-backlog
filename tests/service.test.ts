import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getBacklogFilePath, readBacklog, saveBacklog } from "../src/core/service";

describe.sequential("vibe backlog service", () => {
  const originalCwd = process.cwd();
  const originalVibePath = process.env.VIBE_BACKLOG_PATH;
  const originalFeatherlistPath = process.env.FEATHERLIST_BACKLOG_PATH;
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-backlog-test-"));
    process.chdir(tempDir);
    delete process.env.VIBE_BACKLOG_PATH;
    delete process.env.FEATHERLIST_BACKLOG_PATH;
  });

  afterEach(() => {
    process.env.VIBE_BACKLOG_PATH = originalVibePath;
    process.env.FEATHERLIST_BACKLOG_PATH = originalFeatherlistPath;
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates and reads default backlog file", async () => {
    const doc = await readBacklog();

    expect(path.basename(doc.path)).toBe("BACKLOG.md");
    expect(doc.markdown).toContain("# Featherlist Backlog");
    expect(doc.lastModified).toBeTruthy();
  });

  it("saves markdown and normalizes trailing newline", async () => {
    const saved = await saveBacklog("## Hola");
    expect(saved.markdown.endsWith("\n")).toBe(true);

    const persisted = readFileSync(saved.path, "utf8");
    expect(persisted).toBe("## Hola\n");
  });

  it("allows custom markdown file path inside workspace", () => {
    process.env.VIBE_BACKLOG_PATH = "./docs/my-backlog.md";
    const resolved = getBacklogFilePath();

    expect(path.basename(resolved)).toBe("my-backlog.md");
    expect(resolved.endsWith(path.join("docs", "my-backlog.md"))).toBe(true);
  });

  it("supports FEATHERLIST_BACKLOG_PATH as compatibility fallback", () => {
    process.env.FEATHERLIST_BACKLOG_PATH = "./docs/legacy-backlog.md";
    const resolved = getBacklogFilePath();

    expect(path.basename(resolved)).toBe("legacy-backlog.md");
    expect(resolved.endsWith(path.join("docs", "legacy-backlog.md"))).toBe(true);
  });

  it("rejects paths outside workspace", () => {
    process.env.VIBE_BACKLOG_PATH = "../outside.md";
    expect(() => getBacklogFilePath()).toThrow("inside workspace");
  });
});

