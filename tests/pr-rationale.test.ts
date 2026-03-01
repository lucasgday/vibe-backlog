import { describe, expect, it } from "vitest";

import {
  autofillRationaleSections,
  buildRationaleSignalDebug,
  buildRationaleSections,
  hasRationaleTodoPlaceholders,
  type RationaleContext,
} from "../src/core/pr-rationale";

const CONTEXT: RationaleContext = {
  issueId: 44,
  issueTitle: "review flow hardening",
  branch: "codex/issue-44-review-flow-hardening",
  mode: "pr-open",
};

describe("pr rationale helpers", () => {
  it("preserves autoclose footer when replacing final rationale section", () => {
    const body = [
      "## Summary",
      "- Existing summary",
      "",
      "## Architecture decisions",
      "- TODO: fill architecture",
      "",
      "## Why these decisions were made",
      "- Done",
      "",
      "## Alternatives considered / rejected",
      "- TODO: fill alternatives",
      "",
      "Fixes #44",
    ].join("\n");

    const result = autofillRationaleSections(body, CONTEXT);

    expect(result.changed).toBe(true);
    expect(result.body).toContain("Fixes #44");
    expect(result.body.trimEnd().endsWith("Fixes #44")).toBe(true);
    expect(result.body.match(/Fixes #44/g)?.length ?? 0).toBe(1);
  });

  it("does not keep flagging placeholders after rationale autofill", () => {
    const bodyWithTodo = [
      "## Summary",
      "- Existing summary",
      "",
      "## Architecture decisions",
      "- TODO: fill architecture",
      "",
      "## Why these decisions were made",
      "- TODO: fill why",
      "",
      "## Alternatives considered / rejected",
      "- TODO: fill alternatives",
      "",
      "Fixes #44",
    ].join("\n");

    const first = autofillRationaleSections(bodyWithTodo, CONTEXT);
    expect(first.changed).toBe(true);
    expect(hasRationaleTodoPlaceholders(first.body)).toBe(false);

    const second = autofillRationaleSections(first.body, CONTEXT);
    expect(second.changed).toBe(false);
    expect(second.changedSections).toHaveLength(0);
    expect(second.body).toBe(first.body);
  });

  it("generates distinct rationale sections across CLI, docs-only, and mixed code+tests contexts", () => {
    const cliContext: RationaleContext = {
      issueId: 83,
      issueTitle: "feat(pr): dynamic rationale sections from PR signals",
      branch: "issue-83-dynamic-pr-rationale",
      mode: "pr-open",
      signals: {
        issueLabels: ["module:cli", "enhancement"],
        changedFiles: ["src/core/pr-rationale.ts", "src/core/pr-open.ts"],
      },
    };
    const docsContext: RationaleContext = {
      issueId: 21,
      issueTitle: "docs: add Mermaid workflow diagram",
      branch: "issue-21-readme-mermaid",
      mode: "pr-open",
      signals: {
        issueLabels: ["module:docs"],
        changedFiles: ["README.md", "docs/workflow.md"],
      },
    };
    const mixedContext: RationaleContext = {
      issueId: 90,
      issueTitle: "feat(tracker): harden label sync",
      branch: "issue-90-tracker-sync",
      mode: "review",
      signals: {
        issueLabels: ["module:tracker", "bug"],
        changedFiles: ["src/core/tracker.ts", "tests/tracker.test.ts"],
      },
    };

    const cli = buildRationaleSections(cliContext);
    const docs = buildRationaleSections(docsContext);
    const mixed = buildRationaleSections(mixedContext);

    expect(cli.architecture.join("\n")).toContain("profile=`code-only`");
    expect(docs.architecture.join("\n")).toContain("profile=`docs-only`");
    expect(docs.architecture.join("\n")).toContain("documentation-only");
    expect(mixed.architecture.join("\n")).toContain("profile=`code+tests`");
    expect(mixed.why.join("\n")).toContain("Mixed code+tests changes");
    expect(cli.why.join("\n")).not.toContain("themes=pr, tracker");

    expect(cli.why.join("\n")).not.toBe(docs.why.join("\n"));
    expect(cli.why.join("\n")).not.toBe(mixed.why.join("\n"));
    expect(docs.why.join("\n")).not.toBe(mixed.why.join("\n"));
  });

  it("uses explicit fallback text when changed-file signals are unavailable", () => {
    const fallbackContext: RationaleContext = {
      issueId: 83,
      issueTitle: "feat(pr): dynamic rationale sections from PR signals",
      branch: "issue-83-dynamic-pr-rationale",
      mode: "pr-open",
      signals: {
        issueLabels: ["module:cli"],
      },
    };
    const sections = buildRationaleSections(fallbackContext);
    const debug = buildRationaleSignalDebug(fallbackContext);

    expect(sections.architecture.join("\n")).toContain("Fallback: changed-file signals were unavailable");
    expect(sections.alternatives.join("\n")).toContain("Fallback: postpone specificity until changed-file signals are available");
    expect(debug.fallback_reasons).toContainEqual(expect.objectContaining({ code: "changed-files-unavailable" }));
  });

  it("is deterministic for the same inputs even when signal ordering differs", () => {
    const a = buildRationaleSections({
      issueId: 83,
      issueTitle: "feat(pr): dynamic rationale sections from PR signals",
      branch: "issue-83-dynamic-pr-rationale",
      mode: "pr-open",
      signals: {
        issueLabels: ["module:cli", "enhancement", "module:cli"],
        changedFiles: ["tests/pr-rationale.test.ts", "src/core/pr-rationale.ts", "src/core/pr-rationale.ts"],
      },
    });

    const b = buildRationaleSections({
      issueId: 83,
      issueTitle: "feat(pr): dynamic rationale sections from PR signals",
      branch: "issue-83-dynamic-pr-rationale",
      mode: "pr-open",
      signals: {
        issueLabels: ["enhancement", "module:cli"],
        changedFiles: ["src/core/pr-rationale.ts", "tests/pr-rationale.test.ts"],
      },
    });

    expect(b).toEqual(a);
  });

  it("emits deterministic signal debug for CLI-heavy context", () => {
    const context: RationaleContext = {
      issueId: 85,
      issueTitle: "feat(pr): expose rationale signal debug/json output",
      branch: "issue-85-rationale-signal-debug-json",
      mode: "pr-open",
      signals: {
        issueLabels: ["enhancement", "module:cli", "module:cli"],
        changedFiles: ["src/cli-program.ts", "src/core/pr-rationale.ts", "src/core/pr-open.ts"],
      },
    };

    const debugA = buildRationaleSignalDebug(context);
    const debugB = buildRationaleSignalDebug({
      ...context,
      signals: {
        issueLabels: ["module:cli", "enhancement"],
        changedFiles: ["src/core/pr-open.ts", "src/cli-program.ts", "src/core/pr-rationale.ts"],
      },
    });

    expect(debugA).toEqual(debugB);
    expect(debugA.schema_version).toBe(1);
    expect(debugA.profile).toBe("code-only");
    expect(debugA.modules).toEqual(["cli", "pr"]);
    expect(debugA.fallback_reasons.some((reason) => reason.code === "changed-files-unavailable")).toBe(false);
  });

  it("emits docs-only debug with explicit fallback reasons", () => {
    const debug = buildRationaleSignalDebug({
      issueId: 21,
      issueTitle: "docs: add Mermaid workflow diagram for vibe lifecycle",
      branch: "issue-21-readme-mermaid",
      mode: "pr-open",
      signals: {
        issueLabels: ["module:docs"],
        changedFiles: ["README.md", "docs/workflow.md"],
      },
    });

    expect(debug.profile).toBe("docs-only");
    expect(debug.schema_version).toBe(1);
    expect(debug.modules).toContain("docs");
    expect(debug.fallback_reasons).toContainEqual(
      expect.objectContaining({
        code: "validation-signals-unavailable",
      }),
    );
  });

  it("preserves user-written text outside placeholder sections during autofill", () => {
    const body = [
      "## Summary",
      "- Custom summary line",
      "",
      "## Architecture decisions",
      "- TODO: fill architecture",
      "",
      "## Why these decisions were made",
      "- Keep this custom reviewer context",
      "",
      "## Alternatives considered / rejected",
      "- TODO: fill alternatives",
      "",
      "## Extra section",
      "- user content stays",
      "",
      "Fixes #44",
    ].join("\n");

    const result = autofillRationaleSections(body, CONTEXT);

    expect(result.changed).toBe(true);
    expect(result.body).toContain("- Custom summary line");
    expect(result.body).toContain("## Why these decisions were made\n- Keep this custom reviewer context");
    expect(result.body).toContain("## Extra section\n- user content stays");
    expect(result.body).not.toContain("TODO:");
  });
});
