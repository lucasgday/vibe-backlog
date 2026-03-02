import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { routeCockpitRequest } from "../src/ui/cockpit";

function createRepoFixture(
  workspaceRoot: string,
  name: string,
  options: {
    withVibe?: boolean;
    turnIssueId?: number;
    turnRaw?: string;
  } = {},
): string {
  const repoPath = path.join(workspaceRoot, name);
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });

  if (options.withVibe) {
    mkdirSync(path.join(repoPath, ".vibe", "runtime"), { recursive: true });
  }

  if (typeof options.turnIssueId === "number") {
    mkdirSync(path.join(repoPath, ".vibe", "runtime"), { recursive: true });
    writeFileSync(
      path.join(repoPath, ".vibe", "runtime", "turn.json"),
      JSON.stringify(
        {
          issue_id: options.turnIssueId,
          branch: `issue-${options.turnIssueId}-fixture`,
          base_branch: "main",
          started_at: "2026-03-02T18:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (typeof options.turnRaw === "string") {
    mkdirSync(path.join(repoPath, ".vibe", "runtime"), { recursive: true });
    writeFileSync(path.join(repoPath, ".vibe", "runtime", "turn.json"), options.turnRaw, "utf8");
  }

  return repoPath;
}

describe.sequential("ui cockpit server", () => {
  let workspaceRoot = "";
  let originalCwd = "";

  beforeEach(() => {
    originalCwd = process.cwd();
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "vibe-ui-cockpit-test-"));
    process.chdir(workspaceRoot);
    createRepoFixture(workspaceRoot, "alpha-repo", { withVibe: true, turnIssueId: 16 });
    createRepoFixture(workspaceRoot, "beta-repo");
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("serves dashboard shell and projects route", async () => {
    const dashboard = await routeCockpitRequest({
      method: "GET",
      url: "/",
      workspaceRoot,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("<title>Vibe Cockpit</title>");
    expect(dashboard.body).toContain("id=\"project-selector\"");
    expect(dashboard.body).toContain("UI shell for local run/deploy workflows");
    expect(dashboard.body).toContain("@media (max-width: 920px)");
    expect(dashboard.body).toContain("__VIBE_COCKPIT_TELEMETRY__");
    expect(dashboard.body).toContain("id=\"turn-cta\"");

    const projectsResponse = await routeCockpitRequest({
      method: "GET",
      url: "/api/projects",
      workspaceRoot,
    });
    expect(projectsResponse.statusCode).toBe(200);
    const projects = JSON.parse(projectsResponse.body) as {
      workspaceRoot: string;
      selectedProjectId: string | null;
      projects: Array<{ id: string; name: string; hasVibe: boolean }>;
    };
    expect(projects.workspaceRoot).toBe(path.resolve(workspaceRoot));
    expect(projects.projects).toHaveLength(2);
    expect(projects.projects.some((project) => project.name === "alpha-repo" && project.hasVibe)).toBe(true);
    expect(projects.selectedProjectId).toBeTruthy();
  });

  it("serves project status and returns 404 for unknown project", async () => {
    const projectsResponse = await routeCockpitRequest({
      method: "GET",
      url: "/api/projects",
      workspaceRoot,
    });
    const projectsPayload = JSON.parse(projectsResponse.body) as {
      projects: Array<{ id: string; name: string }>;
    };
    const alpha = projectsPayload.projects.find((project) => project.name === "alpha-repo");
    expect(alpha).toBeDefined();

    const statusResponse = await routeCockpitRequest({
      method: "GET",
      url: `/api/project-status?project=${encodeURIComponent(alpha!.id)}`,
      workspaceRoot,
    });
    expect(statusResponse.statusCode).toBe(200);
    const statusPayload = JSON.parse(statusResponse.body) as {
      projectName: string;
      turn: { value: string };
      issue: { value: string };
    };
    expect(statusPayload.projectName).toBe("alpha-repo");
    expect(statusPayload.turn.value).toContain("#16");
    expect(statusPayload.issue.value).toBe("#16");

    const missingResponse = await routeCockpitRequest({
      method: "GET",
      url: "/api/project-status?project=missing-project",
      workspaceRoot,
    });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("returns invalid turn fallback when turn.json is malformed", async () => {
    createRepoFixture(workspaceRoot, "gamma-repo", { withVibe: true, turnRaw: "{invalid-json" });

    const projectsResponse = await routeCockpitRequest({
      method: "GET",
      url: "/api/projects",
      workspaceRoot,
    });
    const projectsPayload = JSON.parse(projectsResponse.body) as {
      projects: Array<{ id: string; name: string }>;
    };
    const gamma = projectsPayload.projects.find((project) => project.name === "gamma-repo");
    expect(gamma).toBeDefined();

    const statusResponse = await routeCockpitRequest({
      method: "GET",
      url: `/api/project-status?project=${encodeURIComponent(gamma!.id)}`,
      workspaceRoot,
    });
    expect(statusResponse.statusCode).toBe(200);
    const statusPayload = JSON.parse(statusResponse.body) as {
      turn: { value: string };
      issue: { value: string };
    };
    expect(statusPayload.turn.value).toBe("Invalid turn context");
    expect(statusPayload.issue.value).toBe("Pending link");
  });
});
