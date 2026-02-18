import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type TrackerMilestoneDefinition = {
  title: string;
  description: string;
};

export type TrackerLabelDefinition = {
  name: string;
  color: string;
  description: string;
};

type ExecaFn = typeof execa;
type JsonRecord = Record<string, unknown>;

const GH_API_PAGE_SIZE = 100;
const LABEL_SIGNAL_WEIGHT = 5;
const TITLE_SIGNAL_WEIGHT = 3;
const BODY_SIGNAL_WEIGHT = 1;
const MODULE_RATIO_THRESHOLD = 1.5;
const MILESTONE_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_DELIVERY_OBJECTIVE = "Delivery Goal";
const GENERATED_MILESTONE_DESCRIPTION = "Auto-generated delivery milestone by vibe tracker reconcile.";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "between",
  "about",
  "after",
  "before",
  "issue",
  "open",
  "closed",
  "create",
  "update",
  "fix",
  "feat",
  "chore",
  "task",
  "todo",
  "when",
  "then",
  "there",
  "their",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "can",
  "cannot",
  "cant",
  "was",
  "were",
  "are",
  "is",
  "you",
  "your",
  "our",
  "its",
  "they",
  "them",
  "what",
  "why",
  "how",
  "out",
  "all",
  "any",
  "not",
  "but",
  "only",
  "just",
  "very",
  "more",
  "less",
  "each",
  "per",
  "new",
]);

export const TRACKER_BOOTSTRAP_MILESTONES: readonly TrackerMilestoneDefinition[] = [];

export const TRACKER_BOOTSTRAP_LABELS: readonly TrackerLabelDefinition[] = [
  {
    name: "module:cli",
    color: "0052CC",
    description: "CLI commands and terminal UX",
  },
  {
    name: "module:ui",
    color: "5319E7",
    description: "UI app and frontend workflows",
  },
  {
    name: "module:docs",
    color: "1D76DB",
    description: "Documentation and guides",
  },
  {
    name: "module:tracker",
    color: "B60205",
    description: "GitHub issue/PR tracker synchronization",
  },
  {
    name: "module:turn",
    color: "0E8A16",
    description: "Turn context lifecycle and guardrails",
  },
  {
    name: "module:templates",
    color: "FBCA04",
    description: "Generated templates/scaffolds and marker-safe files",
  },
];

const TRACKER_BOOTSTRAP_MARKER = path.join(".vibe", "runtime", "tracker-bootstrap.json");

type TrackerIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  milestone: string | null;
  state: string;
};

type ModuleProfile = {
  label: string;
  tokenWeights: Map<string, number>;
  slugTokens: string[];
};

export type SemanticMilestoneSuggestion = {
  milestoneTitle: string | null;
  source: "inferred" | "generated" | "fallback" | "none";
  confidence: number | null;
  suggestions: string[];
  modules: string[];
  requiresCreation: boolean;
};

export type TrackerReconcilePromptRequest = {
  kind: "module" | "milestone";
  issueNumber: number;
  issueTitle: string;
  suggestions: string[];
};

export type TrackerReconcilePromptFn = (request: TrackerReconcilePromptRequest) => Promise<string | null>;

export type TrackerReconcileOptions = {
  dryRun: boolean;
  fallbackModule?: string | null;
  fallbackMilestone?: string | null;
};

export type TrackerReconcileIssueUpdate = {
  issueNumber: number;
  issueTitle: string;
  addLabels: string[];
  setMilestone: string | null;
  moduleSource: "existing" | "explicit" | "scored" | "fallback" | "prompt" | "none";
  moduleConfidence: number | null;
  milestoneSource: "existing" | "inferred" | "generated" | "fallback" | "prompt" | "none";
  milestoneConfidence: number | null;
  notes: string[];
};

export type TrackerReconcileResult = {
  repo: string;
  dryRun: boolean;
  applied: boolean;
  degradedToPlanOnly: boolean;
  planOnlyReason: string | null;
  issueUpdates: TrackerReconcileIssueUpdate[];
  unresolvedIssueIds: number[];
  createdLabels: string[];
  createdMilestones: string[];
  commands: string[][];
};

export type TrackerReconcileDependencies = {
  execaFn?: ExecaFn;
  promptFn?: TrackerReconcilePromptFn;
  isInteractive?: boolean;
};

export function getTrackerBootstrapMarkerPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, TRACKER_BOOTSTRAP_MARKER);
}

function normalizeTrackerLabelName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeMilestoneTitle(value: string): string {
  return value.trim().toLowerCase();
}

