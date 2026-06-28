// electron/backend/moss/tools/index.ts

import type { ToolDefinition } from "../../../../common/types";
import { editFileTool, globFilesTool, listDirTool, moveFileTool, readFileTool, searchFilesTool, writeFileTool } from "./fs-tools";
import { SELF_TOOLS } from "./self-tools";
import { runCommandTool } from "./shell-tool";
import { transcribeAudioTool } from "./transcribe-tool";
import type { Tool } from "./types";
import { fetchUrlTool, webSearchTool } from "./web-tools";

export const TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  searchFilesTool,
  globFilesTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  runCommandTool,
  webSearchTool,
  fetchUrlTool,
  transcribeAudioTool,
  ...SELF_TOOLS,
];

export const TOOL_REGISTRY: Map<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

export type { Tool, ToolContext, ToolResult } from "./types";
