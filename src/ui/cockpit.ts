import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

type StatusCard = {
  value: string;
  hint: string;
};

type TurnContextProbe =
  | {
      status: "missing";
    }
  | {
      status: "invalid";
      reason: string;
    }
  | {
      status: "active";
      issueId: number | null;
      branch: string | null;
      startedAt: string | null;
    };

export type CockpitProjectSummary = {
  id: string;
  name: string;
  path: string;
  hasVibe: boolean;
};

export type CockpitProjectsSnapshot = {
  workspaceRoot: string;
  projects: CockpitProjectSummary[];
  selectedProjectId: string | null;
};

export type CockpitProjectStatus = {
  projectId: string;
  projectName: string;
  projectPath: string;
  branch: StatusCard;
  turn: StatusCard;
  issue: StatusCard;
  updatedAt: string;
};

export type CockpitServerHandle = {
  server: HttpServer;
  workspaceRoot: string;
  host: string;
  port: number;
  url: string;
};

export type StartCockpitServerOptions = {
  workspaceRoot: string;
  host?: string;
  port?: number;
};

export type CockpitRouteRequest = {
  method?: string | null;
  url?: string | null;
  workspaceRoot: string;
};

export type CockpitRouteResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const DASHBOARD_STYLE = `
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap");

:root {
  --bg-top: #f7f2ea;
  --bg-bottom: #e5eef5;
  --ink: #162130;
  --ink-soft: #3f5368;
  --line: rgba(26, 41, 56, 0.14);
  --panel: rgba(255, 255, 255, 0.78);
  --accent-main: #0c8e86;
  --accent-alt: #f47c20;
  --shadow: 0 18px 40px rgba(19, 35, 52, 0.14);
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
}

body {
  margin: 0;
  font-family: "Space Grotesk", "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(1200px 500px at -10% -15%, rgba(244, 124, 32, 0.24), transparent 62%),
    radial-gradient(900px 450px at 120% -10%, rgba(12, 142, 134, 0.22), transparent 58%),
    linear-gradient(165deg, var(--bg-top), var(--bg-bottom));
}

.shell {
  max-width: 1160px;
  margin: 2.4rem auto;
  border: 1px solid var(--line);
  border-radius: 26px;
  background: var(--panel);
  box-shadow: var(--shadow);
  backdrop-filter: blur(8px);
  overflow: hidden;
}

.shell-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding: 1.25rem 1.6rem;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(90deg, rgba(12, 142, 134, 0.14), rgba(244, 124, 32, 0.08));
}

.brand {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.header-note {
  margin: 0;
  font-size: 0.9rem;
  color: var(--ink-soft);
}

.shell-body {
  display: grid;
  grid-template-columns: minmax(250px, 290px) minmax(0, 1fr);
  min-height: 520px;
}

.shell-sidebar {
  border-right: 1px solid var(--line);
  padding: 1.3rem;
  display: grid;
  gap: 1rem;
  align-content: start;
}

.label {
  margin: 0;
  font-size: 0.79rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

#project-selector {
  width: 100%;
  margin-top: 0.35rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0.72rem 0.76rem;
  background: rgba(255, 255, 255, 0.94);
  color: var(--ink);
  font-family: "Space Grotesk", "Segoe UI", sans-serif;
  font-size: 0.95rem;
}

.mono-chip {
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.68);
  padding: 0.7rem 0.8rem;
  font-family: "IBM Plex Mono", "Menlo", monospace;
  font-size: 0.78rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.meta-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.55rem;
}

.meta-list li {
  font-size: 0.89rem;
}

.meta-key {
  color: var(--ink-soft);
}

.shell-main {
  padding: 1.35rem;
  display: grid;
  gap: 1rem;
  align-content: start;
}

.status-grid {
  display: grid;
  gap: 0.8rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.status-card {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.8);
  padding: 0.95rem;
  opacity: 0;
  transform: translateY(6px);
  animation: card-rise 420ms ease forwards;
}

.status-card:nth-child(2) {
  animation-delay: 90ms;
}

.status-card:nth-child(3) {
  animation-delay: 170ms;
}

.status-title {
  margin: 0;
  font-size: 0.74rem;
  color: var(--ink-soft);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.status-value {
  margin: 0.45rem 0 0;
  font-size: 1.13rem;
  font-weight: 600;
}

.status-hint {
  margin: 0.4rem 0 0;
  font-size: 0.85rem;
  color: var(--ink-soft);
}

.panel-grid {
  display: grid;
  gap: 0.8rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.76);
  padding: 1rem;
}

.panel h2 {
  margin: 0;
  font-size: 1rem;
}

.panel p {
  margin: 0.6rem 0 0;
  color: var(--ink-soft);
  font-size: 0.9rem;
  line-height: 1.45;
}

.accent {
  color: var(--accent-main);
  font-weight: 600;
}

@media (max-width: 920px) {
  .shell {
    margin: 1.1rem;
  }

  .shell-body {
    grid-template-columns: 1fr;
  }

  .shell-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .status-grid,
  .panel-grid {
    grid-template-columns: 1fr;
  }
}

@keyframes card-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;

const DASHBOARD_SCRIPT = `
(() => {
  const bootNode = document.getElementById("vibe-cockpit-boot");
  const boot = bootNode && bootNode.textContent ? JSON.parse(bootNode.textContent) : {};

  const selector = document.getElementById("project-selector");
  const workspacePath = document.getElementById("workspace-path");
  const repoCount = document.getElementById("repo-count");
  const selectedPath = document.getElementById("project-path");
  const branchValue = document.getElementById("branch-value");
  const branchHint = document.getElementById("branch-hint");
  const turnValue = document.getElementById("turn-value");
  const turnHint = document.getElementById("turn-hint");
  const issueValue = document.getElementById("issue-value");
  const issueHint = document.getElementById("issue-hint");

  const projects = Array.isArray(boot.projects) ? boot.projects : [];
  const selectedInitial = typeof boot.selectedProjectId === "string" ? boot.selectedProjectId : "";
  const initialStatus = boot.initialStatus && typeof boot.initialStatus === "object" ? boot.initialStatus : null;
  const workspaceRoot = typeof boot.workspaceRoot === "string" ? boot.workspaceRoot : "";

  if (workspacePath) workspacePath.textContent = workspaceRoot || "(not set)";
  if (repoCount) repoCount.textContent = String(projects.length);

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function renderStatus(status) {
    if (!status) {
      setText(selectedPath, "(select a repository)");
      setText(branchValue, "Unavailable");
      setText(branchHint, "No repository selected.");
      setText(turnValue, "No active turn");
      setText(turnHint, "Select a repository.");
      setText(issueValue, "Pending link");
      setText(issueHint, "Select a repository to inspect.");
      return;
    }

    setText(selectedPath, status.projectPath || "-");
    setText(branchValue, status.branch && status.branch.value ? status.branch.value : "Unavailable");
    setText(branchHint, status.branch && status.branch.hint ? status.branch.hint : "");
    setText(turnValue, status.turn && status.turn.value ? status.turn.value : "No active turn");
    setText(turnHint, status.turn && status.turn.hint ? status.turn.hint : "");
    setText(issueValue, status.issue && status.issue.value ? status.issue.value : "Pending link");
    setText(issueHint, status.issue && status.issue.hint ? status.issue.hint : "");
  }

  async function fetchStatus(projectId) {
    if (!projectId) {
      renderStatus(null);
      return;
    }

    try {
      const response = await fetch("/api/project-status?project=" + encodeURIComponent(projectId));
      if (!response.ok) throw new Error("status request failed");
      const data = await response.json();
      renderStatus(data);
    } catch {
      renderStatus({
        projectPath: "(request failed)",
        branch: { value: "Unavailable", hint: "Could not load branch status." },
        turn: { value: "No active turn", hint: "Could not load turn status." },
        issue: { value: "Pending link", hint: "Could not load issue placeholder." }
      });
    }
  }

  if (selector) {
    selector.innerHTML = "";
    if (!projects.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No repositories found";
      selector.append(option);
      selector.disabled = true;
    } else {
      for (const project of projects) {
        const option = document.createElement("option");
        option.value = project.id;
        option.textContent = project.name + (project.hasVibe ? " (vibe)" : "");
        selector.append(option);
      }
      selector.value = selectedInitial || projects[0].id;
      selector.addEventListener("change", () => {
        void fetchStatus(selector.value);
      });
    }
  }

  if (initialStatus) {
    renderStatus(initialStatus);
  } else if (selector && selector.value) {
    void fetchStatus(selector.value);
  } else {
    renderStatus(null);
  }
})();
`;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === ".") {
    return ".";
  }
  return relativePath.replaceAll(path.sep, "/");
}

function toProjectId(relativePath: string): string {
  return encodeURIComponent(normalizeRelativePath(relativePath));
}

function safeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function resolveTurnContext(projectPath: string): Promise<TurnContextProbe> {
  const turnPath = path.join(projectPath, ".vibe", "runtime", "turn.json");
  if (!(await pathExists(turnPath))) {
    return { status: "missing" };
  }

  try {
    const raw = await readFile(turnPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "invalid", reason: "turn.json is not an object" };
    }

    const item = parsed as Record<string, unknown>;
    const issueIdCandidate = item.issue_id;
    const issueId =
      typeof issueIdCandidate === "number" && Number.isInteger(issueIdCandidate) && issueIdCandidate > 0
        ? issueIdCandidate
        : null;
    const branch = typeof item.branch === "string" && item.branch.trim() ? item.branch.trim() : null;
    const startedAt = typeof item.started_at === "string" && item.started_at.trim() ? item.started_at.trim() : null;

    return {
      status: "active",
      issueId,
      branch,
      startedAt,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : "unable to parse turn.json";
    return { status: "invalid", reason };
  }
}

async function resolveBranch(projectPath: string): Promise<string | null> {
  try {
    const result = await execa("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: "pipe",
      reject: false,
    });
    if (result.exitCode !== 0) {
      return null;
    }

    const branch = result.stdout.trim();
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

function buildBranchCard(branch: string | null): StatusCard {
  if (branch) {
    return {
      value: branch,
      hint: "Detected from git HEAD.",
    };
  }

  return {
    value: "Unavailable",
    hint: "Could not resolve git branch from this project.",
  };
}

function buildTurnCard(turn: TurnContextProbe): StatusCard {
  if (turn.status === "missing") {
    return {
      value: "No active turn",
      hint: "Run `vibe turn start --issue <n>` in this project.",
    };
  }

  if (turn.status === "invalid") {
    return {
      value: "Invalid turn context",
      hint: turn.reason,
    };
  }

  const issueText = turn.issueId ? `#${turn.issueId}` : "issue pending";
  const branchText = turn.branch ?? "branch pending";
  const value = `${issueText} · ${branchText}`;
  return {
    value,
    hint: turn.startedAt ? `Started at ${turn.startedAt}.` : "Active turn loaded from .vibe/runtime/turn.json.",
  };
}

