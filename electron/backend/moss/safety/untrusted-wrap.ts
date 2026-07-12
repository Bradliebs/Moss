// electron/backend/moss/safety/untrusted-wrap.ts
//
// Structural defense against indirect prompt injection. Content fetched from
// outside the workspace -- web search results, fetched URLs, and MCP tool output
// -- is wrapped in an <external_content source="..."> envelope before it enters
// the model-facing history, mirroring the <untrusted_memory> boundary used for
// remembered facts. The system prompt tells the model to treat everything inside
// these tags as data, never instructions. Closing-tag escaping keeps a payload
// from ending the block early and smuggling text back into the trusted context.

/** The XML-ish boundary tag. Kept in sync with the system-prompt guidance. */
export const EXTERNAL_CONTENT_TAG = "external_content";

/** Built-in tools whose output originates outside the workspace sandbox. MCP
 *  tools are matched separately by their `mcp__` name prefix. read_file and the
 *  other filesystem tools are deliberately excluded: workspace files are the
 *  user's own content, not third-party data. */
const EXTERNAL_CONTENT_TOOLS = new Set(["web_search", "fetch_url", "transcribe_audio"]);

/** True when a tool's result should be wrapped as untrusted external content:
 *  the network/transcription tools above, or any MCP tool (name `mcp__<id>__<t>`). */
export function isExternalContentTool(name: string): boolean {
  return EXTERNAL_CONTENT_TOOLS.has(name) || name.startsWith("mcp__");
}

/** Neutralize any attempt to close the boundary early so external text cannot
 *  break out and be treated as trusted instructions. Case-insensitive, matching
 *  the memory boundary's escaping. */
function escapeClosingTag(text: string): string {
  return text.replace(new RegExp(`</${EXTERNAL_CONTENT_TAG}>`, "gi"), `<\\/${EXTERNAL_CONTENT_TAG}>`);
}

/** Constrain the provenance label to a compact, attribute-safe token so it
 *  cannot itself break out of the opening tag. */
function sanitizeSource(source: string): string {
  return source.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 64) || "external";
}

/** Wrap external tool output in a labelled untrusted-content envelope. */
export function wrapExternalContent(source: string, text: string): string {
  return [
    `<${EXTERNAL_CONTENT_TAG} source="${sanitizeSource(source)}">`,
    escapeClosingTag(text),
    `</${EXTERNAL_CONTENT_TAG}>`,
  ].join("\n");
}
