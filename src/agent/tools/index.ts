import { grep, listFiles, readFile } from "./fsTools.js";
import { proposeEdit } from "./proposeEdit.js";
import { searchCode } from "./searchCode.js";
import type { AgentTool } from "./types.js";

export type { AgentTool, ToolContext } from "./types.js";

/** Register new tools here. */
export const allTools: AgentTool[] = [searchCode, grep, readFile, listFiles, proposeEdit];

export const readOnlyTools: AgentTool[] = allTools.filter((t) => t !== proposeEdit);
