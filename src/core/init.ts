import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type InitScaffoldResult = {
  created: string[];
  updated: string[];
  unchanged: string[];
};

type InitScaffoldOptions = {
  cwd?: string;
  dryRun: boolean;
  toolPackageName?: string;
  toolVersion?: string;
};

type ToolIdentity = {
  packageName: string;
  version: string;
};

type ProtectedSectionMarker = {
  start: string;
  end: string;
};

export type VibeScaffoldCheckStatus = "not-initialized" | "up-to-date" | "update-available";

export type VibeScaffoldCheckResult = {
  status: VibeScaffoldCheckStatus;
  updateAvailable: boolean;
  reason: string;
  targetTemplateVersion: number;
  localTemplateVersion: number | null;
  metadataPath: string;
  localToolVersion: string | null;
  targetToolVersion: string;
};

export type VibeScaffoldDiffPreview = {
  filePath: string;
  action: "create" | "update";
  preview: string;
};

export type VibeScaffoldUpdateResult = InitScaffoldResult & {
  check: VibeScaffoldCheckResult;
  dryRun: boolean;
  applied: boolean;
  previews: VibeScaffoldDiffPreview[];
};

type VibeScaffoldUpdateOptions = {
  cwd?: string;
  dryRun: boolean;
  toolPackageName?: string;
  toolVersion?: string;
};

const VIBE_DIRECTORIES = [".vibe", ".vibe/runtime", ".vibe/artifacts", ".vibe/templates", ".vibe/reviews", ".vibe/pills"];
const AGENT_SNIPPET_START = "<!-- vibe:agent-snippet:start -->";
const AGENT_SNIPPET_END = "<!-- vibe:agent-snippet:end -->";
const README_WORKFLOW_START = "<!-- vibe:workflow-docs:start -->";
const README_WORKFLOW_END = "<!-- vibe:workflow-docs:end -->";
const TRACKER_GITIGNORE_ENTRIES = [".vibe/runtime", ".vibe/artifacts"];
const DEFAULT_TOOL_PACKAGE_NAME = "vibe-backlog";
const DEFAULT_TOOL_VERSION = "0.1.0";
export const VIBE_SCAFFOLD_TEMPLATE_VERSION = 3;
const SCAFFOLD_METADATA_RELATIVE_PATH = path.join(".vibe", "scaffold.json");
const PREVIEW_LINE_LIMIT = 160;
const PROTECTED_SECTION_MARKERS: readonly ProtectedSectionMarker[] = [
  { start: "<!-- vibe:user-notes:start -->", end: "<!-- vibe:user-notes:end -->" },
  { start: "<!-- vibe:agent-log:start -->", end: "<!-- vibe:agent-log:end -->" },
];

const DEFAULT_CONTRACT_YAML = `version: 1
project:
  source_of_truth: "github"

interaction_contract:
  preflight:
    required:
      - git_status
      - tracker_open_items_summary
      - tests_last_result_or_run_plan
  postflight:
    required:
      - tracker_update_status
      - tracker_append_agent_log
      - record_tests_result
      - next_actions
      - risks_and_rollbacks

security:
  gitleaks:
    policy: warn

editing_rules:
  agent:
    append_only_default: true
    may_edit_user_notes: false
`;

const DEFAULT_OWNERSHIP_YAML = `version: 1
protected_sections:
  markers:
    user_notes:
      start: "<!-- vibe:user-notes:start -->"
      end: "<!-- vibe:user-notes:end -->"
    agent_log:
      start: "<!-- vibe:agent-log:start -->"
      end: "<!-- vibe:agent-log:end -->"
rules:
  default:
    agent_can: ["append_comment"]
    agent_cannot: ["overwrite_issue_body", "edit_user_notes_section"]
`;

