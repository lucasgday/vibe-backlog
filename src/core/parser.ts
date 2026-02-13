export type BacklogItem = {
  id: string;
  feature: string;
  status: string;
  branch: string;
  pr: string;
  notes: string;
};

export type BacklogTopic = {
  title: string;
  items: BacklogItem[];
};

export type ParsedBacklog = {
  topics: BacklogTopic[];
};

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function splitTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((part) => part.trim());
}

function cleanCell(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function parseBacklogMarkdown(markdown: string): ParsedBacklog {
  const lines = markdown.split(/\r?\n/);
  const topics: BacklogTopic[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("## Temática:")) {
      continue;
    }

    const title = line.replace("## Temática:", "").trim();
    let cursor = index + 1;

    while (cursor < lines.length && !isTableRow(lines[cursor] ?? "")) {
      cursor += 1;
    }

    if (cursor >= lines.length) {
      topics.push({ title, items: [] });
      index = cursor;
      continue;
    }

    const headerCells = splitTableRow(lines[cursor] ?? "").map((cell) => cell.toLowerCase());
    const expectedHeader = ["id", "feature/bug", "estado", "branch", "pr", "notas"];
    const headerMatches = expectedHeader.every((expected, headerIndex) => headerCells[headerIndex] === expected);

    if (!headerMatches) {
      topics.push({ title, items: [] });
      index = cursor;
      continue;
    }

    cursor += 1;
    if (cursor < lines.length && isTableRow(lines[cursor] ?? "")) {
      cursor += 1;
    }

    const items: BacklogItem[] = [];
    while (cursor < lines.length && isTableRow(lines[cursor] ?? "")) {
      const cells = splitTableRow(lines[cursor] ?? "");
      const [id = "", feature = "", status = "", branch = "", pr = "", notes = ""] = cells;
      items.push({
        id: cleanCell(id),
        feature: cleanCell(feature),
        status: cleanCell(status),
        branch: cleanCell(branch),
        pr: cleanCell(pr),
        notes: cleanCell(notes),
      });
      cursor += 1;
    }

    topics.push({ title, items });
    index = cursor - 1;
  }

  return { topics };
}

export function extractMarkdownLinks(value: string): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null = regex.exec(value);

  while (match) {
    const label = match[1]?.trim();
    const url = match[2]?.trim();
    if (label && url) {
      links.push({ label, url });
    }
    match = regex.exec(value);
  }

  return links;
}

export function stripMarkdownLinks(value: string): string {
  return value.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1").trim();
}

