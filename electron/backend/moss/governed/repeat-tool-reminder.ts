const DEFAULT_THRESHOLDS = new Set([3, 5, 8]);
const DEFAULT_EXCLUDED_TOOLS = new Set(["plan"]);
const ARGUMENT_PREVIEW_CHARS = 500;

interface RepeatChain {
  key: string;
  count: number;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalArguments(raw: string): string {
  try {
    return JSON.stringify(sortJson(JSON.parse(raw || "{}")));
  } catch {
    return raw;
  }
}

function preview(value: string): string {
  if (value.length <= ARGUMENT_PREVIEW_CHARS) return value;
  return `${value.slice(0, ARGUMENT_PREVIEW_CHARS)}... (+${value.length - ARGUMENT_PREVIEW_CHARS} characters)`;
}

export class RepeatToolReminder {
  private chain: RepeatChain | undefined;

  observe(toolName: string, rawArguments: string): string | undefined {
    if (DEFAULT_EXCLUDED_TOOLS.has(toolName)) return undefined;
    const canonical = canonicalArguments(rawArguments);
    const key = JSON.stringify([toolName, canonical]);
    const count = this.chain?.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    if (!DEFAULT_THRESHOLDS.has(count)) return undefined;
    if (count === 3) {
      return "Moss noticed the same tool call three times with identical arguments. Review the previous result and either change the approach or finish if enough evidence is available.";
    }
    return [
      "Moss detected a repeated tool-call loop:",
      `- tool: ${toolName}`,
      `- consecutive calls: ${count}`,
      `- arguments: ${preview(canonical)}`,
      "Do not repeat this exact call again. Use different arguments, choose another action, or conclude from the evidence already collected.",
    ].join("\n");
  }
}