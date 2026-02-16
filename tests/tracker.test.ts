import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTrackerBootstrapMarkerPath,
  runTrackerReconcile,
  sanitizeTrackerText,
  selectMissingTrackerLabels,
  selectMissingTrackerMilestones,
  shouldSuggestTrackerBootstrap,
  writeTrackerBootstrapMarker,
} from "../src/core/tracker";

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

function createTrackerReconcileExecaMock(data: {
  repo: string;
  labels: string[];
  milestones: string[];
  issues: Record<string, unknown>[];
}) {
  const calls: Array<[string, string[]]> = [];

  const execaMock = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);

    if (cmd !== "gh") {
      return { stdout: "" };
    }

    if (
      args[0] === "repo" &&
      args[1] === "view" &&
      args[2] === "--json" &&
      args[3] === "nameWithOwner" &&
      args[4] === "-q" &&
      args[5] === ".nameWithOwner"
    ) {
      return { stdout: `${data.repo}\n` };
    }

    if (args[0] === "api") {
      const endpoint = args[1] ?? "";

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

      throw new Error(`Unexpected gh api endpoint: ${endpoint}`);
    }

    if (args[0] === "label" && args[1] === "create") {
      return { stdout: "" };
    }

    if (args[0] === "issue" && args[1] === "edit") {
      return { stdout: "" };
    }

    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  });

  return { execaMock, calls };
}

