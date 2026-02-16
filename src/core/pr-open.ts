import { execa } from "execa";
import { readTurnContext, validateTurnContext } from "./turn";

type ExecaFn = typeof execa;

type JsonRecord = Record<string, unknown>;

type OpenPrSnapshot = {
  number: number;
  url: string | null;
  title: string | null;
};

type TurnResolution =
  | {
      state: "ok";
      issueId: number;
      branch: string;
      baseBranch: string;
    }
  | {
      state: "missing";
    }
  | {
      state: "invalid";
      reason: string;
    };

export type PrOpenCommandOptions = {
  issueOverride?: string | number | null;
  branchOverride?: string | null;
  baseBranchOverride?: string | null;
  dryRun: boolean;
};

export type PrOpenResult = {
  issueId: number;
  issueTitle: string;
  issueUrl: string | null;
  branch: string;
  baseBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  created: boolean;
  dryRun: boolean;
  body: string;
  title: string;
};

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

function parseJsonObject(stdout: string, context: string): JsonRecord {
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context}: expected object response`);
  }
  return parsed as JsonRecord;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function parsePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseIssueId(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function extractUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine.startsWith("http")) return null;
  return firstLine;
}

function extractPrNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/pull\/([0-9]+)\b/.exec(url);
  return match ? Number(match[1]) : null;
}

async function resolveCurrentBranch(execaFn: ExecaFn): Promise<string | null> {
  const response = await execaFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" });
  const branch = response.stdout.trim();
  if (!branch || branch === "HEAD") {
    return null;
  }
  return branch;
}

async function resolveTurnDefaults(): Promise<TurnResolution> {
  try {
    const activeTurn = await readTurnContext();
    if (!activeTurn) {
      return { state: "missing" };
    }

    const turnErrors = validateTurnContext(activeTurn);
    if (turnErrors.length > 0) {
      return {
        state: "invalid",
        reason: turnErrors.join(", "),
      };
    }

    return {
      state: "ok",
      issueId: activeTurn.issue_id,
      branch: activeTurn.branch,
      baseBranch: activeTurn.base_branch,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        state: "invalid",
        reason: "malformed turn.json",
      };
    }
    throw error;
  }
}

async function fetchIssueSnapshot(
  execaFn: ExecaFn,
  issueId: number,
): Promise<{ title: string; url: string | null }> {
  const response = await execaFn("gh", ["issue", "view", String(issueId), "--json", "title,url"], {
    stdio: "pipe",
  });
  const row = parseJsonObject(response.stdout, "gh issue view");
  const title = parseNullableString(row.title);
  if (!title) {
    throw new Error(`pr open: issue #${issueId} is missing title`);
  }

  return {
    title,
    url: parseNullableString(row.url),
  };
}

async function findOpenPrByHead(execaFn: ExecaFn, branch: string): Promise<OpenPrSnapshot | null> {
  const listed = await execaFn(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,title"],
    {
      stdio: "pipe",
    },
  );
  const rows = parseJsonArray(listed.stdout, "gh pr list");
  for (const row of rows) {
    const number = parsePositiveInt(row.number);
    if (!number) continue;
    return {
      number,
      url: parseNullableString(row.url),
      title: parseNullableString(row.title),
    };
  }
  return null;
}

function buildPrOpenTitle(issueId: number, issueTitle: string): string {
  return `#${issueId} ${issueTitle}`.slice(0, 240);
}

export function buildPrOpenBodyTemplate(params: {
  issueId: number;
  issueTitle: string;
  issueUrl: string | null;
  branch: string;
}): string {
  const lines = [
    "## Summary",
    `- Issue: #${params.issueId} ${params.issueTitle}`,
    `- Branch: \`${params.branch}\``,
  ];

  if (params.issueUrl) {
    lines.push(`- Issue URL: ${params.issueUrl}`);
  }

  lines.push(
    "",
    "## Architecture decisions",
    "- TODO: describe architecture decisions for this change.",
    "",
    "## Why these decisions were made",
    "- TODO: explain rationale and trade-offs.",
    "",
    "## Alternatives considered / rejected",
    "- TODO: list alternatives considered and why they were rejected.",
    "",
    `Fixes #${params.issueId}`,
  );

  return lines.join("\n");
}

