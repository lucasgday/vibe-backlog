import { describe, expect, it } from "vitest";

import { extractMarkdownLinks, parseBacklogMarkdown, stripMarkdownLinks } from "../src/core/parser";

const SAMPLE_BACKLOG = `
# Featherlist Backlog

## Temática: Delivery / PR Hygiene

| ID | Feature/Bug | Estado | Branch | PR | Notas |
| --- | --- | --- | --- | --- | --- |
| OPS-001 | Consolidar PRs | ongoing | \`codex/feat-taxonomy-colors\` | [#8](https://example.com/pr/8) | Definir merge final. |
| OPS-002 | Cerrar PRs obsoletas | next | - | [#6](https://example.com/pr/6), [#7](https://example.com/pr/7) | Limpiar ramas. |

## Temática: Plataforma

| ID | Feature/Bug | Estado | Branch | PR | Notas |
| --- | --- | --- | --- | --- | --- |
| PLT-001 | Auth.js | next | - | - | Implementar auth. |
`;

describe("vibe backlog parser", () => {
  it("parses thematic tables into topic items", () => {
    const parsed = parseBacklogMarkdown(SAMPLE_BACKLOG);
    expect(parsed.topics).toHaveLength(2);

    expect(parsed.topics[0]?.title).toBe("Delivery / PR Hygiene");
    expect(parsed.topics[0]?.items).toHaveLength(2);
    expect(parsed.topics[0]?.items[0]?.id).toBe("OPS-001");
    expect(parsed.topics[0]?.items[0]?.branch).toBe("codex/feat-taxonomy-colors");
    expect(parsed.topics[1]?.items[0]?.feature).toBe("Auth.js");
  });

  it("extracts markdown links from cells", () => {
    const links = extractMarkdownLinks("[#6](https://example.com/6), [#7](https://example.com/7)");
    expect(links).toEqual([
      { label: "#6", url: "https://example.com/6" },
      { label: "#7", url: "https://example.com/7" },
    ]);
  });

  it("strips markdown links keeping labels", () => {
    const plain = stripMarkdownLinks("Ver [#8](https://example.com/8)");
    expect(plain).toBe("Ver #8");
  });
});

