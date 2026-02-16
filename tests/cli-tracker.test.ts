import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTrackerBootstrapMarkerPath } from "../src/core/tracker";

describe.sequential("cli tracker bootstrap", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-tracker-test-"));
    process.chdir(tempDir);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints deterministic dry-run commands without creating marker", async () => {
    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/milestones?state=all&per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/labels?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "bootstrap", "--dry-run"]);

    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(logs.some((line) => line.includes("$ gh api --method POST repos/acme/demo/milestones"))).toBe(true);
    expect(logs.some((line) => line.includes("$ gh label create module:cli"))).toBe(true);
    expect(logs.some((line) => line.includes("tracker bootstrap: dry-run complete."))).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(getTrackerBootstrapMarkerPath())).toBe(false);
  });

  it("creates missing tracker taxonomy and writes marker on apply", async () => {
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/milestones?state=all&per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ title: "UI MVP (local cockpit)" }]),
        };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/labels?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ name: "module:ui" }]),
        };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "bootstrap"]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(
      commands.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "--method" &&
          args[2] === "POST" &&
          args[3] === "repos/acme/demo/milestones",
      ),
    ).toBe(true);
    expect(
      commands.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:cli"),
    ).toBe(true);
    expect(
      commands.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:ui"),
    ).toBe(false);
    expect(existsSync(getTrackerBootstrapMarkerPath())).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("paginates labels and skips creating module label that exists on later page", async () => {
    const labelPageOne = Array.from({ length: 100 }, (_unused, index) => ({ name: `custom-${index}` }));
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/milestones?state=all&per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/labels?per_page=100&page=1") {
        return { stdout: JSON.stringify(labelPageOne) };
      }
      if (args[0] === "api" && args[1] === "repos/acme/demo/labels?per_page=100&page=2") {
        return { stdout: JSON.stringify([{ name: "module:cli" }]) };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "bootstrap"]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(
      commands.some(([cmd, args]) => cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/labels?per_page=100&page=2"),
    ).toBe(true);
    expect(
      commands.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:cli"),
    ).toBe(false);
    expect(
      commands.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:tracker"),
    ).toBe(true);
  });

  it("shows preflight hint when .vibe exists without tracker marker", async () => {
    mkdirSync(path.join(tempDir, ".vibe"), { recursive: true });
    const logs: string[] = [];
    const execaMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        return { stdout: "## main" };
      }
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: "1\tOPEN\tfeat: something" };
      }
      return { stdout: "" };
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "preflight"]);

    expect(logs.some((line) => line.includes("Tracker bootstrap suggested:"))).toBe(true);
    expect(logs.some((line) => line.includes("Run: node dist/cli.cjs tracker bootstrap --dry-run"))).toBe(true);
    expect(logs.some((line) => line.includes("Then: node dist/cli.cjs tracker bootstrap"))).toBe(true);
  });
});
