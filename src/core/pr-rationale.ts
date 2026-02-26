type RationaleMode = "pr-open" | "review";

export type RationaleValidationSignal = {
  command: string;
  status: "pass" | "fail" | "warn" | "unknown";
};

export type RationaleReviewFindingsSignal = {
  total: number;
  unresolved?: number;
  severities?: string[];
};

export type RationaleSignals = {
  issueLabels?: string[];
  issueBody?: string | null;
  changedFiles?: string[];
  validation?: RationaleValidationSignal[];
  reviewFindings?: RationaleReviewFindingsSignal | null;
};

export type RationaleContext = {
  issueId: number;
  issueTitle: string;
  branch: string;
  mode: RationaleMode;
  signals?: RationaleSignals;
};

type RationaleSectionId = "architecture" | "why" | "alternatives";

type RationaleSectionDescriptor = {
  id: RationaleSectionId;
  headerRegex: RegExp;
  defaultHeading: string;
};

type RationaleSectionBounds = {
  header: string;
  start: number;
  contentStart: number;
  end: number;
  content: string;
};

export type RationaleSections = {
  architecture: string[];
  why: string[];
  alternatives: string[];
};

export type RationaleHeadings = {
  architecture?: string;
  why?: string;
  alternatives?: string;
};

const RATIONALE_SECTIONS: readonly RationaleSectionDescriptor[] = [
  {
    id: "architecture",
    headerRegex: /^##\s+Architecture decisions\s*$/im,
    defaultHeading: "## Architecture decisions",
  },
  {
    id: "why",
    headerRegex: /^##\s+Why\b.*$/im,
    defaultHeading: "## Why these decisions were made",
  },
  {
    id: "alternatives",
    headerRegex: /^##\s+Alternatives\b.*$/im,
    defaultHeading: "## Alternatives considered / rejected",
  },
];

const RATIONALE_AUTOCLOSE_FOOTER_REGEX = /^\s*(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+\s*$/im;
const TODO_PLACEHOLDER_LINE_REGEX = /(?:^|\r?\n)\s*(?:[-*]\s+)?TODO(?:\s*:|\b)/i;
const DOC_FILE_REGEX = /(?:^|\/)(?:README|CHANGELOG|SECURITY|CONTRIBUTING)\.md$/i;
const MARKDOWN_FILE_REGEX = /\.md$/i;

type ChangeProfile =
  | "unknown"
  | "docs-only"
  | "tests-only"
  | "code-only"
  | "code+tests"
  | "code+docs"
  | "code+tests+docs"
  | "mixed";

type RationaleFacts = {
  labels: string[];
  changedFiles: string[];
  labelModules: string[];
  fileModules: string[];
  modules: string[];
  hasChangedFileSignals: boolean;
  hasDocs: boolean;
  hasTests: boolean;
  hasCode: boolean;
  profile: ChangeProfile;
  sampleFiles: string[];
  issueThemes: string[];
  validationSignals: RationaleValidationSignal[];
  reviewFindings: RationaleReviewFindingsSignal | null;
};

function normalizeHeading(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim() ?? "";
  return trimmed || fallback;
}

function getSectionDescriptor(id: RationaleSectionId): RationaleSectionDescriptor {
  const found = RATIONALE_SECTIONS.find((section) => section.id === id);
  if (!found) {
    throw new Error(`unknown rationale section: ${id}`);
  }
  return found;
}

function normalizeList(values: readonly string[] | null | undefined): string[] {
  const deduped = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped].sort((a, b) => a.localeCompare(b));
}

function normalizePath(raw: string): string | null {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  return normalized || null;
}

function normalizePaths(values: readonly string[] | null | undefined): string[] {
  const deduped = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const normalized = normalizePath(value);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped].sort((a, b) => a.localeCompare(b));
}

function toModuleFromLabel(label: string): string | null {
  const match = /^module:(.+)$/i.exec(label.trim());
  if (!match) return null;
  const value = String(match[1] ?? "")
    .trim()
    .toLowerCase();
  return value || null;
}