function toTitleCaseToken(token: string): string {
  if (!token) return token;
  if (token.length === 1) return token.toUpperCase();
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

function dedupeTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function moduleAreaName(moduleLabel: string): string {
  const slug = moduleLabel.trim().toLowerCase().replace(/^module:/, "");
  if (!slug) return "";
  const tokens = slug
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.map(toTitleCaseToken).join(" ");
}

function issueGoalTokens(issue: TrackerIssueSnapshot, modules: string[]): string[] {
  const moduleTokens = new Set<string>();
  for (const moduleLabel of modules) {
    for (const token of extractModuleSlugTokens(moduleLabel)) {
      moduleTokens.add(token.toLowerCase());
    }
  }

  const merged = dedupeTokens([...tokenizeText(issue.title), ...tokenizeText(issue.body)]);
  return merged.filter((token) => !moduleTokens.has(token));
}

function inferAreaFromIssue(issue: TrackerIssueSnapshot, modules: string[]): string {
  for (const moduleLabel of modules) {
    const area = moduleAreaName(moduleLabel);
    if (area) return area;
  }

  const titleTokens = dedupeTokens(tokenizeText(issue.title));
  if (titleTokens.length) {
    return titleTokens.slice(0, 2).map(toTitleCaseToken).join(" ");
  }

  return "Product";
}

export function buildDeliveryGoalMilestoneTitle(issue: {
  title: string;
  body?: string;
  labels?: string[];
}, modules: string[]): string {
  const synthetic: TrackerIssueSnapshot = {
    number: 0,
    title: issue.title.trim(),
    body: typeof issue.body === "string" ? issue.body : "",
    labels: Array.isArray(issue.labels) ? issue.labels.slice() : [],
    milestone: null,
    state: "open",
  };
  const area = inferAreaFromIssue(synthetic, modules);
  const goalTokens = issueGoalTokens(synthetic, modules);
  const goal = (goalTokens.length ? goalTokens.slice(0, 4) : [DEFAULT_DELIVERY_OBJECTIVE.toLowerCase()])
    .map(toTitleCaseToken)
    .join(" ");

  return `${area}: ${goal}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

function parseLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === "string") {
          return name.trim();
        }
      }
      return "";
    })
    .filter(Boolean);
}

function parseIssueSnapshotsFromApiRows(rows: JsonRecord[]): TrackerIssueSnapshot[] {
  const snapshots: TrackerIssueSnapshot[] = [];

  for (const row of rows) {
    if (typeof row.pull_request === "object" && row.pull_request !== null) {
      continue;
    }

    const number = row.number;
    const title = row.title;
    const state = row.state;

    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof state !== "string" || !state.trim()) continue;

    const milestoneRaw = row.milestone;
    const milestone =
      typeof milestoneRaw === "object" &&
      milestoneRaw !== null &&
      typeof (milestoneRaw as Record<string, unknown>).title === "string"
        ? String((milestoneRaw as Record<string, unknown>).title).trim() || null
        : null;

    const body = typeof row.body === "string" ? row.body : "";

    snapshots.push({
      number,
      title: title.trim(),
      body,
      labels: parseLabelNames(row.labels),
      milestone,
      state: state.trim().toLowerCase(),
    });
  }

  return snapshots;
}

function parseMilestoneTitles(rows: JsonRecord[]): string[] {
  return rows
    .map((row) => row.title)
    .filter((value): value is string => typeof value === "string")
    .map((title) => title.trim())
    .filter(Boolean);
}

function parseRepositoryLabelNames(rows: JsonRecord[]): string[] {
  return rows
    .map((row) => row.name)
    .filter((value): value is string => typeof value === "string")
    .map((name) => name.trim())
    .filter(Boolean);
}

function upsertWeightedToken(map: Map<string, number>, token: string, weight: number): void {
  if (!token) return;
  map.set(token, (map.get(token) ?? 0) + weight);
}

function normalizeModuleLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutPrefix = normalizeTrackerLabelName(trimmed).startsWith("module:")
    ? trimmed.trim().slice(trimmed.toLowerCase().indexOf(":") + 1)
    : trimmed;

  const slug = withoutPrefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) return null;
  return `module:${slug}`;
}

function extractModuleSlugTokens(moduleLabel: string): string[] {
  const slug = moduleLabel.trim().toLowerCase().replace(/^module:/, "");
  if (!slug) return [];
  return slug
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function extractModuleLabelMap(labelNames: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const label of labelNames) {
    const normalized = normalizeTrackerLabelName(label);
    if (!normalized.startsWith("module:")) continue;
    if (!map.has(normalized)) {
      map.set(normalized, label.trim());
    }
  }
  return map;
}

export function sanitizeTrackerText(value: string): string {
  return value
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\[\]{}()<>*_~#|]/g, " ")
    .replace(/["'.,:;!?\\/+\-=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeText(value: string): string[] {
  const cleaned = sanitizeTrackerText(value);
  if (!cleaned) return [];

  return cleaned
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token));
}

function tokenizeLabels(labels: string[]): string[] {
  const tokens: string[] = [];

  for (const label of labels) {
    const normalized = normalizeTrackerLabelName(label);
    if (normalized.startsWith("status:")) continue;
    tokens.push(...tokenizeText(label));
  }

  return tokens;
}

function buildIssueTokenWeights(issue: TrackerIssueSnapshot): Map<string, number> {
  const tokens = new Map<string, number>();

  for (const token of tokenizeLabels(issue.labels)) {
    upsertWeightedToken(tokens, token, LABEL_SIGNAL_WEIGHT);
  }

  for (const token of tokenizeText(issue.title)) {
    upsertWeightedToken(tokens, token, TITLE_SIGNAL_WEIGHT);
  }

  for (const token of tokenizeText(issue.body)) {
    upsertWeightedToken(tokens, token, BODY_SIGNAL_WEIGHT);
  }

  return tokens;
}

function buildIssueTokenSet(issue: TrackerIssueSnapshot): Set<string> {
  const set = new Set<string>();
  for (const token of tokenizeLabels(issue.labels)) set.add(token);
  for (const token of tokenizeText(issue.title)) set.add(token);
  for (const token of tokenizeText(issue.body)) set.add(token);
  return set;
}

function issueModuleLabels(issue: TrackerIssueSnapshot): string[] {
  return issue.labels
    .map((label) => normalizeTrackerLabelName(label))
    .filter((label) => label.startsWith("module:"));
}

function buildModuleProfiles(moduleLabelMap: Map<string, string>, issues: TrackerIssueSnapshot[]): Map<string, ModuleProfile> {
  const profiles = new Map<string, ModuleProfile>();

  for (const [moduleLower, moduleLabel] of moduleLabelMap.entries()) {
    const tokenWeights = new Map<string, number>();
    const slugTokens = extractModuleSlugTokens(moduleLower);
    for (const token of slugTokens) {
      upsertWeightedToken(tokenWeights, token, LABEL_SIGNAL_WEIGHT + TITLE_SIGNAL_WEIGHT);
    }
    profiles.set(moduleLower, {
      label: moduleLabel,
      tokenWeights,
      slugTokens,
    });
  }

  for (const issue of issues) {
    const modules = issueModuleLabels(issue).filter((label) => profiles.has(label));
    if (!modules.length) continue;

    const labelTokens = tokenizeLabels(issue.labels);
    const titleTokens = tokenizeText(issue.title);
    const bodyTokens = tokenizeText(issue.body);

    for (const moduleLower of modules) {
      const profile = profiles.get(moduleLower);
      if (!profile) continue;

      for (const token of labelTokens) {
        upsertWeightedToken(profile.tokenWeights, token, LABEL_SIGNAL_WEIGHT);
      }
      for (const token of titleTokens) {
        upsertWeightedToken(profile.tokenWeights, token, TITLE_SIGNAL_WEIGHT);
      }
      for (const token of bodyTokens) {
        upsertWeightedToken(profile.tokenWeights, token, BODY_SIGNAL_WEIGHT);
      }
    }
  }

  return profiles;
}

function explicitModuleMatches(issue: TrackerIssueSnapshot, profiles: Map<string, ModuleProfile>): string[] {
  const tokenSet = buildIssueTokenSet(issue);
  const matched: string[] = [];

  for (const [moduleLower, profile] of profiles.entries()) {
    if (!profile.slugTokens.length) continue;

    const slugTokenMatches = profile.slugTokens.every((token) => tokenSet.has(token));
    if (slugTokenMatches) {
      matched.push(moduleLower);
    }
  }

  matched.sort((a, b) => a.localeCompare(b));
  return matched;
}

function scoreModules(issue: TrackerIssueSnapshot, profiles: Map<string, ModuleProfile>): Array<{ module: string; score: number }> {
  const issueWeights = buildIssueTokenWeights(issue);
  const scored: Array<{ module: string; score: number }> = [];

  for (const [moduleLower, profile] of profiles.entries()) {
    let score = 0;
    for (const [token, tokenWeight] of issueWeights.entries()) {
      const modelWeight = profile.tokenWeights.get(token);
      if (!modelWeight) continue;
      score += tokenWeight * modelWeight;
    }

    if (score > 0) {
      scored.push({ module: moduleLower, score });
    }
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.module.localeCompare(right.module);
  });

  return scored;
}

function inferModules(issue: TrackerIssueSnapshot, profiles: Map<string, ModuleProfile>): {
  modules: string[];
  source: "explicit" | "scored" | "none";
  confidence: number | null;
  suggestions: string[];
} {
  const explicit = explicitModuleMatches(issue, profiles);
  if (explicit.length > 0) {
    return {
      modules: explicit,
      source: "explicit",
      confidence: 1,
      suggestions: explicit,
    };
  }

  const scored = scoreModules(issue, profiles);
  const suggestions = scored.slice(0, 3).map((entry) => entry.module);

  if (!scored.length) {
    return {
      modules: [],
      source: "none",
      confidence: null,
      suggestions,
    };
  }

  const top = scored[0];
  const second = scored[1] ?? null;

  if (!second || second.score <= 0) {
    return {
      modules: [top.module],
      source: "scored",
      confidence: 999,
      suggestions,
    };
  }

  const ratio = top.score / second.score;
  if (ratio >= MODULE_RATIO_THRESHOLD) {
    return {
      modules: [top.module],
      source: "scored",
      confidence: ratio,
      suggestions,
    };
  }

  return {
    modules: [],
    source: "none",
    confidence: ratio,
    suggestions,
  };
}

function buildMilestoneCountsByModule(
  issues: TrackerIssueSnapshot[],
  moduleLabelMap: Map<string, string>,
): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();

  for (const moduleLower of moduleLabelMap.keys()) {
    counts.set(moduleLower, new Map<string, number>());
  }

  for (const issue of issues) {
    if (!issue.milestone) continue;

    const moduleLabels = issueModuleLabels(issue).filter((label) => counts.has(label));
    if (!moduleLabels.length) continue;

    for (const moduleLower of moduleLabels) {
      const moduleCounts = counts.get(moduleLower);
      if (!moduleCounts) continue;
      moduleCounts.set(issue.milestone, (moduleCounts.get(issue.milestone) ?? 0) + 1);
    }
  }

  return counts;
}

function inferMilestone(
  modules: string[],
  milestoneCountsByModule: Map<string, Map<string, number>>,
): { milestone: string | null; confidence: number | null; suggestions: string[] } {
  const aggregate = new Map<string, number>();

  for (const moduleLower of modules) {
    const moduleCounts = milestoneCountsByModule.get(moduleLower);
    if (!moduleCounts) continue;

    for (const [milestone, count] of moduleCounts.entries()) {
      aggregate.set(milestone, (aggregate.get(milestone) ?? 0) + count);
    }
  }

  const ordered = Array.from(aggregate.entries()).sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });

  const suggestions = ordered.slice(0, 3).map(([milestone]) => milestone);
  if (!ordered.length) {
    return {
      milestone: null,
      confidence: null,
      suggestions,
    };
  }

  const [topMilestone, topCount] = ordered[0];
  const secondCount = ordered[1]?.[1] ?? 0;
  const totalCount = ordered.reduce((acc, entry) => acc + entry[1], 0);

  if (topCount === secondCount) {
    return {
      milestone: null,
      confidence: totalCount ? topCount / totalCount : null,
      suggestions,
    };
  }

  const confidence = totalCount ? topCount / totalCount : 0;
  if (confidence >= MILESTONE_CONFIDENCE_THRESHOLD) {
    return {
      milestone: topMilestone,
      confidence,
      suggestions,
    };
  }

  return {
    milestone: null,
    confidence,
    suggestions,
  };
}

function colorFromSeed(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const color = (hash >>> 0) & 0xffffff;
  return color.toString(16).toUpperCase().padStart(6, "0");
}

function buildGeneratedModuleLabelDefinition(name: string): TrackerLabelDefinition {
  return {
    name,
    color: colorFromSeed(name),
    description: "Generated module label by vibe tracker reconcile",
  };
}

function buildGeneratedMilestoneDefinition(title: string): TrackerMilestoneDefinition {
  return {
    title,
    description: GENERATED_MILESTONE_DESCRIPTION,
  };
}

async function resolveRepoNameWithOwner(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stdio: "pipe",
  });
  const slug = response.stdout.trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("tracker reconcile: unable to resolve repository owner/name from gh");
  }
  return slug;
}

async function listPaginatedGhApiRecords(execaFn: ExecaFn, endpoint: string, context: string): Promise<JsonRecord[]> {
  const all: JsonRecord[] = [];

  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const paginatedEndpoint = `${endpoint}${separator}per_page=${GH_API_PAGE_SIZE}&page=${page}`;
    const response = await execaFn("gh", ["api", paginatedEndpoint], { stdio: "pipe" });
    const parsed = parseJsonArray(response.stdout, context);
    all.push(...parsed);

    if (parsed.length < GH_API_PAGE_SIZE) {
      break;
    }
  }

  return all;
}

async function listRepositoryLabelNames(execaFn: ExecaFn, repo: string): Promise<string[]> {
  const rows = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/labels`, "gh labels");
  return parseRepositoryLabelNames(rows);
}

