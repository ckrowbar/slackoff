export interface MarkdownListBlock {
  ordered: boolean;
  start: number;
  items: readonly string[];
  nextIndex: number;
}

export type MarkdownTableAlignment = "left" | "center" | "right";

export interface MarkdownTableBlock {
  header: readonly string[];
  alignments: readonly (MarkdownTableAlignment | undefined)[];
  rows: readonly (readonly string[])[];
  nextIndex: number;
}

interface ListItem {
  ordered: boolean;
  number: number;
  text: string;
}

function parseListItem(line: string): ListItem | undefined {
  const match = /^ {0,3}(?:(\d+)\.|([-+*]))\s+(.+)$/.exec(line);
  if (!match) return undefined;
  const ordered = match[1] !== undefined;
  const parsed = ordered ? Number.parseInt(match[1] ?? "1", 10) : 1;
  return {
    ordered,
    number: Number.isSafeInteger(parsed) ? parsed : 1,
    text: match[3] ?? "",
  };
}

export function parseMarkdownList(lines: readonly string[], startIndex: number): MarkdownListBlock | undefined {
  const first = parseListItem(lines[startIndex] ?? "");
  if (!first) return undefined;

  const items: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const item = parseListItem(lines[index] ?? "");
    if (!item || item.ordered !== first.ordered) break;
    items.push(item.text);
    index += 1;

    let next = index;
    while (next < lines.length && (lines[next] ?? "").trim().length === 0) next += 1;
    const following = parseListItem(lines[next] ?? "");
    if (!following || following.ordered !== first.ordered) break;
    index = next;
  }

  return { ordered: first.ordered, start: first.number, items, nextIndex: index };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = "";
  let index = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") && !trimmed.endsWith("\\|") ? trimmed.length - 1 : trimmed.length;
  let codeFence = 0;

  while (index < end) {
    const character = trimmed[index] ?? "";
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 2;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (trimmed[index + run] === "`") run += 1;
      cell += "`".repeat(run);
      codeFence = codeFence === run ? 0 : codeFence === 0 ? run : codeFence;
      index += run;
      continue;
    }
    if (character === "|" && codeFence === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    index += 1;
  }
  cells.push(cell.trim());
  return cells;
}

function parseDelimiter(line: string): (MarkdownTableAlignment | undefined)[] | undefined {
  const cells = splitTableRow(line);
  if (cells.length < 2) return undefined;
  const alignments: (MarkdownTableAlignment | undefined)[] = [];
  for (const cell of cells) {
    const match = /^(:)?-{3,}(:)?$/.exec(cell);
    if (!match) return undefined;
    alignments.push(match[1] && match[2] ? "center" : match[2] ? "right" : match[1] ? "left" : undefined);
  }
  return alignments;
}

export function parseMarkdownTable(lines: readonly string[], startIndex: number): MarkdownTableBlock | undefined {
  const header = splitTableRow(lines[startIndex] ?? "");
  if (header.length < 2) return undefined;
  const alignments = parseDelimiter(lines[startIndex + 1] ?? "");
  if (!alignments || alignments.length !== header.length) return undefined;

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) break;
    const cells = splitTableRow(line);
    if (cells.length < 2) break;
    rows.push(cells);
    index += 1;
  }
  return { header, alignments, rows, nextIndex: index };
}
