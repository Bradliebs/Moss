// src/lib/markdown.ts
//
// Minimal, dependency-free markdown segmentation for rendering assistant
// replies. Deliberately narrow: it splits out fenced code blocks (```),
// inline code (`code`), bold (**text**), strikethrough (~~text~~), links
// ([text](url)), headings (#), blockquotes (> text), thematic breaks (---),
// bullet/numbered lists, task lists (- [ ] / - [x]), and pipe tables.
// Everything else is left as literal text so prose renders exactly as the model
// wrote it. This covers the highest-value cases for a coding agent without
// pulling in a full markdown parser or a new dependency.

/** Inline pieces that can appear inside a prose run, heading, or list item. */
export type InlineSegment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "strike"; value: string }
  | { type: "inlineCode"; value: string }
  | { type: "link"; value: string; href: string };

export type MarkdownSegment =
  | InlineSegment
  | { type: "code"; value: string; lang?: string }
  | { type: "heading"; level: number; content: InlineSegment[] }
  | { type: "blockquote"; content: InlineSegment[] }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: InlineSegment[][] }
  | { type: "taskList"; items: { checked: boolean; content: InlineSegment[] }[] }
  | { type: "table"; header: InlineSegment[][]; rows: InlineSegment[][][] };

/** A bullet (`- ` / `* `) or numbered (`1. `) list line, capturing its marker
 *  and the item text. */
const LIST_ITEM = /^\s*([-*]|\d+\.)\s+(.+)$/;

/** A task-list line (`- [ ] todo` / `- [x] done`), capturing the check state
 *  and the item text. Checked before LIST_ITEM so the `[ ]` is not kept as text. */
const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