async function listRepositoryMilestoneTitles(execaFn: ExecaFn, repo: string): Promise<string[]> {
  const rows = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/milestones?state=all`, "gh milestones");
  return parseMilestoneTitles(rows);
}

async function listRepositoryIssues(execaFn: ExecaFn, repo: string): Promise<TrackerIssueSnapshot[]> {
  const rows = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/issues?state=all`, "gh issues");
  return parseIssueSnapshotsFromApiRows(rows);
}

function canonicalizeModuleLabel(input: string, moduleLabelMap: Map<string, string>): string {
  const normalized = normalizeTrackerLabelName(input);
  return moduleLabelMap.get(normalized) ?? normalized;
}

function canonicalizeMilestoneTitle(
  input: string,
  milestoneTitleMap: Map<string, string>,
): string | null {
  const normalized = normalizeMilestoneTitle(input);
  return milestoneTitleMap.get(normalized) ?? null;
}

type TrackerSemanticContext = {
  moduleLabelMap: Map<string, string>;
  milestoneTitles: string[];
  milestoneTitleMap: Map<string, string>;
  moduleProfiles: Map<string, ModuleProfile>;
  milestoneCountsByModule: Map<string, Map<string, number>>;
};

function buildTrackerSemanticContext(params: {
  labelNames: string[];
  milestoneTitles: string[];
  allIssues: TrackerIssueSnapshot[];
}): TrackerSemanticContext {
  const moduleLabelMap = extractModuleLabelMap(params.labelNames);
  const milestoneTitleMap = new Map<string, string>();
  for (const title of params.milestoneTitles) {
    const key = normalizeMilestoneTitle(title);
    if (!milestoneTitleMap.has(key)) {
      milestoneTitleMap.set(key, title);
    }
  }

  const trainingIssues = params.allIssues.filter((issue) => issueModuleLabels(issue).length > 0);
  const moduleProfiles = buildModuleProfiles(moduleLabelMap, trainingIssues);
  const milestoneCountsByModule = buildMilestoneCountsByModule(trainingIssues, moduleLabelMap);

  return {
    moduleLabelMap,
    milestoneTitles: params.milestoneTitles.slice(),
    milestoneTitleMap,
    moduleProfiles,
    milestoneCountsByModule,
  };
}