function isDocFile(file: string): boolean {
  return DOC_FILE_REGEX.test(file) || file.startsWith("docs/") || MARKDOWN_FILE_REGEX.test(file);
}

function isTestFile(file: string): boolean {
  return file.startsWith("tests/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isCodeFile(file: string): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  return file.startsWith("src/") || file.startsWith("apps/") || file.startsWith("packages/");
}

function toModuleFromFile(file: string): string | null {
  const lower = file.toLowerCase();
  if (isDocFile(file)) return "docs";
  if (isTestFile(file)) return "tests";
  if (lower.startsWith("src/ui/") || lower.startsWith("ui/") || lower.startsWith("app/")) return "ui";
  if (lower.startsWith(".github/")) return "ci";
  if (lower.startsWith("templates/")) return "templates";
  if (lower.startsWith("src/core/tracker") || lower.startsWith("src/core/gh-issue") || lower.startsWith("src/core/gh-retry")) {
    return "tracker";
  }
  if (lower.startsWith("src/core/review")) return "review";
  if (lower.startsWith("src/core/postflight")) return "postflight";
  if (lower.startsWith("src/core/turn")) return "turn";
  if (lower.startsWith("src/core/security")) return "security";
  if (lower.startsWith("src/core/pr-")) return "pr";
  if (lower.startsWith("src/cli") || lower.startsWith("src/core/")) return "cli";
  if (lower.startsWith("src/")) return "code";
  return null;
}

function classifyProfile(params: { hasDocs: boolean; hasTests: boolean; hasCode: boolean; fileCount: number }): ChangeProfile {
  if (params.fileCount === 0) return "unknown";
  if (params.hasDocs && !params.hasTests && !params.hasCode) return "docs-only";
  if (!params.hasDocs && params.hasTests && !params.hasCode) return "tests-only";
  if (!params.hasDocs && !params.hasTests && params.hasCode) return "code-only";
  if (!params.hasDocs && params.hasTests && params.hasCode) return "code+tests";
  if (params.hasDocs && !params.hasTests && params.hasCode) return "code+docs";
  if (params.hasDocs && params.hasTests && params.hasCode) return "code+tests+docs";
  return "mixed";
}

function detectIssueThemes(context: RationaleContext, labels: string[]): string[] {
  const raw = [
    context.issueTitle,
    context.branch,
    context.signals?.issueBody ?? "",
    ...labels,
  ]
    .join(" ")
    .toLowerCase();

  const themes: string[] = [];
  const rules: Array<{ key: string; regex: RegExp }> = [
    { key: "pr", regex: /\bpr\b|pull request|rationale/ },
    { key: "review", regex: /\breview\b|thread/ },
    { key: "tracker", regex: /\btracker\b|issue/ },
    { key: "docs", regex: /\bdocs?\b|readme|mermaid/ },
    { key: "security", regex: /\bsecurity\b|gitleaks|secret/ },
    { key: "turn", regex: /\bturn\b/ },
    { key: "postflight", regex: /\bpostflight\b/ },
    { key: "preflight", regex: /\bpreflight\b/ },
    { key: "ui", regex: /\bui\b|frontend|dashboard/ },
  ];
  for (const rule of rules) {
    if (rule.regex.test(raw)) {
      themes.push(rule.key);
    }
  }
  return themes;
}

function summarizeValidationSignals(signals: readonly RationaleValidationSignal[] | null | undefined): string | null {
  const normalized = (signals ?? []).filter(
    (signal): signal is RationaleValidationSignal =>
      typeof signal === "object" &&
      signal !== null &&
      typeof signal.command === "string" &&
      typeof signal.status === "string",
  );
  if (!normalized.length) return null;

  const counts = { pass: 0, fail: 0, warn: 0, unknown: 0 };
  const commands = new Set<string>();
  for (const signal of normalized) {
    const status =
      signal.status === "pass" || signal.status === "fail" || signal.status === "warn" ? signal.status : "unknown";
    counts[status] += 1;
    const command = signal.command.trim();
    if (command) commands.add(command);
  }

  const parts: string[] = [];
  if (counts.pass) parts.push(`${counts.pass} pass`);
  if (counts.warn) parts.push(`${counts.warn} warn`);
  if (counts.fail) parts.push(`${counts.fail} fail`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);
  const commandList = [...commands].sort((a, b) => a.localeCompare(b));
  const commandText = commandList.length ? ` via ${commandList.map((value) => `\`${value}\``).join(", ")}` : "";
  return `${parts.join(", ") || "0 signals"}${commandText}`;
}

function formatSampleFiles(files: readonly string[], maxItems = 3): string {
  if (!files.length) return "none";
  const shown = files.slice(0, maxItems).map((file) => `\`${file}\``);
  if (files.length > maxItems) {
    shown.push(`(+${files.length - maxItems} more)`);
  }
  return shown.join(", ");
}