function buildDefaultPostflightJson(now: string): string {
  const payload = {
    version: 1,
    meta: {
      timestamp: now,
      actor: "agent",
      mode: "cli",
    },
    work: {
      issue_id: "1",
      branch: "main",
      base_branch: "main",
    },
    checks: {
      tests: {
        ran: false,
        result: "skipped",
      },
    },
    tracker_updates: [
      {
        type: "comment_append",
        body: "Initial postflight draft.",
      },
    ],
    next_actions: ["Replace this line with the next concrete action."],
    risks: {
      summary: "Initial draft before real changes.",
      rollback_plan: "No tracker updates applied yet.",
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildScaffoldMetadataJson(identity: ToolIdentity): string {
  const payload = {
    version: 1,
    scaffold_template_version: VIBE_SCAFFOLD_TEMPLATE_VERSION,
    tool: {
      package: identity.packageName,
      version: identity.version,
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildAgentSnippetBlock(): string {
  const body = [
    "## Vibe Agent Workflow (Managed)",
    "- Run `node dist/cli.cjs preflight` before implementation.",
    "- Use one issue per topic and keep tracker labels updated.",
    "- Use semantic, repo-specific milestones (avoid fixed milestone catalogs).",
    "- Validate with `node dist/cli.cjs postflight` and apply updates with `node dist/cli.cjs postflight --apply`.",
  ].join("\n");

  return `${AGENT_SNIPPET_START}\n${body}\n${AGENT_SNIPPET_END}\n`;
}

function buildReadmeWorkflowBlock(): string {
  return [
    README_WORKFLOW_START,
    "## Vibe Workflow (Managed)",
    "",
    "This section is managed by `vibe init` / `vibe update`.",
    "",
    "```mermaid",
    "flowchart LR",
    '    A["preflight"] --> B["pick issue"]',
    '    B --> C["implement + tests"]',
    '    C --> D["postflight"]',
    '    D --> E{"apply updates?"}',
    '    E -- "dry-run" --> F["postflight --apply --dry-run"]',
    '    E -- "yes" --> G["postflight --apply"]',
    '    G --> H["tracker synced"]',
    "```",
    "",
    "Workflow steps (text fallback):",
    "",
    "1. Run `vibe preflight`.",
    "2. Pick one issue and keep scope focused.",
    "3. Implement and run tests/build.",
    "4. Validate `vibe postflight`.",
    "5. Preview tracker changes with `vibe postflight --apply --dry-run`.",
    "6. Apply tracker updates with `vibe postflight --apply`.",
    "",
    README_WORKFLOW_END,
    "",
  ].join("\n");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const entry = await stat(filePath);
    return entry.isDirectory();
  } catch {
    return false;
  }
}

function pushChange(result: InitScaffoldResult, kind: keyof InitScaffoldResult, filePath: string): void {
  result[kind].push(filePath);
}

function resolveToolIdentity(options?: { toolPackageName?: string; toolVersion?: string }): ToolIdentity {
  const packageName =
    typeof options?.toolPackageName === "string" && options.toolPackageName.trim()
      ? options.toolPackageName.trim()
      : DEFAULT_TOOL_PACKAGE_NAME;
  const version =
    typeof options?.toolVersion === "string" && options.toolVersion.trim() ? options.toolVersion.trim() : DEFAULT_TOOL_VERSION;

  return { packageName, version };
}

function splitPreviewLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.length) return [];
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (!trimmed.length) return [];
  return trimmed.split("\n");
}

function renderDiffPreview(filePath: string, before: string | null, after: string): string {
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];

  if (before !== null) {
    for (const line of splitPreviewLines(before)) {
      lines.push(`-${line}`);
    }
  }
  for (const line of splitPreviewLines(after)) {
    lines.push(`+${line}`);
  }

  if (lines.length <= PREVIEW_LINE_LIMIT) {
    return lines.join("\n");
  }

  return [...lines.slice(0, PREVIEW_LINE_LIMIT), "... (truncated)"].join("\n");
}

function recordPreview(
  previews: VibeScaffoldDiffPreview[] | undefined,
  filePath: string,
  before: string | null,
  after: string,
): void {
  if (!previews) return;
  const beforePreview = before === null ? null : redactProtectedSectionsForPreview(before);
  const afterPreview = redactProtectedSectionsForPreview(after);
  previews.push({
    filePath,
    action: before === null ? "create" : "update",
    preview: renderDiffPreview(filePath, beforePreview, afterPreview),
  });
}

function isLineBoundaryChar(value: string | undefined): boolean {
  return value === undefined || value === "\n" || value === "\r";
}

function findStandaloneMarkerIndex(content: string, markerText: string, fromIndex = 0): number {
  let searchIndex = Math.max(0, fromIndex);

  while (searchIndex < content.length) {
    const candidate = content.indexOf(markerText, searchIndex);
    if (candidate < 0) return -1;

    const before = candidate > 0 ? content[candidate - 1] : undefined;
    const after = content[candidate + markerText.length];
    if (isLineBoundaryChar(before) && isLineBoundaryChar(after)) {
      return candidate;
    }

    searchIndex = candidate + markerText.length;
  }

  return -1;
}

function stripStandaloneMarkerLines(content: string, markerText: string): string {
  let next = content;

  while (true) {
    const markerIndex = findStandaloneMarkerIndex(next, markerText);
    if (markerIndex < 0) break;

    const lineStart = next.lastIndexOf("\n", markerIndex - 1);
    const lineEnd = next.indexOf("\n", markerIndex + markerText.length);
    const removeStart = lineStart < 0 ? 0 : lineStart + 1;
    const removeEnd = lineEnd < 0 ? next.length : lineEnd + 1;
    next = `${next.slice(0, removeStart)}${next.slice(removeEnd)}`;
  }

  return next;
}

function findMarkedSectionRange(content: string, marker: ProtectedSectionMarker): { start: number; end: number } | null {
  const startIndex = findStandaloneMarkerIndex(content, marker.start);
  if (startIndex < 0) return null;
  const endMarkerIndex = findStandaloneMarkerIndex(content, marker.end, startIndex + marker.start.length);
  if (endMarkerIndex < 0) return null;
  return { start: startIndex, end: endMarkerIndex + marker.end.length };
}

function redactProtectedSectionsForPreview(content: string): string {
  let next = content;

  for (const marker of PROTECTED_SECTION_MARKERS) {
    let searchFrom = 0;
    while (searchFrom < next.length) {
      const startIndex = findStandaloneMarkerIndex(next, marker.start, searchFrom);
      if (startIndex < 0) break;
      const endMarkerIndex = findStandaloneMarkerIndex(next, marker.end, startIndex + marker.start.length);
      if (endMarkerIndex < 0) break;

      const replacement = `${marker.start}\n[vibe protected section redacted in preview]\n${marker.end}`;
      next = `${next.slice(0, startIndex)}${replacement}${next.slice(endMarkerIndex + marker.end.length)}`;
      searchFrom = startIndex + replacement.length;
    }
  }

  return next;
}

export function preserveProtectedSections(templateContent: string, currentContent: string): string {
  let next = templateContent;

  for (const marker of PROTECTED_SECTION_MARKERS) {
    const currentRange = findMarkedSectionRange(currentContent, marker);
    if (!currentRange) continue;
    const nextRange = findMarkedSectionRange(next, marker);
    if (!nextRange) continue;

    const currentSection = currentContent.slice(currentRange.start, currentRange.end);
    next = `${next.slice(0, nextRange.start)}${currentSection}${next.slice(nextRange.end)}`;
  }

  return next;
}

async function ensureDirectory(dirPath: string, dryRun: boolean, result: InitScaffoldResult): Promise<void> {
  if (await pathExists(dirPath)) {
    pushChange(result, "unchanged", dirPath);
    return;
  }

  if (!dryRun) {
    await mkdir(dirPath, { recursive: true });
  }
  pushChange(result, "created", dirPath);
}

async function ensureFile(filePath: string, content: string, dryRun: boolean, result: InitScaffoldResult): Promise<void> {
  if (await pathExists(filePath)) {
    pushChange(result, "unchanged", filePath);
    return;
  }

  if (!dryRun) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  pushChange(result, "created", filePath);
}

async function upsertManagedTextFile(
  filePath: string,
  content: string,
  dryRun: boolean,
  result: InitScaffoldResult,
  previews?: VibeScaffoldDiffPreview[],
): Promise<void> {
  const exists = await pathExists(filePath);
  if (!exists) {
    if (!dryRun) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
    pushChange(result, "created", filePath);
    recordPreview(previews, filePath, null, content);
    return;
  }

  const current = await readFile(filePath, "utf8");
  const next = preserveProtectedSections(content, current);

  if (next === current) {
    pushChange(result, "unchanged", filePath);
    return;
  }

  if (!dryRun) {
    await writeFile(filePath, next, "utf8");
  }
  pushChange(result, "updated", filePath);
  recordPreview(previews, filePath, current, next);
}

async function upsertAgentSnippet(
  agentsPath: string,
  dryRun: boolean,
  result: InitScaffoldResult,
  previews?: VibeScaffoldDiffPreview[],
): Promise<void> {
  const snippet = buildAgentSnippetBlock();
  const agentsExists = await pathExists(agentsPath);

  if (!agentsExists) {
    const content = `# AGENTS\n\n${snippet}`;
    if (!dryRun) {
      await writeFile(agentsPath, content, "utf8");
    }
    pushChange(result, "created", agentsPath);
    recordPreview(previews, agentsPath, null, content);
    return;
  }

  const current = await readFile(agentsPath, "utf8");
  const start = current.indexOf(AGENT_SNIPPET_START);
  const end = current.indexOf(AGENT_SNIPPET_END);

  let next = current;
  if (start >= 0 && end > start) {
    const endWithMarker = end + AGENT_SNIPPET_END.length;
    next = `${current.slice(0, start)}${snippet}${current.slice(endWithMarker)}`;
  } else if (!current.includes(AGENT_SNIPPET_START)) {
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    next = `${current}${separator}${snippet}`;
  }

  if (next === current) {
    pushChange(result, "unchanged", agentsPath);
    return;
  }

  if (!dryRun) {
    await writeFile(agentsPath, next, "utf8");
  }
  pushChange(result, "updated", agentsPath);
  recordPreview(previews, agentsPath, current, next);
}

async function upsertReadmeWorkflowSection(
  readmePath: string,
  dryRun: boolean,
  result: InitScaffoldResult,
  previews?: VibeScaffoldDiffPreview[],
): Promise<void> {
  const workflowBlock = buildReadmeWorkflowBlock();
  const readmeExists = await pathExists(readmePath);

  if (!readmeExists) {
    if (!dryRun) {
      await writeFile(readmePath, workflowBlock, "utf8");
    }
    pushChange(result, "created", readmePath);
    recordPreview(previews, readmePath, null, workflowBlock);
    return;
  }

  const current = await readFile(readmePath, "utf8");
  const start = findStandaloneMarkerIndex(current, README_WORKFLOW_START);
  const end = findStandaloneMarkerIndex(current, README_WORKFLOW_END);

  let next = current;
  if (start >= 0 && end > start) {
    const endWithMarker = end + README_WORKFLOW_END.length;
    next = `${current.slice(0, start)}${workflowBlock}${current.slice(endWithMarker)}`;
  } else if (start < 0 && end < 0) {
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    next = `${current}${separator}${workflowBlock}`;
  } else {
    let repairedBase = current;
    if (start >= 0 && end < 0) {
      // Start marker without end marker: treat trailing region as corrupted managed block.
      repairedBase = current.slice(0, start).trimEnd();
    } else {
      repairedBase = stripStandaloneMarkerLines(repairedBase, README_WORKFLOW_START);
      repairedBase = stripStandaloneMarkerLines(repairedBase, README_WORKFLOW_END);
      repairedBase = repairedBase.trimEnd();
    }
    const separator = repairedBase.endsWith("\n") ? "\n" : "\n\n";
    next = `${repairedBase}${separator}${workflowBlock}`;
  }

  if (next === current) {
    pushChange(result, "unchanged", readmePath);
    return;
  }

  if (!dryRun) {
    await writeFile(readmePath, next, "utf8");
  }
  pushChange(result, "updated", readmePath);
  recordPreview(previews, readmePath, current, next);
}

async function upsertGitignoreEntries(
  gitignorePath: string,
  dryRun: boolean,
  result: InitScaffoldResult,
  previews?: VibeScaffoldDiffPreview[],
): Promise<void> {
  const exists = await pathExists(gitignorePath);
  if (!exists) {
    const content = `${TRACKER_GITIGNORE_ENTRIES.join("\n")}\n`;
    if (!dryRun) {
      await writeFile(gitignorePath, content, "utf8");
    }
    pushChange(result, "created", gitignorePath);
    recordPreview(previews, gitignorePath, null, content);
    return;
  }

  const current = await readFile(gitignorePath, "utf8");
  const lines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = TRACKER_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));

  if (!missing.length) {
    pushChange(result, "unchanged", gitignorePath);
    return;
  }

  const prefix = current.endsWith("\n") ? "" : "\n";
  const next = `${current}${prefix}${missing.join("\n")}\n`;
  if (!dryRun) {
    await writeFile(gitignorePath, next, "utf8");
  }
  pushChange(result, "updated", gitignorePath);
  recordPreview(previews, gitignorePath, current, next);
}

