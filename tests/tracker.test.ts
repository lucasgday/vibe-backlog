import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getTrackerBootstrapMarkerPath,
  selectMissingTrackerLabels,
  selectMissingTrackerMilestones,
  shouldSuggestTrackerBootstrap,
  writeTrackerBootstrapMarker,
} from "../src/core/tracker";

describe.sequential("tracker bootstrap core", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-tracker-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("selects missing milestones and labels deterministically", () => {
    const missingMilestones = selectMissingTrackerMilestones(["UI MVP (local cockpit)"]);
    const missingLabels = selectMissingTrackerLabels(["module:ui", "module:docs"]);

    expect(missingMilestones.map((item) => item.title)).toEqual(["CLI usable (repos con .vibe)"]);
    expect(missingLabels.map((item) => item.name)).toEqual([
      "module:cli",
      "module:tracker",
      "module:turn",
      "module:templates",
    ]);
  });

  it("suggests bootstrap only when .vibe exists and marker is missing", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    expect(await shouldSuggestTrackerBootstrap()).toBe(true);

    await writeTrackerBootstrapMarker("acme/demo");
    expect(await shouldSuggestTrackerBootstrap()).toBe(false);
  });

  it("writes tracker bootstrap marker with repository metadata", async () => {
    const markerPath = await writeTrackerBootstrapMarker("acme/demo");
    expect(markerPath).toBe(getTrackerBootstrapMarkerPath());

    const payload = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(payload.version).toBe(1);
    expect(payload.repository).toBe("acme/demo");
    expect(Array.isArray(payload.milestones)).toBe(true);
    expect(Array.isArray(payload.labels)).toBe(true);
  });
});
