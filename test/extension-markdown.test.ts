import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownList, parseMarkdownTable } from "../extension/src/ui/markdown.js";

test("ordered Markdown items stay in one incrementing list across blank lines", () => {
  assert.deepEqual(
    parseMarkdownList([
      "1. **First**",
      "",
      "1. Second",
      "",
      "1. Third",
      "After the list",
    ], 0),
    {
      ordered: true,
      start: 1,
      items: ["**First**", "Second", "Third"],
      nextIndex: 5,
    },
  );
});

test("an ordered Markdown list preserves its starting number", () => {
  assert.deepEqual(parseMarkdownList(["4. Fourth", "5. Fifth"], 0), {
    ordered: true,
    start: 4,
    items: ["Fourth", "Fifth"],
    nextIndex: 2,
  });
});

test("GitHub-style Markdown tables preserve cells, alignment, and inline pipes", () => {
  assert.deepEqual(
    parseMarkdownTable([
      "| Name | State | Ratio |",
      "| :--- | :---: | ---: |",
      "| Alpha | **Ready** | 3 |",
      "| Beta \\| Gamma | `1 | 2` | 4 |",
      "After the table",
    ], 0),
    {
      header: ["Name", "State", "Ratio"],
      alignments: ["left", "center", "right"],
      rows: [
        ["Alpha", "**Ready**", "3"],
        ["Beta | Gamma", "`1 | 2`", "4"],
      ],
      nextIndex: 4,
    },
  );
});

test("ordinary prose with a divider is not parsed as a table", () => {
  assert.equal(parseMarkdownTable(["Heading", "---"], 0), undefined);
});