function buildIssueCard(turn: TurnContextProbe): StatusCard {
  if (turn.status === "active" && turn.issueId) {
    return {
      value: `#${turn.issueId}`,
      hint: "Linked from active turn context.",
    };
  }

  return {
    value: "Pending link",
    hint: "Issue hydration panel will be added in the next UI slices.",
  };
}

function buildDashboardHtml(snapshot: CockpitProjectsSnapshot, initialStatus: CockpitProjectStatus | null): string {
  const bootPayload = safeJson({
    workspaceRoot: snapshot.workspaceRoot,
    projects: snapshot.projects,
    selectedProjectId: snapshot.selectedProjectId,
    initialStatus,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Vibe Cockpit</title>
    <style>${DASHBOARD_STYLE}</style>
  </head>
  <body>
    <div class="shell">
      <header class="shell-header">
        <h1 class="brand">Vibe Cockpit</h1>
        <p class="header-note">UI shell for local run/deploy workflows</p>
      </header>
      <div class="shell-body">
        <aside class="shell-sidebar">
          <div>
            <p class="label">Workspace root</p>
            <p id="workspace-path" class="mono-chip">${safeText(snapshot.workspaceRoot)}</p>
          </div>
          <div>
            <p class="label">Project selector</p>
            <select id="project-selector" aria-label="Project selector"></select>
          </div>
          <div>
            <p class="label">Selected path</p>
            <p id="project-path" class="mono-chip">${safeText(initialStatus?.projectPath ?? "(select a repository)")}</p>
          </div>
          <ul class="meta-list">
            <li><span class="meta-key">Repositories:</span> <strong id="repo-count">${snapshot.projects.length}</strong></li>
            <li><span class="meta-key">Mode:</span> local cockpit shell</li>
            <li><span class="meta-key">Focus:</span> <span class="accent">safe run + deploy lanes</span></li>
          </ul>
        </aside>
        <main class="shell-main">
          <section class="status-grid" aria-label="Status cards">
            <article class="status-card">
              <p class="status-title">Branch</p>
              <p id="branch-value" class="status-value">${safeText(initialStatus?.branch.value ?? "Unavailable")}</p>
              <p id="branch-hint" class="status-hint">${safeText(initialStatus?.branch.hint ?? "No repository selected.")}</p>
            </article>
            <article class="status-card">
              <p class="status-title">Turn</p>
              <p id="turn-value" class="status-value">${safeText(initialStatus?.turn.value ?? "No active turn")}</p>
              <p id="turn-hint" class="status-hint">${safeText(initialStatus?.turn.hint ?? "Select a repository.")}</p>
            </article>
            <article class="status-card">
              <p class="status-title">Issue Link</p>
              <p id="issue-value" class="status-value">${safeText(initialStatus?.issue.value ?? "Pending link")}</p>
              <p id="issue-hint" class="status-hint">${safeText(initialStatus?.issue.hint ?? "Select a repository.")}</p>
            </article>
          </section>
          <section class="panel-grid" aria-label="Future workflow panels">
            <article class="panel">
              <h2>Run Planner</h2>
              <p>Reserved panel for <code>preflight</code>, tests, and review flows. This shell keeps room for actionable controls without layout churn.</p>
            </article>
            <article class="panel">
              <h2>Deploy Rail</h2>
              <p>Reserved panel for postflight apply, release checks, and audit traces. The structure is ready for future deployment-safe interactions.</p>
            </article>
          </section>
        </main>
      </div>
    </div>
    <script id="vibe-cockpit-boot" type="application/json">${bootPayload}</script>
    <script>${DASHBOARD_SCRIPT}</script>
  </body>
</html>`;
}

async function discoverProjectCandidates(workspaceRoot: string): Promise<string[]> {
  const candidates = [workspaceRoot];

  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(workspaceRoot, entry.name));
    }
  } catch {
    // No directory listing permissions or missing workspace root.
  }

  return candidates;
}

export async function discoverWorkspaceProjects(workspaceRoot: string): Promise<CockpitProjectSummary[]> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const candidates = await discoverProjectCandidates(resolvedRoot);
  const projects: CockpitProjectSummary[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const gitMarker = path.join(candidate, ".git");
    if (!(await pathExists(gitMarker))) {
      continue;
    }

    const relativeRaw = path.relative(resolvedRoot, candidate);
    const relativePath = relativeRaw ? normalizeRelativePath(relativeRaw) : ".";
    const hasVibe = await pathExists(path.join(candidate, ".vibe"));
    projects.push({
      id: toProjectId(relativePath),
      name: relativePath === "." ? path.basename(resolvedRoot) || "." : path.basename(candidate),
      path: candidate,
      hasVibe,
    });
  }

  projects.sort((left, right) => {
    if (left.path === resolvedRoot) return -1;
    if (right.path === resolvedRoot) return 1;
    return left.name.localeCompare(right.name);
  });

  return projects;
}

export async function readProjectStatus(project: CockpitProjectSummary): Promise<CockpitProjectStatus> {
  const [branch, turn] = await Promise.all([resolveBranch(project.path), resolveTurnContext(project.path)]);

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    branch: buildBranchCard(branch),
    turn: buildTurnCard(turn),
    issue: buildIssueCard(turn),
    updatedAt: new Date().toISOString(),
  };
}

async function readProjectsSnapshot(workspaceRoot: string): Promise<CockpitProjectsSnapshot> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const projects = await discoverWorkspaceProjects(resolvedRoot);
  return {
    workspaceRoot: resolvedRoot,
    projects,
    selectedProjectId: projects[0]?.id ?? null,
  };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function jsonResponse(statusCode: number, payload: unknown): CockpitRouteResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function htmlResponse(html: string): CockpitRouteResponse {
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body: html,
  };
}

async function resolveProjectById(workspaceRoot: string, projectId: string): Promise<CockpitProjectSummary | null> {
  const projects = await discoverWorkspaceProjects(workspaceRoot);
  return projects.find((project) => project.id === projectId) ?? null;
}

export async function routeCockpitRequest(request: CockpitRouteRequest): Promise<CockpitRouteResponse> {
  const requestMethod = (request.method ?? "GET").toUpperCase();
  if (requestMethod !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const workspaceRoot = path.resolve(request.workspaceRoot);
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/healthz") {
    return jsonResponse(200, { ok: true });
  }

  if (requestUrl.pathname === "/api/projects") {
    const snapshot = await readProjectsSnapshot(workspaceRoot);
    return jsonResponse(200, snapshot);
  }

  if (requestUrl.pathname === "/api/project-status") {
    const projectId = requestUrl.searchParams.get("project");
    if (!projectId) {
      return jsonResponse(400, { error: "missing_project_id" });
    }

    const project = await resolveProjectById(workspaceRoot, projectId);
    if (!project) {
      return jsonResponse(404, { error: "project_not_found" });
    }

    const status = await readProjectStatus(project);
    return jsonResponse(200, status);
  }

  if (requestUrl.pathname === "/favicon.ico") {
    return {
      statusCode: 204,
      headers: {},
      body: "",
    };
  }

  if (requestUrl.pathname !== "/") {
    return jsonResponse(404, { error: "not_found" });
  }

  const snapshot = await readProjectsSnapshot(workspaceRoot);
  const selected = snapshot.projects.find((project) => project.id === snapshot.selectedProjectId) ?? null;
  const initialStatus = selected ? await readProjectStatus(selected) : null;
  return htmlResponse(buildDashboardHtml(snapshot, initialStatus));
}

async function handleCockpitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string,
): Promise<void> {
  const routed = await routeCockpitRequest({
    method: request.method ?? "GET",
    url: request.url ?? "/",
    workspaceRoot,
  });

  response.writeHead(routed.statusCode, routed.headers);
  response.end(routed.body);
}

export async function startCockpitServer(options: StartCockpitServerOptions): Promise<CockpitServerHandle> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const host = options.host?.trim() || "127.0.0.1";
  const port = Number.isInteger(options.port) ? (options.port as number) : 4173;

  const server = createServer((request, response) => {
    void handleCockpitRequest(request, response, workspaceRoot).catch((error) => {
      const detail = error instanceof Error && error.message ? error.message : String(error);
      writeJson(response, 500, { error: "internal_error", detail });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw new Error("ui server: unable to resolve listening address");
  }

  const hostForUrl = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    server,
    workspaceRoot,
    host: address.address,
    port: address.port,
    url: `http://${hostForUrl}:${address.port}`,
  };
}

export async function stopCockpitServer(handle: CockpitServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    handle.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
