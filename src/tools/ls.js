import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { resolveToCwd } from "./path-utils.js"

const lsSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Directory to list (relative or absolute, default: cwd)" },
		hidden: { type: "boolean", description: "Include dotfiles (default: false)" },
	},
	additionalProperties: false,
}

/**
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createLsTool(cwd) {
	return {
		name: "ls",
		label: "ls",
		description: "List entries in a directory. Marks directories with a trailing slash. Skips dotfiles by default.",
		parameters: lsSchema,
		async execute(_id, { path = ".", hidden = false }, signal) {
			const abs = resolveToCwd(path, cwd)
			if (signal?.aborted) throw new Error("Operation aborted")
			const entries = await readdir(abs)
			const filtered = hidden ? entries : entries.filter((n) => !n.startsWith("."))
			filtered.sort()
			const lines = []
			for (const name of filtered) {
				if (signal?.aborted) throw new Error("Operation aborted")
				try {
					const s = await stat(join(abs, name))
					lines.push(s.isDirectory() ? `${name}/` : name)
				} catch {
					lines.push(name)
				}
			}
			const text = lines.length === 0 ? "(empty directory)" : lines.join("\n")
			return { content: [{ type: "text", text }], details: { count: lines.length } }
		},
	}
}