/** An ATX heading line (`# ` through `###### `), capturing the hashes and text. */
const HEADING = /^\s*(#{1,6})\s+(.+)$/;

/** A thematic break: a line of three or more `-`, `*`, or `_` of the same kind. */
const HR = /^\s*([-*_])\1{2,}\s*$/;

/** A blockquote line (`> text`), capturing the text after the marker. */
const BLOCKQUOTE = /^\s*>\s?(.*)$/;

/** A single `[text](url)` link, capturing the visible text and the URL. */
const LINK = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/;

/** Strip the optional outer pipes from a table row and split it into trimmed
 *  cell strings. Naive on `|` so a pipe inside inline code is not supported --
 *  acceptable for this minimal renderer. */
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** True when a line is a table divider row (each cell is dashes with optional
 *  leading/trailing colon for alignment, e.g. `| --- | :--: |`). */
function isTableDivider(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Split a prose run into text, bold, inline-code, and link pieces. An
 *  unmatched delimiter (a lone backtick, `**`, or bracket) stays literal text. */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  if (text === "") return out;
  const parts = text.split(/(\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g);
  for (const part of parts) {
    if (part === "") continue;
    if (/^\*\*[^*\n]+\*\*$/.test(part)) {
      out.push({ type: "bold", value: part.slice(2, -2) });
    } else if (/^~~[^~\n]+~~$/.test(part)) {
      out.push({ type: "strike", value: part.slice(2, -2) });
    } else if (/^`[^`\n]+`$/.test(part)) {
      out.push({ type: "inlineCode", value: part.slice(1, -1) });
    } else {
      const link = LINK.exec(part);
      if (link) {
        out.push({ type: "link", value: link[1], href: link[2] });
      } else {
        out.push({ type: "text", value: part });
      }
    }
  }
  return out;
}

/** Segment markdown text into text, bold, link, heading, fenced-code,
 *  inline-code, and list parts. An unterminated fence (common while a reply is
 *  still streaming) runs to the end of the input so the in-progress block still
 *  renders as code. */
export function parseMarkdown(input: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = input.split("\n");
  let textBuf: string[] = [];

  const flushText = (): void => {
    if (textBuf.length === 0) return;
    for (const seg of parseInline(textBuf.join("\n"))) segments.push(seg);
    textBuf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const fence = /^\s*```(.*)$/.exec(lines[i]);
    if (fence) {
      flushText();
      const lang = fence[1].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      segments.push({ type: "code", value: codeLines.join("\n"), lang: lang || undefined });
      continue;
    }

    const heading = HEADING.exec(lines[i]);
    if (heading) {
      flushText();
      segments.push({ type: "heading", level: heading[1].length, content: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR.test(lines[i])) {
      flushText();
      segments.push({ type: "hr" });
      i++;
      continue;
    }

    const quoteStart = BLOCKQUOTE.exec(lines[i]);
    if (quoteStart) {
      flushText();
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const q = BLOCKQUOTE.exec(lines[i]);
        if (!q) break;
        quoteLines.push(q[1]);
        i++;
      }
      segments.push({ type: "blockquote", content: parseInline(quoteLines.join("\n")) });
      continue;
    }

    if (lines[i].includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushText();
      const header = splitCells(lines[i]).map((c) => parseInline(c));
      i += 2; // consume the header row and the divider row
      const rows: InlineSegment[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitCells(lines[i]).map((c) => parseInline(c)));
        i++;
      }
      segments.push({ type: "table", header, rows });
      continue;
    }

    const taskStart = TASK_ITEM.exec(lines[i]);
    if (taskStart) {
      flushText();
      const items: { checked: boolean; content: InlineSegment[] }[] = [];
      while (i < lines.length) {
        const t = TASK_ITEM.exec(lines[i]);
        if (!t) break;
        items.push({ checked: t[1].toLowerCase() === "x", content: parseInline(t[2]) });
        i++;
      }
      segments.push({ type: "taskList", items });
      continue;
    }

    const listStart = LIST_ITEM.exec(lines[i]);
    if (listStart) {
      flushText();
      const ordered = /\d/.test(listStart[1]);
      const items: InlineSegment[][] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (!item) break;
        items.push(parseInline(item[2]));
        i++;
      }
      segments.push({ type: "list", ordered, items });
      continue;
    }

    textBuf.push(lines[i]);
    i++;
  }
  flushText();
  return segments;
}

/** Serialize inline segments back to their markdown source. The inverse of
 *  parseInline for the subset it produces; used by the copy affordance on
 *  structured blocks. */
export function inlineToMarkdown(segs: InlineSegment[]): string {
  return segs
    .map((s) => {
      switch (s.type) {
        case "bold":
          return `**${s.value}**`;
        case "strike":
          return `~~${s.value}~~`;
        case "inlineCode":
          return `\`${s.value}\``;
        case "link":
          return `[${s.value}](${s.href})`;
        default:
          return s.value;
      }
    })
    .join("");
}

/** Serialize a table or task-list segment back to markdown source so the
 *  rendered block can be copied to the clipboard. Other segment types return
 *  an empty string. */
export function segmentToMarkdown(seg: MarkdownSegment): string {
  if (seg.type === "table") {
    const head = `| ${seg.header.map(inlineToMarkdown).join(" | ")} |`;
    const divider = `| ${seg.header.map(() => "---").join(" | ")} |`;
    const rows = seg.rows.map((r) => `| ${r.map(inlineToMarkdown).join(" | ")} |`);
    return [head, divider, ...rows].join("\n");
  }
  if (seg.type === "taskList") {
    return seg.items.map((it) => `- [${it.checked ? "x" : " "}] ${inlineToMarkdown(it.content)}`).join("\n");
  }
  return "";
}

/** Escape the five characters that must not appear raw in HTML text/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render inline segments to safe HTML. */
function inlineToHtml(segs: InlineSegment[]): string {
  return segs
    .map((s) => {
      switch (s.type) {
        case "bold":
          return `<strong>${escapeHtml(s.value)}</strong>`;
        case "strike":
          return `<s>${escapeHtml(s.value)}</s>`;
        case "inlineCode":
          return `<code>${escapeHtml(s.value)}</code>`;
        case "link":
          return `<a href="${escapeHtml(s.href)}">${escapeHtml(s.value)}</a>`;
        default:
          return escapeHtml(s.value);
      }
    })
    .join("");
}

/** Render parsed markdown to a self-contained HTML string so a copied reply
 *  pastes with formatting intact into rich-text targets (mail, docs). */
export function markdownToHtml(input: string): string {
  return parseMarkdown(input)
    .map((seg) => {
      switch (seg.type) {
        case "code":
          return `<pre><code>${escapeHtml(seg.value)}</code></pre>`;
        case "heading":
          return `<h${seg.level}>${inlineToHtml(seg.content)}</h${seg.level}>`;
        case "blockquote":
          return `<blockquote>${inlineToHtml(seg.content)}</blockquote>`;
        case "hr":
          return "<hr>";
        case "list": {
          const items = seg.items.map((it) => `<li>${inlineToHtml(it)}</li>`).join("");
          return seg.ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
        }
        case "taskList": {
          const items = seg.items
            .map((it) => `<li>${it.checked ? "\u2611" : "\u2610"} ${inlineToHtml(it.content)}</li>`)
            .join("");
          return `<ul>${items}</ul>`;
        }
        case "table": {
          const head = `<tr>${seg.header.map((c) => `<th>${inlineToHtml(c)}</th>`).join("")}</tr>`;
          const body = seg.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineToHtml(c)}</td>`).join("")}</tr>`).join("");
          return `<table>${head}${body}</table>`;
        }
        default:
          return `<p>${inlineToHtml([seg])}</p>`;
      }
    })
    .join("\n");
}