function buildFacts(context: RationaleContext): RationaleFacts {
  const labels = normalizeList(context.signals?.issueLabels);
  const changedFiles = normalizePaths(context.signals?.changedFiles);
  const hasDocs = changedFiles.some((file) => isDocFile(file));
  const hasTests = changedFiles.some((file) => isTestFile(file));
  const hasCode = changedFiles.some((file) => isCodeFile(file));
  const labelModules = normalizeList(labels.map((label) => toModuleFromLabel(label) ?? "").filter(Boolean));
  const fileModules = normalizeList(changedFiles.map((file) => toModuleFromFile(file) ?? "").filter(Boolean));
  const modules = normalizeList([...labelModules, ...fileModules]);
  const validationSignals = [...(context.signals?.validation ?? [])];

  return {
    labels,
    changedFiles,
    labelModules,
    fileModules,
    modules,
    hasChangedFileSignals: changedFiles.length > 0,
    hasDocs,
    hasTests,
    hasCode,
    profile: classifyProfile({ hasDocs, hasTests, hasCode, fileCount: changedFiles.length }),
    sampleFiles: changedFiles.slice(0, 3),
    issueThemes: detectIssueThemes(context, labels),
    validationSignals,
    reviewFindings: context.signals?.reviewFindings ?? null,
  };
}

function buildFallbackLine(): string {
  return "- Fallback: changed-file signals were unavailable, so this rationale is generated from issue metadata (title/branch/mode) only.";
}

function buildArchitectureLines(context: RationaleContext, facts: RationaleFacts): string[] {
  const lines = [
    `- Scope this PR to issue #${context.issueId} (\`${context.issueTitle}\`) on branch \`${context.branch}\` in \`${context.mode}\` mode.`,
  ];

  if (facts.hasChangedFileSignals) {
    const moduleText = facts.modules.length ? facts.modules.join(", ") : "none inferred";
    lines.push(
      `- Derived from changed files (${facts.changedFiles.length}): profile=\`${facts.profile}\`, modules=[${moduleText}], sample=${formatSampleFiles(facts.sampleFiles)}.`,
    );
  } else {
    lines.push(buildFallbackLine());
  }

  if (facts.profile === "docs-only") {
    lines.push("- Keep runtime/CLI behavior claims out of the rationale; this diff reads as documentation-only.");
  } else if (facts.profile === "tests-only") {
    lines.push("- Frame the PR as verification-focused: explain which behavior is being locked down without implying implementation edits.");
  } else if (facts.hasCode && facts.hasTests) {
    lines.push("- Connect implementation paths and adjacent test updates so reviewers can trace behavior changes to coverage in one pass.");
  } else if (facts.hasCode) {
    lines.push("- Call out touched CLI/runtime modules explicitly to make blast radius reviewable without diff spelunking.");
  } else {
    lines.push(`- Preserve deterministic headings/placeholders while tailoring bullets to the available \`${context.mode}\` signals.`);
  }

  return lines;
}