function resolveSemanticMilestoneFromContext(params: {
  issue: TrackerIssueSnapshot;
  modules: string[];
  context: TrackerSemanticContext;
  fallbackMilestone: string | null;
}): SemanticMilestoneSuggestion {
  const { issue, modules, context, fallbackMilestone } = params;

  const inferred = inferMilestone(modules, context.milestoneCountsByModule);
  if (inferred.milestone) {
    return {
      milestoneTitle: inferred.milestone,
      source: "inferred",
      confidence: inferred.confidence,
      suggestions: inferred.suggestions,
      modules,
      requiresCreation: false,
    };
  }

  if (fallbackMilestone) {
    return {
      milestoneTitle: fallbackMilestone,
      source: "fallback",
      confidence: null,
      suggestions: inferred.suggestions,
      modules,
      requiresCreation: false,
    };
  }

  const generated = buildDeliveryGoalMilestoneTitle(issue, modules);
  const canonicalExisting = canonicalizeMilestoneTitle(generated, context.milestoneTitleMap);
  if (canonicalExisting) {
    return {
      milestoneTitle: canonicalExisting,
      source: "inferred",
      confidence: inferred.confidence,
      suggestions: inferred.suggestions,
      modules,
      requiresCreation: false,
    };
  }

  return {
    milestoneTitle: generated || null,
    source: generated ? "generated" : "none",
    confidence: inferred.confidence,
    suggestions: inferred.suggestions.length ? inferred.suggestions : context.milestoneTitles.slice(0, 5),
    modules,
    requiresCreation: Boolean(generated),
  };
}

