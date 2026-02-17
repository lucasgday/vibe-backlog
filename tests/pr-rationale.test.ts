import { describe, expect, it } from "vitest";

import {
  autofillRationaleSections,
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
});