describe.sequential("tracker bootstrap core", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-tracker-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("selects missing milestones and labels deterministically", () => {
    const missingMilestones = selectMissingTrackerMilestones(["UI MVP (local cockpit)"]);
    const missingLabels = selectMissingTrackerLabels(["Module:UI", "MODULE:docs"]);

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

describe.sequential("tracker reconcile core", () => {
  it("sanitizes markdown/code/url noise before tokenization", () => {
    const cleaned = sanitizeTrackerText("Fix docs https://example.com ```ts\nconst x = 1\n``` now");
    expect(cleaned).toContain("fix docs");
    expect(cleaned).not.toContain("https://example.com");
    expect(cleaned).not.toContain("const x");
  });

  it("infers module/milestone from repo history using title/body signals", async () => {
    const { execaMock } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:billing", "module:infra", "status:backlog"],
      milestones: ["Q1", "Infra"],
      issues: [
        apiIssue({
          number: 1,
          title: "Billing checkout retries",
          state: "closed",
          labels: ["module:billing"],
          milestone: "Q1",
          body: "Handle checkout retry flows and payment tokenization",
        }),
        apiIssue({
          number: 2,
          title: "Checkout payment validation",
          state: "closed",
          labels: ["module:billing"],
          milestone: "Q1",
          body: "Validation rules for checkout",
        }),
        apiIssue({
          number: 3,
          title: "Terraform cluster upgrade",
          state: "closed",
          labels: ["module:infra"],
          milestone: "Infra",
          body: "Upgrade kubernetes control plane",
        }),
        apiIssue({
          number: 10,
          title: "Checkout token fails intermittently",
          state: "open",
          labels: ["bug"],
          milestone: null,
          body: "Investigate token handling. https://example.com/details",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: true,
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.dryRun).toBe(true);
    expect(result.issueUpdates).toHaveLength(1);
    expect(result.issueUpdates[0]?.issueNumber).toBe(10);
    expect(result.issueUpdates[0]?.addLabels).toEqual(["module:billing"]);
    expect(result.issueUpdates[0]?.setMilestone).toBe("Q1");
    expect(result.issueUpdates[0]?.milestoneSource).toBe("inferred");
  });

  it("adds multiple modules when explicit matches are present", async () => {
    const { execaMock } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:api", "module:web"],
      milestones: ["Release"],
      issues: [
        apiIssue({
          number: 20,
          title: "Sync api and web authentication contracts",
          state: "open",
          labels: [],
          milestone: null,
          body: "Coordinate api schema changes with web flow updates",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: true,
        fallbackMilestone: "Release",
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.issueUpdates).toHaveLength(1);
    expect(result.issueUpdates[0]?.addLabels).toEqual(["module:api", "module:web"]);
  });

  it("does not auto-assign module when score ratio is below threshold and degrades to plan-only in non-interactive apply", async () => {
    const { execaMock, calls } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:alpha", "module:beta"],
      milestones: ["M1"],
      issues: [
        apiIssue({
          number: 1,
          title: "shared alpha context",
          state: "closed",
          labels: ["module:alpha"],
          milestone: "M1",
          body: "shared",
        }),
        apiIssue({
          number: 2,
          title: "shared beta context",
          state: "closed",
          labels: ["module:beta"],
          milestone: "M1",
          body: "shared",
        }),
        apiIssue({
          number: 30,
          title: "shared context only",
          state: "open",
          labels: [],
          milestone: null,
          body: "shared",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: false,
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.degradedToPlanOnly).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.unresolvedIssueIds).toEqual([30]);
    expect(calls.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit")).toBe(false);
  });

  it("uses fallback milestone when inferred confidence is below 80%", async () => {
    const { execaMock } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:data"],
      milestones: ["Data V1", "Data V2"],
      issues: [
        apiIssue({
          number: 1,
          title: "Data ingestion pipeline",
          state: "closed",
          labels: ["module:data"],
          milestone: "Data V1",
          body: "ingestion",
        }),
        apiIssue({
          number: 2,
          title: "Data retention cleanup",
          state: "closed",
          labels: ["module:data"],
          milestone: "Data V1",
          body: "cleanup",
        }),
        apiIssue({
          number: 3,
          title: "Data schema migration",
          state: "closed",
          labels: ["module:data"],
          milestone: "Data V1",
          body: "schema",
        }),
        apiIssue({
          number: 4,
          title: "Data export fallback",
          state: "closed",
          labels: ["module:data"],
          milestone: "Data V2",
          body: "export",
        }),
        apiIssue({
          number: 40,
          title: "Data integrity alarms",
          state: "open",
          labels: [],
          milestone: null,
          body: "data alarms",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: true,
        fallbackMilestone: "Data V1",
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.issueUpdates).toHaveLength(1);
    expect(result.issueUpdates[0]?.setMilestone).toBe("Data V1");
    expect(result.issueUpdates[0]?.milestoneSource).toBe("fallback");
  });

  it("creates and assigns fallback module labels when missing from repository taxonomy", async () => {
    const { execaMock, calls } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:existing"],
      milestones: ["Roadmap"],
      issues: [
        apiIssue({
          number: 50,
          title: "new platform setup",
          state: "open",
          labels: [],
          milestone: null,
          body: "bootstrap platform",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: false,
        fallbackModule: "module:platform",
        fallbackMilestone: "Roadmap",
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.applied).toBe(true);
    expect(result.createdLabels).toEqual(["module:platform"]);
    expect(calls.some(([cmd, args]) => cmd === "gh" && args[0] === "label" && args[1] === "create" && args[2] === "module:platform")).toBe(
      true,
    );
    expect(calls.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit" && args[2] === "50")).toBe(true);
  });

  it("keeps exit-safe plan-only mode when decisions are missing without TTY", async () => {
    const { execaMock, calls } = createTrackerReconcileExecaMock({
      repo: "acme/demo",
      labels: ["module:ops"],
      milestones: ["Ops"],
      issues: [
        apiIssue({
          number: 60,
          title: "Unknown ambiguous work",
          state: "open",
          labels: [],
          milestone: null,
          body: "generic request with no strong hints",
        }),
      ],
    });

    const result = await runTrackerReconcile(
      {
        dryRun: false,
      },
      {
        execaFn: execaMock as never,
        isInteractive: false,
      },
    );

    expect(result.degradedToPlanOnly).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.planOnlyReason).toContain("non-interactive plan-only mode");
    expect(calls.some(([cmd, args]) => cmd === "gh" && args[0] === "issue" && args[1] === "edit")).toBe(false);
  });
});