export async function suggestSemanticMilestoneForIssue(
  params: {
    title: string;
    body?: string;
    labels?: string[];
    fallbackMilestone?: string | null;
  },
  dependencies: {
    execaFn?: ExecaFn;
    repo?: string | null;
  } = {},
): Promise<SemanticMilestoneSuggestion> {
  const execaFn = dependencies.execaFn ?? execa;
  const repo = dependencies.repo?.trim() ? dependencies.repo.trim() : await resolveRepoNameWithOwner(execaFn);
  const [labelNames, milestoneTitles, allIssues] = await Promise.all([
    listRepositoryLabelNames(execaFn, repo),
    listRepositoryMilestoneTitles(execaFn, repo),
    listRepositoryIssues(execaFn, repo),
  ]);

  const context = buildTrackerSemanticContext({
    labelNames,
    milestoneTitles,
    allIssues,
  });

  const syntheticIssue: TrackerIssueSnapshot = {
    number: 0,
    title: params.title.trim(),
    body: typeof params.body === "string" ? params.body : "",
    labels: Array.isArray(params.labels) ? params.labels.slice() : [],
    milestone: null,
    state: "open",
  };

  const existingModules = issueModuleLabels(syntheticIssue).map((moduleLower) =>
    canonicalizeModuleLabel(moduleLower, context.moduleLabelMap),
  );
  const inferredModules = inferModules(syntheticIssue, context.moduleProfiles);
  const modules = inferredModules.modules.length
    ? inferredModules.modules.map((moduleLower) => canonicalizeModuleLabel(moduleLower, context.moduleLabelMap))
    : existingModules;
  const effectiveModules = Array.from(new Set(modules.map((moduleLabel) => normalizeTrackerLabelName(moduleLabel))));

  const fallbackRaw = typeof params.fallbackMilestone === "string" ? params.fallbackMilestone.trim() : "";
  const fallbackMilestone = fallbackRaw ? canonicalizeMilestoneTitle(fallbackRaw, context.milestoneTitleMap) : null;
  return resolveSemanticMilestoneFromContext({
    issue: syntheticIssue,
    modules: effectiveModules,
    context,
    fallbackMilestone,
  });
}