function buildWhyLines(context: RationaleContext, facts: RationaleFacts): string[] {
  const themeText = facts.issueThemes.length ? ` themes=${facts.issueThemes.join(", ")}` : "";
  const labelText = facts.labels.length ? ` labels=${facts.labels.join(", ")}` : " labels=none";
  const lines = [
    `- Generate reviewer context from issue metadata (\`${context.issueTitle}\`;${themeText || " themes=none"};${labelText}) instead of reusing a boilerplate rationale block.`,
  ];

  if (facts.profile === "docs-only") {
    lines.push("- A docs-only diff should justify wording/contract clarifications, not claim code-path risk changes that are absent from the touched files.");
  } else if (facts.profile === "tests-only") {
    lines.push("- A tests-only diff should explain the regression or edge case being pinned so review effort stays focused on intent and coverage quality.");
  } else if (facts.hasCode && facts.hasTests) {
    lines.push("- Mixed code+tests changes need a rationale that links behavior changes to the test edits in the same PR, which a generic template cannot express.");
  } else if (facts.hasCode) {
    lines.push("- Code-bearing diffs should mention touched modules and expected blast radius so reviewers can prioritize deeper inspection where it matters.");
  } else {
    lines.push(`- \`${context.mode}\` generation stays deterministic even when only partial signals are available, so reruns do not rewrite the PR body arbitrarily.`);
  }

  const validationSummary = summarizeValidationSignals(facts.validationSignals);
  if (validationSummary) {
    lines.push(`- Validation signals are available (${validationSummary}) and can be referenced without inventing success claims.`);
  } else if (facts.reviewFindings) {
    const unresolved = typeof facts.reviewFindings.unresolved === "number" ? facts.reviewFindings.unresolved : facts.reviewFindings.total;
    const severities = normalizeList(facts.reviewFindings.severities).join(", ") || "unknown";
    lines.push(
      `- Review findings summary is available (total=${facts.reviewFindings.total}, unresolved=${unresolved}, severities=${severities}) and should shape reviewer attention.`,
    );
  } else if (context.mode === "review") {
    lines.push(
      "- Review-mode PR bodies may be generated before agent outputs exist, so rationale intentionally relies on issue + diff signals until findings are published.",
    );
  } else if (facts.hasChangedFileSignals) {
    lines.push("- No validation or review summary signals were provided to the generator, so the rationale limits itself to issue/diff evidence.");
  } else {
    lines.push("- Fallback: validation and changed-file signals were unavailable, so this section avoids claiming test or review outcomes.");
  }

  return lines;
}

function buildAlternativesLines(context: RationaleContext, facts: RationaleFacts): string[] {
  const lines = [
    "- Keep one fixed rationale bullet set for every PR: rejected because it produces low-signal descriptions across unrelated changes.",
  ];

  if (facts.profile === "docs-only") {
    lines.push("- Describe docs-only edits as runtime refactors: rejected because no code/test paths appear in the touched-file signal.");
  } else if (facts.profile === "tests-only") {
    lines.push("- Present test-only work as a feature implementation: rejected because the diff signal shows verification changes without runtime edits.");
  } else if (facts.hasCode && facts.hasTests) {
    lines.push("- Split code and tests into unrelated narratives: rejected because reviewers need one cohesive explanation for behavior plus verification.");
  } else if (facts.hasCode) {
    lines.push("- Infer intent from the issue title alone and ignore touched modules: rejected because file-level signals expose the real review surface.");
  } else {
    lines.push(`- Overfit the rationale to \`${context.mode}\` mode defaults when stronger signals are missing: rejected in favor of explicit fallback text.`);
  }

  if (facts.hasChangedFileSignals) {
    lines.push(`- Claim evidence not present in the signals (sample ${formatSampleFiles(facts.sampleFiles)}): rejected to keep rationale deterministic and auditable.`);
  } else {
    lines.push("- Fallback: postpone specificity until changed-file signals are available rather than fabricating module/test claims.");
  }

  return lines;
}

