export { createReadTool } from "./read.js"
export { createWriteTool } from "./write.js"
export { createApplyPatchTool } from "./apply-patch.js"
export { createEditTool } from "./edit.js"
export { createBashTool } from "./bash.js"
export { createLsTool } from "./ls.js"
export { createGrepTool } from "./grep.js"
export { createFindTool } from "./find.js"
export { createJsTool } from "./js.js"

import { createApplyPatchTool } from "./apply-patch.js"
import { createBashTool } from "./bash.js"
import { createEditTool } from "./edit.js"
import { createFindTool } from "./find.js"
import { createGrepTool } from "./grep.js"
import { createLsTool } from "./ls.js"
import { createReadTool } from "./read.js"
import { createWriteTool } from "./write.js"

function mutationToolsForProfile(cwd, options) {
	if (options.toolProfile === "apply_patch") return [createApplyPatchTool(cwd, options)]
	return [
		createWriteTool(cwd, options),
		createEditTool(cwd, options),
	]
}

/**
 * Build the standard tool set bound to a cwd.
 * @param {string} cwd
 * @param {{ beforeFileMutation?: (info: { absolutePath: string, path: string }) => Promise<void> | void, toolProfile?: "default" | "apply_patch" }} [options]
 */
export function createDefaultTools(cwd, options = {}) {
	const tools = [
		createReadTool(cwd),
		...mutationToolsForProfile(cwd, options),
		createBashTool(cwd),
		createLsTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
	]
	return tools
}