export async function ensureRepositoryMilestone(params: {
  execaFn?: ExecaFn;
  repo?: string | null;
  title: string;
  description?: string | null;
}): Promise<{ repo: string; milestoneTitle: string; created: boolean }> {
  const execaFn = params.execaFn ?? execa;
  const repo = params.repo?.trim() ? params.repo.trim() : await resolveRepoNameWithOwner(execaFn);
  const milestoneTitle = params.title.trim();
  if (!milestoneTitle) {
    throw new Error("tracker: milestone title cannot be empty.");
  }

  const milestoneTitles = await listRepositoryMilestoneTitles(execaFn, repo);
  const milestoneMap = new Map<string, string>();
  for (const title of milestoneTitles) {
    const key = normalizeMilestoneTitle(title);
    if (!milestoneMap.has(key)) {
      milestoneMap.set(key, title);
    }
  }

  const existing = canonicalizeMilestoneTitle(milestoneTitle, milestoneMap);
  if (existing) {
    return {
      repo,
      milestoneTitle: existing,
      created: false,
    };
  }

  const description = typeof params.description === "string" && params.description.trim() ? params.description.trim() : GENERATED_MILESTONE_DESCRIPTION;
  await execaFn("gh", ["api", "--method", "POST", `repos/${repo}/milestones`, "-f", `title=${milestoneTitle}`, "-f", `description=${description}`], {
    stdio: "pipe",
  });

  return {
    repo,
    milestoneTitle,
    created: true,
  };
}

