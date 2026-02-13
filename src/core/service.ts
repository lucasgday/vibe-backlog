import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_BACKLOG_FILE = "BACKLOG.md";
const MAX_BACKLOG_SIZE = 500_000;
const DEFAULT_BACKLOG_TEMPLATE = "# Featherlist Backlog\n\n";
const PRIMARY_ENV_KEY = "VIBE_BACKLOG_PATH";
const COMPAT_ENV_KEYS = ["FEATHERLIST_BACKLOG_PATH"];

export type BacklogDocument = {
  path: string;
  markdown: string;
  lastModified: string;
};

export type BacklogPathOptions = {
  workspaceRoot?: string;
  backlogPath?: string | null;
  env?: NodeJS.ProcessEnv;
};

function workspaceRoot(options: BacklogPathOptions): string {
  return options.workspaceRoot ?? process.cwd();
}

function isSubPath(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRawPath(options: BacklogPathOptions): string | undefined {
  if (options.backlogPath?.trim()) {
    return options.backlogPath.trim();
  }

  const env = options.env ?? process.env;
  const primaryPath = env[PRIMARY_ENV_KEY]?.trim();
  if (primaryPath) {
    return primaryPath;
  }

  for (const envKey of COMPAT_ENV_KEYS) {
    const compatPath = env[envKey]?.trim();
    if (compatPath) {
      return compatPath;
    }
  }

  return undefined;
}

function resolveBacklogPath(options: BacklogPathOptions): string {
  const rootPath = workspaceRoot(options);
  const fallbackPath = path.resolve(rootPath, DEFAULT_BACKLOG_FILE);
  const rawPath = resolveRawPath(options);

  if (!rawPath) {
    return fallbackPath;
  }

  const resolvedPath = path.resolve(rootPath, rawPath);
  if (!isSubPath(resolvedPath, rootPath)) {
    throw new Error("Backlog path must stay inside workspace");
  }

  if (path.basename(resolvedPath).toLowerCase().endsWith(".md") === false) {
    throw new Error("Backlog path must point to a markdown file");
  }

  return resolvedPath;
}

export function getBacklogFilePath(options: BacklogPathOptions = {}): string {
  return resolveBacklogPath(options);
}

async function ensureBacklogFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, DEFAULT_BACKLOG_TEMPLATE, "utf8");
  }
}

export async function readBacklog(options: BacklogPathOptions = {}): Promise<BacklogDocument> {
  const filePath = getBacklogFilePath(options);
  await ensureBacklogFile(filePath);

  const markdown = await fs.readFile(filePath, "utf8");
  const stats = await fs.stat(filePath);

  return {
    path: filePath,
    markdown,
    lastModified: stats.mtime.toISOString(),
  };
}

export async function saveBacklog(markdown: string, options: BacklogPathOptions = {}): Promise<BacklogDocument> {
  if (markdown.length > MAX_BACKLOG_SIZE) {
    throw new Error("Backlog content too large");
  }

  const filePath = getBacklogFilePath(options);
  await ensureBacklogFile(filePath);

  const normalized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  await fs.writeFile(filePath, normalized, "utf8");

  const stats = await fs.stat(filePath);
  return {
    path: filePath,
    markdown: normalized,
    lastModified: stats.mtime.toISOString(),
  };
}

