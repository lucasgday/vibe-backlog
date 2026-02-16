import { promises as fs } from "node:fs";
import path from "node:path";

const TURN_FILE = path.join(".vibe", "runtime", "turn.json");

export type TurnContext = {
  issue_id: number;
  branch: string;
  base_branch: string;
  started_at: string;
  issue_title: string;
};

export type TurnContextOptions = {
  workspaceRoot?: string;
};

function getWorkspaceRoot(options: TurnContextOptions): string {
  return options.workspaceRoot ?? process.cwd();
}

export function getTurnContextPath(options: TurnContextOptions = {}): string {
  return path.resolve(getWorkspaceRoot(options), TURN_FILE);
}

export function slugifyTurnText(value: string): string {
  const compactSpaces = value.trim().toLowerCase().replace(/\s+/g, "-");
  const sanitized = compactSpaces.replace(/[^a-z0-9-]/g, "");
  return sanitized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildTurnBranch(issueId: number, slugSource: string): string {
  const fallbackSlug = `issue-${issueId}`;
  const slug = slugifyTurnText(slugSource) || fallbackSlug;
  return `issue-${issueId}-${slug}`;
}

export function validateTurnContext(turn: Partial<TurnContext> | null): string[] {
  const errors: string[] = [];

  if (!turn) {
    return ["turn context is missing"];
  }

  if (!Number.isSafeInteger(turn.issue_id) || (turn.issue_id ?? 0) <= 0) {
    errors.push("issue_id");
  }

  if (typeof turn.branch !== "string" || !turn.branch.trim()) {
    errors.push("branch");
  }

  if (typeof turn.base_branch !== "string" || !turn.base_branch.trim()) {
    errors.push("base_branch");
  }

  return errors;
}

export async function readTurnContext(options: TurnContextOptions = {}): Promise<TurnContext | null> {
  const filePath = getTurnContextPath(options);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TurnContext;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeTurnContext(turn: TurnContext, options: TurnContextOptions = {}): Promise<string> {
  const filePath = getTurnContextPath(options);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(turn, null, 2)}\n`, "utf8");
  return filePath;
}

export async function clearTurnContext(options: TurnContextOptions = {}): Promise<boolean> {
  const filePath = getTurnContextPath(options);

  try {
    await fs.rm(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
