interface Boundary {
  index: number;
  escapedLength: number;
}

const PREFERRED_BOUNDARY_RATIO = 0.6;

function escapedCharacterLength(character: string): number {
  if (character === "&") return 5;
  if (character === "<" || character === ">") return 4;
  return character.length;
}

/**
 * Split one logical transcript entry for Slack's section-block limit without changing its text.
 * Paragraph, line, and whitespace boundaries are preferred when they use most of the available
 * budget. A hard split advances by Unicode code point, never through a surrogate pair.
 */
export function splitTranscriptText(text: string, maximumEscapedLength: number): string[] {
  if (!Number.isSafeInteger(maximumEscapedLength) || maximumEscapedLength <= 0) {
    throw new Error("maximumEscapedLength must be a positive integer");
  }

  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let offset = 0;

  while (offset < normalized.length) {
    let cursor = offset;
    let escapedLength = 0;
    let whitespace: Boundary | undefined;
    let line: Boundary | undefined;
    let paragraph: Boundary | undefined;

    while (cursor < normalized.length) {
      const character = String.fromCodePoint(normalized.codePointAt(cursor) ?? 0);
      const nextLength = escapedLength + escapedCharacterLength(character);
      if (nextLength > maximumEscapedLength) break;
      cursor += character.length;
      escapedLength = nextLength;
      if (/\s/u.test(character)) whitespace = { index: cursor, escapedLength };
      if (character === "\n") {
        line = { index: cursor, escapedLength };
        if (normalized[cursor - 2] === "\n") paragraph = line;
      }
    }

    if (cursor === offset) {
      throw new Error("maximumEscapedLength cannot fit one escaped character");
    }
    if (cursor === normalized.length) {
      chunks.push(normalized.slice(offset));
      break;
    }

    const minimumPreferredLength = maximumEscapedLength * PREFERRED_BOUNDARY_RATIO;
    const preferred = [paragraph, line, whitespace].find(
      (boundary): boundary is Boundary => boundary !== undefined && boundary.escapedLength >= minimumPreferredLength,
    );
    const end = preferred?.index ?? cursor;
    chunks.push(normalized.slice(offset, end));
    offset = end;
  }

  return chunks;
}
