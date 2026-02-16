import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli-program";
import { getTrackerBootstrapMarkerPath } from "../src/core/tracker";

type ApiIssueInput = {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  milestone: string | null;
  body?: string;
};

function apiIssue(input: ApiIssueInput): Record<string, unknown> {
  return {
    number: input.number,
    title: input.title,
    state: input.state,
    labels: input.labels.map((name) => ({ name })),
    milestone: input.milestone ? { title: input.milestone } : null,
    body: input.body ?? "",
  };
}

function createReconcileCliExecaMock(data: {
  repo: string;
  labels: string[];
  milestones: string[];
  issues: Record<string, unknown>[];
  failOn?: "labels" | "milestones" | "issues";
}) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "repo" && args[1] === "view") {
      return { stdout: `${data.repo}\n` };
    }

    if (args[0] === "api") {
      const endpoint = args[1] ?? "";

      if (data.failOn === "labels" && endpoint.startsWith(`repos/${data.repo}/labels?`)) {
        throw new Error("labels unavailable");
      }
      if (data.failOn === "milestones" && endpoint.startsWith(`repos/${data.repo}/milestones?`)) {
        throw new Error("milestones unavailable");
      }
      if (data.failOn === "issues" && endpoint.startsWith(`repos/${data.repo}/issues?`)) {
        throw new Error("issues unavailable");
      }

      if (endpoint === `repos/${data.repo}/labels?per_page=100&page=1`) {
        return { stdout: JSON.stringify(data.labels.map((name) => ({ name }))) };
      }
      if (endpoint.startsWith(`repos/${data.repo}/labels?`) && !endpoint.endsWith("page=1")) {
        return { stdout: "[]" };
      }

      if (endpoint === `repos/${data.repo}/milestones?state=all&per_page=100&page=1`) {
        return { stdout: JSON.stringify(data.milestones.map((title) => ({ title }))) };
      }
      if (endpoint.startsWith(`repos/${data.repo}/milestones?`) && !endpoint.endsWith("page=1")) {
        return { stdout: "[]" };
      }

      if (endpoint === `repos/${data.repo}/issues?state=all&per_page=100&page=1`) {
        return { stdout: JSON.stringify(data.issues) };
      }
      if (endpoint.startsWith(`repos/${data.repo}/issues?`) && !endpoint.endsWith("page=1")) {
        return { stdout: "[]" };
      }
    }

    if (args[0] === "issue" && args[1] === "edit") {
      return { stdout: "" };
    }

    if (args[0] === "label" && args[1] === "create") {
      return { stdout: "" };
    }

    return { stdout: "" };
  });
}

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
        return { stdout: JSON.stringify([{ name: "Module:CLI" }]) };
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
      if (args[0] === "issue" && args[1] === "list" && args[2] === "--state") {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              title: "feat: something",
              state: "OPEN",
              labels: [],
              milestone: null,
              updatedAt: "2026-02-16T00:00:00Z",
              url: "https://example.test/issues/1",
            },
          ]),
        };
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

describe.sequential("cli tracker reconcile", () => {
  const originalCwd = process.cwd();
  let tempDir = "";
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-tracker-reconcile-test-"));
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

  it("applies reconcile updates by default", async () => {
    const logs: string[] = [];
    const execaMock = createReconcileCliExecaMock({
      repo: "acme/demo",
      labels: ["module:billing"],
      milestones: ["Q1"],
      issues: [
        apiIssue({
          number: 1,
          title: "Billing checkout issue",
          state: "closed",
          labels: ["module:billing"],
          milestone: "Q1",
          body: "checkout billing",
        }),
        apiIssue({
          number: 20,
          title: "Checkout billing failure",
          state: "open",
          labels: [],
          milestone: null,
          body: "billing checkout",
        }),
      ],
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "reconcile"]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(commands.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit" && args[2] === "20")).toBe(true);
    expect(logs.some((line) => line.includes("tracker reconcile: DONE"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints plan without mutating in dry-run mode", async () => {
    const logs: string[] = [];
    const execaMock = createReconcileCliExecaMock({
      repo: "acme/demo",
      labels: ["module:billing"],
      milestones: ["Q1"],
      issues: [
        apiIssue({
          number: 1,
          title: "Billing checkout issue",
          state: "closed",
          labels: ["module:billing"],
          milestone: "Q1",
          body: "checkout billing",
        }),
        apiIssue({
          number: 21,
          title: "Checkout billing failure",
          state: "open",
          labels: [],
          milestone: null,
          body: "billing checkout",
        }),
      ],
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "reconcile", "--dry-run"]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(commands.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit")).toBe(false);
    expect(logs.some((line) => line.includes("tracker reconcile: dry-run complete."))).toBe(true);
    expect(logs.some((line) => line.includes("$ gh issue edit 21"))).toBe(true);
  });

  it("uses fallback flags and creates missing module labels", async () => {
    const logs: string[] = [];
    const execaMock = createReconcileCliExecaMock({
      repo: "acme/demo",
      labels: ["module:existing"],
      milestones: ["Roadmap"],
      issues: [
        apiIssue({
          number: 30,
          title: "Ambiguous setup",
          state: "open",
          labels: [],
          milestone: null,
          body: "no clear scope",
        }),
      ],
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync([
      "node",
      "vibe",
      "tracker",
      "reconcile",
      "--fallback-module",
      "module:platform",
      "--fallback-milestone",
      "Roadmap",
    ]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(commands.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:platform")).toBe(
      true,
    );
    expect(commands.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit" && args[2] === "30")).toBe(true);
    expect(logs.some((line) => line.includes("tracker reconcile: DONE"))).toBe(true);
  });

  it("degrades to plan-only in non-interactive mode when fallbacks are missing", async () => {
    const logs: string[] = [];
    const execaMock = createReconcileCliExecaMock({
      repo: "acme/demo",
      labels: ["module:ops"],
      milestones: ["Ops"],
      issues: [
        apiIssue({
          number: 40,
          title: "Unknown generic task",
          state: "open",
          labels: [],
          milestone: null,
          body: "ambiguous request",
        }),
      ],
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "reconcile"]);

    const commands = execaMock.mock.calls.map((call) => [call[0], call[1]] as [string, string[]]);
    expect(commands.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit")).toBe(false);
    expect(logs.some((line) => line.includes("plan-only mode"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("returns exit 1 on operational errors", async () => {
    const execaMock = createReconcileCliExecaMock({
      repo: "acme/demo",
      labels: [],
      milestones: [],
      issues: [],
      failOn: "issues",
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = createProgram(execaMock as never);
    await program.parseAsync(["node", "vibe", "tracker", "reconcile"]);

    expect(process.exitCode).toBe(1);
  });
});