export function selectMissingTrackerMilestones(existingTitles: Iterable<string>): TrackerMilestoneDefinition[] {
  const existing = new Set(
    Array.from(existingTitles)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return TRACKER_BOOTSTRAP_MILESTONES.filter((milestone) => !existing.has(milestone.title));
}

export function selectMissingTrackerLabels(existingNames: Iterable<string>): TrackerLabelDefinition[] {
  const existing = new Set(
    Array.from(existingNames)
      .map(normalizeTrackerLabelName)
      .filter(Boolean),
  );
  return TRACKER_BOOTSTRAP_LABELS.filter((label) => !existing.has(normalizeTrackerLabelName(label.name)));
}

export async function shouldSuggestTrackerBootstrap(cwd: string = process.cwd()): Promise<boolean> {
  const vibePath = path.resolve(cwd, ".vibe");

  try {
    const vibeStat = await stat(vibePath);
    if (!vibeStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    await stat(getTrackerBootstrapMarkerPath(cwd));
    return false;
  } catch {
    return true;
  }
}

export async function writeTrackerBootstrapMarker(
  nameWithOwner: string,
  options: {
    milestones?: Iterable<string>;
    labels?: Iterable<string>;
  } = {},
  cwd: string = process.cwd(),
): Promise<string> {
  const markerPath = getTrackerBootstrapMarkerPath(cwd);

  await mkdir(path.dirname(markerPath), { recursive: true });
  const milestones = Array.from(options.milestones ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const labels = Array.from(options.labels ?? TRACKER_BOOTSTRAP_LABELS.map((label) => label.name))
    .map((value) => value.trim())
    .filter(Boolean);

  const payload = {
    version: 1,
    configured_at: new Date().toISOString(),
    repository: nameWithOwner,
    milestones,
    labels,
  };

  await writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return markerPath;
}

export async function runTrackerReconcile(
  options: TrackerReconcileOptions,
  dependencies: TrackerReconcileDependencies = {},
): Promise<TrackerReconcileResult> {
  const execaFn = dependencies.execaFn ?? execa;
  const promptFn = dependencies.promptFn;
  const isInteractive = dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const fallbackModuleRaw = typeof options.fallbackModule === "string" ? options.fallbackModule.trim() : "";
  const fallbackModule = fallbackModuleRaw ? normalizeModuleLabel(fallbackModuleRaw) : null;
  if (fallbackModuleRaw && !fallbackModule) {
    throw new Error("tracker reconcile: --fallback-module must be a non-empty module label/name.");
  }

  const fallbackMilestoneRaw = typeof options.fallbackMilestone === "string" ? options.fallbackMilestone.trim() : "";

  const repo = await resolveRepoNameWithOwner(execaFn);
  const [labelNames, milestoneTitles, allIssues] = await Promise.all([
    listRepositoryLabelNames(execaFn, repo),
    listRepositoryMilestoneTitles(execaFn, repo),
    listRepositoryIssues(execaFn, repo),
  ]);

  const semanticContext = buildTrackerSemanticContext({
    labelNames,
    milestoneTitles,
    allIssues,
  });
  const { moduleLabelMap, milestoneTitleMap, moduleProfiles } = semanticContext;

  let fallbackMilestone: string | null = null;
  if (fallbackMilestoneRaw) {
    fallbackMilestone = canonicalizeMilestoneTitle(fallbackMilestoneRaw, milestoneTitleMap);
    if (!fallbackMilestone) {
      throw new Error(`tracker reconcile: --fallback-milestone '${fallbackMilestoneRaw}' does not exist in repository.`);
    }
  }

  const openIssues = allIssues
    .filter((issue) => issue.state === "open")
    .slice()
    .sort((left, right) => left.number - right.number);

  const issueUpdates: TrackerReconcileIssueUpdate[] = [];
  const unresolvedIssueIds: number[] = [];
  const missingDecisionIssueIds = new Set<number>();
  const labelsToCreate = new Set<string>();
  const milestonesToCreate = new Set<string>();

  for (const issue of openIssues) {
    const existingModuleLower = issueModuleLabels(issue);
    const existingModules = Array.from(new Set(existingModuleLower.map((label) => canonicalizeModuleLabel(label, moduleLabelMap)))).sort(
      (left, right) => left.localeCompare(right),
    );

    const missingModule = existingModules.length === 0;
    const missingMilestone = !issue.milestone;
    if (!missingModule && !missingMilestone) {
      continue;
    }

    let addModules: string[] = [];
    let moduleSource: TrackerReconcileIssueUpdate["moduleSource"] = missingModule ? "none" : "existing";
    let moduleConfidence: number | null = null;
    const notes: string[] = [];

    if (missingModule) {
      const inferredModules = inferModules(issue, moduleProfiles);
      if (inferredModules.modules.length > 0) {
        addModules = inferredModules.modules.map((moduleLower) => canonicalizeModuleLabel(moduleLower, moduleLabelMap));
        moduleSource = inferredModules.source;
        moduleConfidence = inferredModules.confidence;
      } else if (fallbackModule) {
        const canonical = canonicalizeModuleLabel(fallbackModule, moduleLabelMap);
        addModules = [canonical];
        moduleSource = "fallback";
      } else if (!options.dryRun && isInteractive && promptFn) {
        const promptValue = await promptFn({
          kind: "module",
          issueNumber: issue.number,
          issueTitle: issue.title,
          suggestions: inferredModules.suggestions.map((moduleLower) => canonicalizeModuleLabel(moduleLower, moduleLabelMap)),
        });

        const normalizedPromptModule = typeof promptValue === "string" ? normalizeModuleLabel(promptValue) : null;
        if (normalizedPromptModule) {
          const canonical = canonicalizeModuleLabel(normalizedPromptModule, moduleLabelMap);
          addModules = [canonical];
          moduleSource = "prompt";
          notes.push("module selected via prompt");
        } else {
          unresolvedIssueIds.push(issue.number);
          notes.push("module unresolved: prompt did not return a module label");
        }
      } else {
        unresolvedIssueIds.push(issue.number);
        notes.push("module unresolved: no semantic/fallback match");
      }
    }

    for (const moduleLabel of addModules) {
      const normalized = normalizeTrackerLabelName(moduleLabel);
      if (!moduleLabelMap.has(normalized)) {
        labelsToCreate.add(normalized);
      }
    }

    const effectiveModules = Array.from(new Set([...existingModules, ...addModules].map(normalizeTrackerLabelName))).sort((a, b) =>
      a.localeCompare(b),
    );

    let setMilestone: string | null = null;
    let milestoneSource: TrackerReconcileIssueUpdate["milestoneSource"] = missingMilestone ? "none" : "existing";
    let milestoneConfidence: number | null = null;

    if (missingMilestone) {
      const resolvedMilestone = resolveSemanticMilestoneFromContext({
        issue,
        modules: effectiveModules,
        context: semanticContext,
        fallbackMilestone,
      });

      if (resolvedMilestone.milestoneTitle) {
        setMilestone = resolvedMilestone.milestoneTitle;
        milestoneSource = resolvedMilestone.source;
        milestoneConfidence = resolvedMilestone.confidence;
        if (resolvedMilestone.requiresCreation) {
          milestonesToCreate.add(setMilestone);
          notes.push("milestone planned for creation");
        }
      } else if (!options.dryRun && isInteractive && promptFn && milestoneTitles.length > 0) {
        const promptValue = await promptFn({
          kind: "milestone",
          issueNumber: issue.number,
          issueTitle: issue.title,
          suggestions: resolvedMilestone.suggestions.length ? resolvedMilestone.suggestions : milestoneTitles,
        });
        const canonicalMilestone = typeof promptValue === "string" ? canonicalizeMilestoneTitle(promptValue, milestoneTitleMap) : null;
        if (canonicalMilestone) {
          setMilestone = canonicalMilestone;
          milestoneSource = "prompt";
          notes.push("milestone selected via prompt");
        }
      }

      if (!setMilestone) {
        if (!unresolvedIssueIds.includes(issue.number)) {
          unresolvedIssueIds.push(issue.number);
        }
        missingDecisionIssueIds.add(issue.number);
        notes.push("milestone unresolved: no semantic or prompt match");
      }
    }

    const canonicalAddModules = addModules
      .map((label) => canonicalizeModuleLabel(label, moduleLabelMap))
      .filter((label) => !existingModules.some((current) => normalizeTrackerLabelName(current) === normalizeTrackerLabelName(label)));

    const nextAddModules = Array.from(new Set(canonicalAddModules.map(normalizeTrackerLabelName)))
      .map((normalized) => moduleLabelMap.get(normalized) ?? normalized)
      .sort((left, right) => left.localeCompare(right));

    if (!nextAddModules.length && !setMilestone) {
      continue;
    }

    issueUpdates.push({
      issueNumber: issue.number,
      issueTitle: issue.title,
      addLabels: nextAddModules,
      setMilestone,
      moduleSource,
      moduleConfidence,
      milestoneSource,
      milestoneConfidence,
      notes,
    });
  }

  let degradedToPlanOnly = false;
  let planOnlyReason: string | null = null;

  if (!options.dryRun && missingDecisionIssueIds.size > 0) {
    degradedToPlanOnly = true;
    const ids = Array.from(missingDecisionIssueIds).sort((a, b) => a - b);
    planOnlyReason = `tracker reconcile: non-interactive plan-only mode for issues ${ids
      .map((id) => `#${id}`)
      .join(", ")} (provide fallbacks or run interactively).`;
  }

  const commands: string[][] = [];
  const createdLabels: string[] = [];
  const createdMilestones: string[] = [];

  const milestonesToCreateOrdered = Array.from(milestonesToCreate)
    .filter((title) => !milestoneTitleMap.has(normalizeMilestoneTitle(title)))
    .sort((left, right) => left.localeCompare(right));

  for (const milestoneTitle of milestonesToCreateOrdered) {
    const definition = buildGeneratedMilestoneDefinition(milestoneTitle);
    commands.push([
      "api",
      "--method",
      "POST",
      `repos/${repo}/milestones`,
      "-f",
      `title=${definition.title}`,
      "-f",
      `description=${definition.description}`,
    ]);
  }

  const labelsToCreateOrdered = Array.from(labelsToCreate)
    .filter((label) => !moduleLabelMap.has(label))
    .sort((left, right) => left.localeCompare(right));

  for (const labelLower of labelsToCreateOrdered) {
    const definition = buildGeneratedModuleLabelDefinition(labelLower);
    commands.push(["label", "create", definition.name, "--color", definition.color, "--description", definition.description]);
  }

  for (const update of issueUpdates) {
    const args = ["issue", "edit", String(update.issueNumber)];
    if (update.setMilestone) {
      args.push("--milestone", update.setMilestone);
    }
    if (update.addLabels.length > 0) {
      args.push("--add-label", update.addLabels.join(","));
    }
    commands.push(args);
  }

  const shouldApply = !options.dryRun && !degradedToPlanOnly;

  if (shouldApply) {
    for (const milestoneTitle of milestonesToCreateOrdered) {
      const definition = buildGeneratedMilestoneDefinition(milestoneTitle);
      await execaFn(
        "gh",
        ["api", "--method", "POST", `repos/${repo}/milestones`, "-f", `title=${definition.title}`, "-f", `description=${definition.description}`],
        { stdio: "inherit" },
      );
      milestoneTitleMap.set(normalizeMilestoneTitle(definition.title), definition.title);
      createdMilestones.push(definition.title);
    }

    for (const labelLower of labelsToCreateOrdered) {
      const definition = buildGeneratedModuleLabelDefinition(labelLower);
      await execaFn(
        "gh",
        ["label", "create", definition.name, "--color", definition.color, "--description", definition.description],
        { stdio: "inherit" },
      );
      moduleLabelMap.set(labelLower, definition.name);
      createdLabels.push(definition.name);
    }

    for (const update of issueUpdates) {
      const args = ["issue", "edit", String(update.issueNumber)];
      if (update.setMilestone) {
        const normalizedMilestone = normalizeMilestoneTitle(update.setMilestone);
        const canonicalMilestone = milestoneTitleMap.get(normalizedMilestone) ?? update.setMilestone;
        args.push("--milestone", canonicalMilestone);
      }
      if (update.addLabels.length > 0) {
        const canonicalLabels = update.addLabels
          .map((label) => {
            const normalized = normalizeTrackerLabelName(label);
            return moduleLabelMap.get(normalized) ?? label;
          })
          .sort((left, right) => left.localeCompare(right));
        args.push("--add-label", canonicalLabels.join(","));
      }

      await execaFn("gh", args, { stdio: "inherit" });
    }
  }

  return {
    repo,
    dryRun: options.dryRun,
    applied: shouldApply,
    degradedToPlanOnly,
    planOnlyReason,
    issueUpdates,
    unresolvedIssueIds: Array.from(new Set(unresolvedIssueIds)).sort((a, b) => a - b),
    createdLabels,
    createdMilestones,
    commands,
  };
}
