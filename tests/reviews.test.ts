import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureIssueReviewTemplates, getIssueReviewDirectory, REVIEW_TEMPLATE_FILE_NAMES } from "../src/core/reviews";

describe.sequential("review templates", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-reviews-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates per-issue review templates deterministically", async () => {
    const result = await ensureIssueReviewTemplates(12);

    expect(result.directory).toBe(getIssueReviewDirectory(12));
    expect(result.created).toHaveLength(REVIEW_TEMPLATE_FILE_NAMES.length);
    expect(result.unchanged).toEqual([]);

    for (const fileName of REVIEW_TEMPLATE_FILE_NAMES) {
      const filePath = path.join(result.directory, fileName);
      expect(existsSync(filePath)).toBe(true);
    }

    expect(readFileSync(path.join(result.directory, "implementation.md"), "utf8")).toContain("# Implementation Pass");
    expect(readFileSync(path.join(result.directory, "security.md"), "utf8")).toContain("# Security Pass");
    expect(readFileSync(path.join(result.directory, "quality.md"), "utf8")).toContain("# Quality Pass");
    expect(readFileSync(path.join(result.directory, "ux.md"), "utf8")).toContain("# UX Pass");
    expect(readFileSync(path.join(result.directory, "growth.md"), "utf8")).toContain("# Growth Pass");
    expect(readFileSync(path.join(result.directory, "ops.md"), "utf8")).toContain("# Ops Pass");
  });

  it("is idempotent and never overwrites existing review files", async () => {
    await ensureIssueReviewTemplates(12);

    const securityPath = path.join(getIssueReviewDirectory(12), "security.md");
    const customContent = "# Custom Security Notes\n\nKeep this content.\n";
    writeFileSync(securityPath, customContent, "utf8");

    const result = await ensureIssueReviewTemplates(12);

    expect(result.created).toEqual([]);
    expect(result.unchanged).toHaveLength(REVIEW_TEMPLATE_FILE_NAMES.length);
    expect(readFileSync(securityPath, "utf8")).toBe(customContent);
  });
});