async function createPullRequest(params: {
  execaFn: ExecaFn;
  issueId: number;
  issueTitle: string;
  issueUrl: string | null;
  branch: string;
  baseBranch: string;
  dryRun: boolean;
}): Promise<{ number: number | null; url: string | null; title: string; body: string }> {
  const title = buildPrOpenTitle(params.issueId, params.issueTitle);
  const body = buildPrOpenBodyTemplate({
    issueId: params.issueId,
    issueTitle: params.issueTitle,
    issueUrl: params.issueUrl,
    branch: params.branch,
  });

  if (params.dryRun) {
    return {
      number: null,
      url: null,
      title,
      body,
    };
  }

  const created = await params.execaFn(
    "gh",
    [
      "pr",
      "create",
      "--base",
      params.baseBranch,
      "--head",
      params.branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { stdio: "pipe" },
  );

  const url = extractUrl(created.stdout);
  const number = extractPrNumberFromUrl(url);
  if (number) {
    return {
      number,
      url,
      title,
      body,
    };
  }

  const opened = await findOpenPrByHead(params.execaFn, params.branch);
  if (!opened) {
    throw new Error(`pr open: unable to resolve PR created for branch '${params.branch}'`);
  }

  return {
    number: opened.number,
    url: opened.url,
    title,
    body,
  };
}

export async function runPrOpenCommand(
  options: PrOpenCommandOptions,
  execaFn: ExecaFn = execa,
): Promise<PrOpenResult> {
  const turnDefaults = await resolveTurnDefaults();

  const issueOverrideProvided =
    options.issueOverride !== undefined && options.issueOverride !== null && String(options.issueOverride).trim() !== "";
  const issueFromArgs = parseIssueId(options.issueOverride);
  if (issueOverrideProvided && !issueFromArgs) {
    throw new Error("pr open: --issue debe ser un entero positivo.");
  }

  const issueId = issueFromArgs ?? (turnDefaults.state === "ok" ? turnDefaults.issueId : null);
  if (!issueId) {
    if (turnDefaults.state === "invalid") {
      throw new Error(
        `pr open: active turn invalid (${turnDefaults.reason}). Use --issue <n> and --branch <name> or fix turn context.`,
      );
    }
    throw new Error("pr open: missing issue. Use --issue <n> or start an active turn.");
  }

  const branchFromArgs = options.branchOverride?.trim() || null;
  const branchFromTurn = turnDefaults.state === "ok" ? turnDefaults.branch : null;
  let branch = branchFromArgs ?? branchFromTurn;
  if (!branch) {
    branch = await resolveCurrentBranch(execaFn);
  }

  if (!branch) {
    throw new Error("pr open: missing branch. Use --branch <name> or start an active turn.");
  }

  const baseFromArgs = options.baseBranchOverride?.trim() || null;
  const baseFromTurn = turnDefaults.state === "ok" ? turnDefaults.baseBranch : null;
  const baseBranch = baseFromArgs ?? baseFromTurn ?? "main";

  const openPr = await findOpenPrByHead(execaFn, branch);
  if (openPr) {
    const issue = await fetchIssueSnapshot(execaFn, issueId);
    const title = buildPrOpenTitle(issueId, issue.title);
    const body = buildPrOpenBodyTemplate({
      issueId,
      issueTitle: issue.title,
      issueUrl: issue.url,
      branch,
    });

    return {
      issueId,
      issueTitle: issue.title,
      issueUrl: issue.url,
      branch,
      baseBranch,
      prNumber: openPr.number,
      prUrl: openPr.url,
      created: false,
      dryRun: options.dryRun,
      title,
      body,
    };
  }

  const issue = await fetchIssueSnapshot(execaFn, issueId);
  const created = await createPullRequest({
    execaFn,
    issueId,
    issueTitle: issue.title,
    issueUrl: issue.url,
    branch,
    baseBranch,
    dryRun: options.dryRun,
  });

  return {
    issueId,
    issueTitle: issue.title,
    issueUrl: issue.url,
    branch,
    baseBranch,
    prNumber: created.number,
    prUrl: created.url,
    created: !options.dryRun,
    dryRun: options.dryRun,
    title: created.title,
    body: created.body,
  };
}
