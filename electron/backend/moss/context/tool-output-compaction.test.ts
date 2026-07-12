// electron/backend/moss/context/tool-output-compaction.test.ts

import { describe, expect, it } from "vitest";

import { compressToolOutput } from "./tool-output-compaction";

describe("compressToolOutput", () => {
  it("returns single-line content unchanged", () => {
    expect(compressToolOutput("just one line")).toBe("just one line");
  });

  it("leaves ordinary varied text unchanged", () => {
    const text = "line a\nline b\nline c";
    expect(compressToolOutput(text)).toBe(text);
  });

  it("collapses a long run of identical lines into one plus a marker", () => {
    const input = ["x", "same", "same", "same", "same", "same", "y"].join("\n");
    const out = compressToolOutput(input);
    expect(out).toBe(["x", "same", "... (4 identical lines omitted) ...", "y"].join("\n"));
  });

  it("does not collapse a run below the threshold", () => {
    const input = ["dup", "dup", "dup"].join("\n"); // 3 < MIN_REPEAT_RUN
    expect(compressToolOutput(input)).toBe(input);
  });

  it("reports the omitted count for a longer run", () => {
    const input = ["a", "a", "a", "a", "a", "b"].join("\n"); // run of 5 -> 4 omitted
    const out = compressToolOutput(input);
    expect(out).toContain("(4 identical lines omitted)");
  });

  it("caps a run of blank lines", () => {
    const input = ["a", "", "", "", "", "", "b"].join("\n");
    const out = compressToolOutput(input);
    expect(out).toBe(["a", "", "", "b"].join("\n"));
  });

  it("preserves the first occurrence and surrounding content", () => {
    const input = ["header", "row", "row", "row", "row", "footer"].join("\n");
    const out = compressToolOutput(input);
    expect(out.startsWith("header\nrow\n")).toBe(true);
    expect(out.endsWith("\nfooter")).toBe(true);
  });
});
