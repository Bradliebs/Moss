import { describe, expect, it } from "vitest";

import { parseMarkdown, segmentToMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("returns a single text segment for plain prose", () => {
    expect(parseMarkdown("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("extracts a fenced code block with its language", () => {
    const segs = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(segs).toEqual([{ type: "code", value: "const x = 1;", lang: "ts" }]);
  });

  it("extracts a fenced code block without a language", () => {
    const segs = parseMarkdown("```\nplain\n```");
    expect(segs).toEqual([{ type: "code", value: "plain", lang: undefined }]);
  });

  it("keeps prose around a fenced block as text segments", () => {
    const segs = parseMarkdown("before\n```\ncode\n```\nafter");
    expect(segs).toEqual([
      { type: "text", value: "before" },
      { type: "code", value: "code", lang: undefined },
      { type: "text", value: "after" },
    ]);
  });

  it("treats an unterminated fence as code to the end (streaming)", () => {
    const segs = parseMarkdown("```py\nstill typing");
    expect(segs).toEqual([{ type: "code", value: "still typing", lang: "py" }]);
  });

  it("splits inline code out of prose", () => {
    const segs = parseMarkdown("use `npm test` now");
    expect(segs).toEqual([
      { type: "text", value: "use " },
      { type: "inlineCode", value: "npm test" },
      { type: "text", value: " now" },
    ]);
  });

  it("leaves an unmatched backtick as literal text", () => {
    expect(parseMarkdown("a ` b")).toEqual([{ type: "text", value: "a ` b" }]);
  });

  it("splits bold out of prose", () => {
    expect(parseMarkdown("say **hi** now")).toEqual([
      { type: "text", value: "say " },
      { type: "bold", value: "hi" },
      { type: "text", value: " now" },
    ]);
  });

  it("leaves an unmatched ** as literal text", () => {
    expect(parseMarkdown("a ** b")).toEqual([{ type: "text", value: "a ** b" }]);
  });

  it("groups consecutive bullet lines into an unordered list", () => {
    expect(parseMarkdown("- one\n- two")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", value: "one" }], [{ type: "text", value: "two" }]],
      },
    ]);
  });

  it("groups numbered lines into an ordered list and parses item inlines", () => {
    expect(parseMarkdown("1. plain\n2. with **bold**")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          [{ type: "text", value: "plain" }],
          [
            { type: "text", value: "with " },
            { type: "bold", value: "bold" },
          ],
        ],
      },
    ]);
  });

  it("keeps prose around a list as separate segments", () => {
    expect(parseMarkdown("before\n- item\nafter")).toEqual([
      { type: "text", value: "before" },
      { type: "list", ordered: false, items: [[{ type: "text", value: "item" }]] },
      { type: "text", value: "after" },
    ]);
  });

  it("parses an ATX heading with its level and inline content", () => {
    expect(parseMarkdown("## Big **deal**")).toEqual([
      {
        type: "heading",
        level: 2,
        content: [
          { type: "text", value: "Big " },
          { type: "bold", value: "deal" },
        ],
      },
    ]);
  });

  it("does not treat a hash without a trailing space as a heading", () => {
    expect(parseMarkdown("#nope")).toEqual([{ type: "text", value: "#nope" }]);
  });

  it("splits a link out of prose with its text and href", () => {
    expect(parseMarkdown("see [docs](https://example.com) here")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "docs", href: "https://example.com" },
      { type: "text", value: " here" },
    ]);
  });

  it("parses a thematic break of three or more dashes", () => {
    expect(parseMarkdown("---")).toEqual([{ type: "hr" }]);
    expect(parseMarkdown("****")).toEqual([{ type: "hr" }]);
  });

  it("does not treat a list dash as a thematic break", () => {
    expect(parseMarkdown("- item")).toEqual([
      { type: "list", ordered: false, items: [[{ type: "text", value: "item" }]] },
    ]);
  });

  it("groups consecutive blockquote lines into one quote with inline content", () => {
    expect(parseMarkdown("> a quote\n> with **bold**")).toEqual([
      {
        type: "blockquote",
        content: [
          { type: "text", value: "a quote\nwith " },
          { type: "bold", value: "bold" },
        ],
      },
    ]);
  });

  it("keeps prose around a blockquote and rule as separate segments", () => {
    expect(parseMarkdown("intro\n> note\n---\nafter")).toEqual([
      { type: "text", value: "intro" },
      { type: "blockquote", content: [{ type: "text", value: "note" }] },
      { type: "hr" },
      { type: "text", value: "after" },
    ]);
  });

  it("parses a pipe table into header and row cells with inline content", () => {
    expect(parseMarkdown("| A | B |\n| --- | --- |\n| 1 | **two** |")).toEqual([
      {
        type: "table",
        header: [[{ type: "text", value: "A" }], [{ type: "text", value: "B" }]],
        rows: [
          [
            [{ type: "text", value: "1" }],
            [{ type: "bold", value: "two" }],
          ],
        ],
      },
    ]);
  });

  it("accepts alignment colons in the table divider row", () => {
    expect(parseMarkdown("| L | R |\n| :-- | --: |\n| a | b |")).toEqual([
      {
        type: "table",
        header: [[{ type: "text", value: "L" }], [{ type: "text", value: "R" }]],
        rows: [[[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]]],
      },
    ]);
  });

  it("leaves a pipe line with no divider row as literal text", () => {
    expect(parseMarkdown("a | b | c")).toEqual([{ type: "text", value: "a | b | c" }]);
  });

  it("parses a task list with checked state and inline content", () => {
    expect(parseMarkdown("- [ ] todo\n- [x] done **now**")).toEqual([
      {
        type: "taskList",
        items: [
          { checked: false, content: [{ type: "text", value: "todo" }] },
          {
            checked: true,
            content: [
              { type: "text", value: "done " },
              { type: "bold", value: "now" },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps a plain bullet next to a task list as a separate list segment", () => {
    expect(parseMarkdown("- [ ] task\n- plain")).toEqual([
      { type: "taskList", items: [{ checked: false, content: [{ type: "text", value: "task" }] }] },
      { type: "list", ordered: false, items: [[{ type: "text", value: "plain" }]] },
    ]);
  });

  it("parses strikethrough as a strike inline segment", () => {
    expect(parseMarkdown("a ~~gone~~ b")).toEqual([
      { type: "text", value: "a " },
      { type: "strike", value: "gone" },
      { type: "text", value: " b" },
    ]);
  });

  it("leaves a lone tilde pair with no inner text as literal text", () => {
    expect(parseMarkdown("~~~~")).toEqual([{ type: "text", value: "~~~~" }]);
  });
});

describe("segmentToMarkdown", () => {
  it("serializes a table segment back to pipe-table markdown", () => {
    const [table] = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(segmentToMarkdown(table)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("serializes a task list segment back to checkbox markdown", () => {
    const [taskList] = parseMarkdown("- [x] done\n- [ ] todo");
    expect(segmentToMarkdown(taskList)).toBe("- [x] done\n- [ ] todo");
  });

  it("preserves inline formatting when serializing cells", () => {
    const [table] = parseMarkdown("| **b** | `c` |\n| --- | --- |\n| ~~s~~ | [t](http://x) |");
    expect(segmentToMarkdown(table)).toBe("| **b** | `c` |\n| --- | --- |\n| ~~s~~ | [t](http://x) |");
  });

  it("returns an empty string for non-structured segments", () => {
    expect(segmentToMarkdown({ type: "text", value: "hi" })).toBe("");
  });
});
