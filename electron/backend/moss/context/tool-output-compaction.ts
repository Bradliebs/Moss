// electron/backend/moss/context/tool-output-compaction.ts
//
// Deterministic, safe compression of verbose tool output before it enters the
// model-facing history. It collapses the redundancy that dominates directory
// listings, recursive search dumps, and chatty command output -- long runs of
// identical or blank lines -- so the subsequent length cap discards far less
// genuinely useful signal. Pure and generic: no per-tool special-casing and no
// summarization, so it can never drop distinct content, only repetition.

/** Collapse a run of this many or more identical consecutive lines. */
const MIN_REPEAT_RUN = 4;
/** Keep at most this many consecutive blank lines. */
const MAX_BLANK_RUN = 2;

/** Compress repetition in tool output. Returns the input unchanged when there is
 *  nothing to collapse (single line, or no qualifying runs). */
export function compressToolOutput(content: string): string {
  if (!content.includes("\n")) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Collapse a run of identical non-blank lines into the line plus a marker.
    if (line.trim() !== "") {
      let j = i + 1;
      while (j < lines.length && lines[j] === line) j++;
      const run = j - i;
      if (run >= MIN_REPEAT_RUN) {
        // A collapsed run always omits at least MIN_REPEAT_RUN - 1 (>= 3) lines,
        // so the count is always plural.
        out.push(line);
        out.push(`... (${run - 1} identical lines omitted) ...`);
        i = j;
        blankRun = 0;
        continue;
      }
      blankRun = 0;
      out.push(line);
      i++;
      continue;
    }

    // Cap consecutive blank lines.
    blankRun++;
    if (blankRun <= MAX_BLANK_RUN) out.push(line);
    i++;
  }

  return out.join("\n");
}
