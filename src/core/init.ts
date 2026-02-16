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
};

const VIBE_DIRECTORIES = [".vibe", ".vibe/runtime", ".vibe/artifacts", ".vibe/templates", ".vibe/reviews", ".vibe/pills"];
const AGENT_SNIPPET_START = "<!-- vibe:agent-snippet:start -->";
const AGENT_SNIPPET_END = "<!-- vibe:agent-snippet:end -->";
const TRACKER_GITIGNORE_ENTRIES = [".vibe/runtime", ".vibe/artifacts"];

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

function buildAgentSnippetBlock(): string {
  const body = [
    "## Vibe Agent Workflow (Managed)",
    "- Run `node dist/cli.cjs preflight` before implementation.",
    "- Use one issue per topic and keep tracker labels/milestones updated.",
    "- Validate with `node dist/cli.cjs postflight` and apply updates with `node dist/cli.cjs postflight --apply`.",
  ].join("\n");

  return `${AGENT_SNIPPET_START}\n${body}\n${AGENT_SNIPPET_END}\n`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function pushChange(result: InitScaffoldResult, kind: keyof InitScaffoldResult, filePath: string): void {
  result[kind].push(filePath);
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

async function upsertAgentSnippet(agentsPath: string, dryRun: boolean, result: InitScaffoldResult): Promise<void> {
  const snippet = buildAgentSnippetBlock();
  const agentsExists = await pathExists(agentsPath);

  if (!agentsExists) {
    const content = `# AGENTS\n\n${snippet}`;
    if (!dryRun) {
      await writeFile(agentsPath, content, "utf8");
    }
    pushChange(result, "created", agentsPath);
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
}

async function upsertGitignoreEntries(gitignorePath: string, dryRun: boolean, result: InitScaffoldResult): Promise<void> {
  const exists = await pathExists(gitignorePath);
  if (!exists) {
    const content = `${TRACKER_GITIGNORE_ENTRIES.join("\n")}\n`;
    if (!dryRun) {
      await writeFile(gitignorePath, content, "utf8");
    }
    pushChange(result, "created", gitignorePath);
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
}

export async function scaffoldVibeInit(options: InitScaffoldOptions): Promise<InitScaffoldResult> {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun;
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
  await ensureFile(
    path.join(cwd, ".vibe", "artifacts", "postflight.json"),
    buildDefaultPostflightJson(new Date().toISOString()),
    dryRun,
    result,
  );
  await upsertAgentSnippet(path.join(cwd, "AGENTS.md"), dryRun, result);
  await upsertGitignoreEntries(path.join(cwd, ".gitignore"), dryRun, result);

  return result;
}
