export { createReadTool } from "./read.js"
export { createWriteTool } from "./write.js"
export { createEditTool } from "./edit.js"
export { createBashTool } from "./bash.js"
export { createLsTool } from "./ls.js"
export { createGrepTool } from "./grep.js"
export { createFindTool } from "./find.js"

import { createBashTool } from "./bash.js"
import { createEditTool } from "./edit.js"
import { createFindTool } from "./find.js"
import { createGrepTool } from "./grep.js"
import { createLsTool } from "./ls.js"
import { createReadTool } from "./read.js"
import { createWriteTool } from "./write.js"

/** Build the standard tool set bound to a cwd. */
export function createDefaultTools(cwd) {
	return [
		createReadTool(cwd),
		createWriteTool(cwd),
		createEditTool(cwd),
		createBashTool(cwd),
		createLsTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
	]
}
