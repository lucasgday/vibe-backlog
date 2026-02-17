type RationaleMode = "pr-open" | "review";

export type RationaleContext = {
  issueId: number;
  issueTitle: string;
  branch: string;
  mode: RationaleMode;
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
  const end = nextHeadingOffset < 0 ? body.length : contentStart + nextHeadingOffset;

  return {
    header,
    start,
    contentStart,
    end,
    content: body.slice(contentStart, end),
  };
}

function sectionContainsTodo(content: string): boolean {
  return /\bTODO\b/i.test(content);
}

function buildSectionLines(id: RationaleSectionId, context: RationaleContext): string[] {
  if (id === "architecture") {
    return [
      `- Keep work scoped to issue #${context.issueId} on branch \`${context.branch}\`.`,
      "- Preserve existing CLI command contracts; harden behavior without changing user-facing flags.",
      "- Use deterministic git/GitHub state and marker-based outputs to keep runs reproducible.",
    ];
  }

  if (id === "why") {
    return [
      "- Avoid placeholder rationale in PRs so reviewers always have actionable context.",
      "- Persist review artifacts in one final commit/push to guarantee traceable run state.",
      "- Stop retry loops without progress to reduce wasted review cycles and noisy follow-ups.",
    ];
  }

  return [
    "- Keep TODO placeholders and rely on manual cleanup: rejected due to inconsistent PR quality.",
    "- Retry until max attempts regardless of autofix progress: rejected due to repeated no-op loops.",
    "- Commit on every attempt: rejected due to noisy history and harder rollback auditing.",
  ];
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
    if (sectionContainsTodo(bounds.content)) return true;
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
    if (!sectionContainsTodo(bounds.content)) continue;

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