function findSectionBounds(body: string, headerRegex: RegExp): RationaleSectionBounds | null {
  const headerMatch = headerRegex.exec(body);
  if (!headerMatch) return null;

  const header = headerMatch[0];
  const start = headerMatch.index;
  let contentStart = start + header.length;

  if (body.slice(contentStart, contentStart + 2) === "\r\n") {
    contentStart += 2;
  } else if (body.slice(contentStart, contentStart + 1) === "\n") {
    contentStart += 1;
  }

  const remainder = body.slice(contentStart);
  const nextHeadingOffset = remainder.search(/^##\s+/m);
  let end = nextHeadingOffset < 0 ? body.length : contentStart + nextHeadingOffset;

  // Preserve footer tokens (e.g. "Fixes #123") when rationale is the last heading.
  if (nextHeadingOffset < 0) {
    const footerMatch = RATIONALE_AUTOCLOSE_FOOTER_REGEX.exec(remainder);
    if (footerMatch && typeof footerMatch.index === "number") {
      end = contentStart + footerMatch.index;
    }
  }

  return {
    header,
    start,
    contentStart,
    end,
    content: body.slice(contentStart, end),
  };
}

function sectionContainsTodoPlaceholder(content: string): boolean {
  return TODO_PLACEHOLDER_LINE_REGEX.test(content);
}

function buildSectionLines(id: RationaleSectionId, context: RationaleContext): string[] {
  const facts = buildFacts(context);

  if (id === "architecture") return buildArchitectureLines(context, facts);
  if (id === "why") return buildWhyLines(context, facts);
  return buildAlternativesLines(context, facts);
}

export function buildRationaleSections(context: RationaleContext): RationaleSections {
  return {
    architecture: buildSectionLines("architecture", context),
    why: buildSectionLines("why", context),
    alternatives: buildSectionLines("alternatives", context),
  };
}

export function buildBodyWithRationale(params: {
  summaryLines: string[];
  issueId: number;
  context: RationaleContext;
  headings?: RationaleHeadings;
}): string {
  const sections = buildRationaleSections(params.context);
  const architectureHeading = normalizeHeading(params.headings?.architecture, getSectionDescriptor("architecture").defaultHeading);
  const whyHeading = normalizeHeading(params.headings?.why, getSectionDescriptor("why").defaultHeading);
  const alternativesHeading = normalizeHeading(
    params.headings?.alternatives,
    getSectionDescriptor("alternatives").defaultHeading,
  );

  const lines = [
    "## Summary",
    ...params.summaryLines,
    "",
    architectureHeading,
    ...sections.architecture,
    "",
    whyHeading,
    ...sections.why,
    "",
    alternativesHeading,
    ...sections.alternatives,
    "",
    `Fixes #${params.issueId}`,
  ];
  return lines.join("\n");
}

export function hasRationaleTodoPlaceholders(body: string): boolean {
  for (const section of RATIONALE_SECTIONS) {
    const bounds = findSectionBounds(body, section.headerRegex);
    if (!bounds) continue;
    if (sectionContainsTodoPlaceholder(bounds.content)) return true;
  }
  return false;
}

export function autofillRationaleSections(
  body: string,
  context: RationaleContext,
): { body: string; changed: boolean; changedSections: RationaleSectionId[] } {
  let nextBody = body;
  let changed = false;
  const changedSections: RationaleSectionId[] = [];

  for (const section of RATIONALE_SECTIONS) {
    const bounds = findSectionBounds(nextBody, section.headerRegex);
    if (!bounds) continue;
    if (!sectionContainsTodoPlaceholder(bounds.content)) continue;

    const sectionLines = buildSectionLines(section.id, context).join("\n");
    const hasNextHeading = bounds.end < nextBody.length;
    const replacement = `${bounds.header}\n${sectionLines}\n${hasNextHeading ? "\n" : ""}`;
    nextBody = `${nextBody.slice(0, bounds.start)}${replacement}${nextBody.slice(bounds.end)}`;
    changed = true;
    changedSections.push(section.id);
  }

  return {
    body: nextBody,
    changed,
    changedSections,
  };
}
