import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { withFileMutationQueue } from "./file-mutation-queue.js"
import { resolveToCwd } from "./path-utils.js"

const writeSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to write (relative or absolute)" },
		content: { type: "string", description: "Content to write to the file" },
	},
	required: ["path", "content"],
	additionalProperties: false,
}

/**
 * @param {string} cwd
 * @param {{ beforeFileMutation?: (info: { absolutePath: string, path: string }) => Promise<void> | void }} [options]
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createWriteTool(cwd, options = {}) {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_id, { path, content }, signal) {
			const abs = resolveToCwd(path, cwd)
			return withFileMutationQueue(abs, async () => {
				if (signal?.aborted) throw new Error("Operation aborted")
				await mkdir(dirname(abs), { recursive: true })
				if (signal?.aborted) throw new Error("Operation aborted")
				await options.beforeFileMutation?.({ absolutePath: abs, path })
				if (signal?.aborted) throw new Error("Operation aborted")
				await writeFile(abs, content, "utf-8")
				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: {},
				}
			})
		},
	}
}