async function readScaffoldMetadataVersions(
  metadataPath: string,
): Promise<{ exists: boolean; templateVersion: number | null; toolVersion: string | null }> {
  if (!(await pathExists(metadataPath))) {
    return { exists: false, templateVersion: null, toolVersion: null };
  }

  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const templateVersionRaw = parsed.scaffold_template_version;
    const templateVersion =
      typeof templateVersionRaw === "number" && Number.isSafeInteger(templateVersionRaw) ? templateVersionRaw : null;
    const tool =
      typeof parsed.tool === "object" && parsed.tool !== null ? (parsed.tool as Record<string, unknown>) : null;
    const toolVersion = typeof tool?.version === "string" ? tool.version : null;
    return { exists: true, templateVersion, toolVersion };
  } catch {
    return { exists: true, templateVersion: null, toolVersion: null };
  }
}

export async function checkVibeScaffoldUpdate(
  options: { cwd?: string; toolPackageName?: string; toolVersion?: string } = {},
): Promise<VibeScaffoldCheckResult> {
  const cwd = options.cwd ?? process.cwd();
  const metadataPath = path.join(cwd, SCAFFOLD_METADATA_RELATIVE_PATH);
  const identity = resolveToolIdentity(options);
  const targetTemplateVersion = VIBE_SCAFFOLD_TEMPLATE_VERSION;

  if (!(await isDirectory(path.join(cwd, ".vibe")))) {
    return {
      status: "not-initialized",
      updateAvailable: false,
      reason: "No .vibe directory found in current workspace.",
      targetTemplateVersion,
      localTemplateVersion: null,
      metadataPath,
      localToolVersion: null,
      targetToolVersion: identity.version,
    };
  }

  const metadata = await readScaffoldMetadataVersions(metadataPath);
  if (!metadata.exists) {
    return {
      status: "update-available",
      updateAvailable: true,
      reason: "Scaffold metadata missing; run `vibe update` to write baseline metadata.",
      targetTemplateVersion,
      localTemplateVersion: null,
      metadataPath,
      localToolVersion: null,
      targetToolVersion: identity.version,
    };
  }

  if (metadata.templateVersion === null) {
    return {
      status: "update-available",
      updateAvailable: true,
      reason: "Scaffold metadata is missing/invalid template version.",
      targetTemplateVersion,
      localTemplateVersion: null,
      metadataPath,
      localToolVersion: metadata.toolVersion,
      targetToolVersion: identity.version,
    };
  }

  if (metadata.templateVersion < targetTemplateVersion) {
    return {
      status: "update-available",
      updateAvailable: true,
      reason: `Scaffold template ${metadata.templateVersion} is behind target ${targetTemplateVersion}.`,
      targetTemplateVersion,
      localTemplateVersion: metadata.templateVersion,
      metadataPath,
      localToolVersion: metadata.toolVersion,
      targetToolVersion: identity.version,
    };
  }

  return {
    status: "up-to-date",
    updateAvailable: false,
    reason:
      metadata.templateVersion > targetTemplateVersion
        ? `Local scaffold template ${metadata.templateVersion} is newer than this CLI target ${targetTemplateVersion}.`
        : "Scaffold template is up to date.",
    targetTemplateVersion,
    localTemplateVersion: metadata.templateVersion,
    metadataPath,
    localToolVersion: metadata.toolVersion,
    targetToolVersion: identity.version,
  };
}

