import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTrackerBootstrapMarkerPath } from "../src/core/tracker";

describe.sequential("cli init", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-init-test-"));
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

  it("initializes empty repo scaffold and runs tracker bootstrap", async () => {
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

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "init"]);

    expect(existsSync(path.join(tempDir, ".vibe", "contract.yml"))).toBe(true);
    expect(existsSync(path.join(tempDir, ".vibe", "ownership.yml"))).toBe(true);
    expect(existsSync(path.join(tempDir, ".vibe", "artifacts", "postflight.json"))).toBe(true);
    expect(existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true);
    expect(readFileSync(path.join(tempDir, "AGENTS.md"), "utf8")).toContain("<!-- vibe:agent-snippet:start -->");
    expect(readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toContain(".vibe/runtime");
    expect(existsSync(getTrackerBootstrapMarkerPath())).toBe(true);

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
    expect(process.exitCode).toBeUndefined();
  });

  it("is idempotent and does not overwrite existing postflight artifact", async () => {
    writeFileSync(path.join(tempDir, "AGENTS.md"), "# Custom\n", "utf8");
    writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n", "utf8");

    const customPostflight = '{"version":1,"custom":true}\n';
    const postflightPath = path.join(tempDir, ".vibe", "artifacts", "postflight.json");
    // First run creates scaffold.
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "init", "--skip-tracker"]);
    writeFileSync(postflightPath, customPostflight, "utf8");

    // Second run should preserve existing files and keep one managed snippet block.
    await program.parseAsync(["node", "vibe", "init", "--skip-tracker"]);

    expect(readFileSync(postflightPath, "utf8")).toBe(customPostflight);
    const agents = readFileSync(path.join(tempDir, "AGENTS.md"), "utf8");
    expect((agents.match(/<!-- vibe:agent-snippet:start -->/g) ?? []).length).toBe(1);
    expect(agents).toContain("# Custom");
    expect(readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toContain(".vibe/artifacts");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("supports dry-run without touching filesystem", async () => {
    const execaMock = vi.fn(async () => ({ stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "init", "--dry-run", "--skip-tracker"]);

    expect(existsSync(path.join(tempDir, ".vibe"))).toBe(false);
    expect(existsSync(path.join(tempDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(tempDir, ".gitignore"))).toBe(false);
  });
});
