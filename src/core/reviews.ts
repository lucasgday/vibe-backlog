import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ReviewTemplateOptions = {
  workspaceRoot?: string;
};

export type ReviewTemplateResult = {
  directory: string;
  created: string[];
  unchanged: string[];
};

type ReviewTemplate = {
  fileName: string;
  content: string;
};

const REVIEW_TEMPLATES: readonly ReviewTemplate[] = [
  {
    fileName: "implementation.md",
    content: `# Implementation Pass

## Scope
- Issue:
- Goal:

## Checklist
- [ ] Diff kept focused to issue scope
- [ ] Behavior changes documented
- [ ] Follow-up work listed (if any)

## Notes
- 
`,
  },
  {
    fileName: "security.md",
    content: `# Security Pass

## Threat Scan
- Risks considered:
- Mitigations applied:

## Checklist
- [ ] Input validation paths reviewed
- [ ] Authorization/data exposure reviewed
- [ ] Error handling avoids sensitive leakage

## Notes
- 
`,
  },
  {
    fileName: "quality.md",
    content: `# Quality Pass

## What I Tested
- Commands:
- Scenarios:

## Checklist
- [ ] Happy path validated
- [ ] Failure/edge path validated
- [ ] Remaining gaps captured

## Notes
- 
`,
  },
  {
    fileName: "ux.md",
    content: `# UX Pass

## Review Focus
- Flow touched:
- Accessibility/performance checks:

## Checklist
- [ ] Empty and error states reviewed
- [ ] Copy and affordances reviewed
- [ ] Interaction quality reviewed

## Notes
- 
`,
  },
  {
    fileName: "ops.md",
    content: `# Ops Pass

## Release Readiness
- Commands run:
- Operational risks:

## Checklist
- [ ] Build/test reproducibility validated
- [ ] Rollback strategy noted
- [ ] CI/deploy impact reviewed

## Notes
- 
`,
  },
];

export const REVIEW_TEMPLATE_FILE_NAMES = REVIEW_TEMPLATES.map((template) => template.fileName);

function resolveWorkspaceRoot(options: ReviewTemplateOptions): string {
  return options.workspaceRoot ?? process.cwd();
}

function validateIssueId(issueId: number): void {
  if (!Number.isSafeInteger(issueId) || issueId <= 0) {
    throw new Error("issueId must be a positive integer");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export function getIssueReviewDirectory(issueId: number, options: ReviewTemplateOptions = {}): string {
  validateIssueId(issueId);
  return path.resolve(resolveWorkspaceRoot(options), ".vibe", "reviews", String(issueId));
}

export async function ensureIssueReviewTemplates(
  issueId: number,
  options: ReviewTemplateOptions = {},
): Promise<ReviewTemplateResult> {
  const directory = getIssueReviewDirectory(issueId, options);
  await mkdir(directory, { recursive: true });

  const created: string[] = [];
  const unchanged: string[] = [];

  for (const template of REVIEW_TEMPLATES) {
    const filePath = path.join(directory, template.fileName);
    if (await pathExists(filePath)) {
      unchanged.push(filePath);
      continue;
    }

    await writeFile(filePath, template.content, "utf8");
    created.push(filePath);
  }

  return { directory, created, unchanged };
}