export async function applyVibeScaffoldUpdate(options: VibeScaffoldUpdateOptions): Promise<VibeScaffoldUpdateResult> {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun;
  const identity = resolveToolIdentity(options);
  const check = await checkVibeScaffoldUpdate({ cwd, toolPackageName: identity.packageName, toolVersion: identity.version });
  const result: VibeScaffoldUpdateResult = {
    check,
    dryRun,
    applied: false,
    previews: [],
    created: [],
    updated: [],
    unchanged: [],
  };

  if (check.status === "not-initialized" || !check.updateAvailable) {
    return result;
  }

  for (const relativeDir of VIBE_DIRECTORIES) {
    await ensureDirectory(path.join(cwd, relativeDir), dryRun, result);
  }

  await upsertManagedTextFile(path.join(cwd, ".vibe", "contract.yml"), DEFAULT_CONTRACT_YAML, dryRun, result, result.previews);
  await upsertManagedTextFile(path.join(cwd, ".vibe", "ownership.yml"), DEFAULT_OWNERSHIP_YAML, dryRun, result, result.previews);
  await ensureFile(
    path.join(cwd, ".vibe", "artifacts", "postflight.json"),
    buildDefaultPostflightJson(new Date().toISOString()),
    dryRun,
    result,
  );
  await upsertManagedTextFile(
    path.join(cwd, SCAFFOLD_METADATA_RELATIVE_PATH),
    buildScaffoldMetadataJson(identity),
    dryRun,
    result,
    result.previews,
  );
  await upsertAgentSnippet(path.join(cwd, "AGENTS.md"), dryRun, result, result.previews);
  await upsertReadmeWorkflowSection(path.join(cwd, "README.md"), dryRun, result, result.previews);
  await upsertGitignoreEntries(path.join(cwd, ".gitignore"), dryRun, result, result.previews);

  result.applied = !dryRun;
  return result;
}

export async function scaffoldVibeInit(options: InitScaffoldOptions): Promise<InitScaffoldResult> {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun;
  const identity = resolveToolIdentity(options);
  const result: InitScaffoldResult = {
    created: [],
    updated: [],
    unchanged: [],
  };

  for (const relativeDir of VIBE_DIRECTORIES) {
    await ensureDirectory(path.join(cwd, relativeDir), dryRun, result);
  }

  await ensureFile(path.join(cwd, ".vibe", "contract.yml"), DEFAULT_CONTRACT_YAML, dryRun, result);
  await ensureFile(path.join(cwd, ".vibe", "ownership.yml"), DEFAULT_OWNERSHIP_YAML, dryRun, result);
  await ensureFile(path.join(cwd, SCAFFOLD_METADATA_RELATIVE_PATH), buildScaffoldMetadataJson(identity), dryRun, result);
  await ensureFile(
    path.join(cwd, ".vibe", "artifacts", "postflight.json"),
    buildDefaultPostflightJson(new Date().toISOString()),
    dryRun,
    result,
  );
  await upsertAgentSnippet(path.join(cwd, "AGENTS.md"), dryRun, result);
  await upsertReadmeWorkflowSection(path.join(cwd, "README.md"), dryRun, result);
  await upsertGitignoreEntries(path.join(cwd, ".gitignore"), dryRun, result);

  return result;
}
