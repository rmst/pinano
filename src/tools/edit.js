import { constants } from "node:fs"
import { access, readFile, writeFile } from "node:fs/promises"

import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-helpers.js"
import { withFileMutationQueue } from "./file-mutation-queue.js"
import { generateDiffString } from "./line-diff.js"
import { resolveToCwd } from "./path-utils.js"

const replaceSchema = {
	type: "object",
	properties: {
		oldText: {
			type: "string",
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		},
		newText: { type: "string", description: "Replacement text for this targeted edit." },
	},
	required: ["oldText", "newText"],
	additionalProperties: false,
}

const editSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
		edits: {
			type: "array",
			items: replaceSchema,
			description:
				"One or more targeted replacements. Each edit is matched against the original file. Do not include overlapping or nested edits.",
		},
	},
	required: ["path", "edits"],
	additionalProperties: false,
}

/** Coerce legacy single-edit `{oldText, newText}` shapes into the array form. */
function prepareEditArguments(input) {
	if (!input || typeof input !== "object") return input
	const args = { ...input }

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON-encoded string.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits)
			if (Array.isArray(parsed)) args.edits = parsed
		} catch {}
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		const edits = Array.isArray(args.edits) ? [...args.edits] : []
		edits.push({ oldText: args.oldText, newText: args.newText })
		const { oldText, newText, ...rest } = args
		void oldText
		void newText
		return { ...rest, edits }
	}
	return args
}

/**
 * @param {string} cwd
 * @param {{ beforeFileMutation?: (info: { absolutePath: string, path: string }) => Promise<void> | void }} [options]
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createEditTool(cwd, options = {}) {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Merge nearby changes into one edit instead of emitting overlapping edits.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_id, { path, edits }, signal) {
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error("Edit tool input is invalid. edits must contain at least one replacement.")
			}
			const abs = resolveToCwd(path, cwd)
			return withFileMutationQueue(abs, async () => {
				if (signal?.aborted) throw new Error("Operation aborted")
				try {
					await access(abs, constants.R_OK | constants.W_OK)
				} catch (error) {
					const code = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error)
					throw new Error(`Could not edit file: ${path}. ${code}.`)
				}

				const buffer = await readFile(abs)
				const raw = buffer.toString("utf-8")
				const { bom, text: content } = stripBom(raw)
				const ending = detectLineEnding(content)
				const normalized = normalizeToLF(content)
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalized, edits, path)
				if (signal?.aborted) throw new Error("Operation aborted")

				const finalContent = bom + restoreLineEndings(newContent, ending)
				await options.beforeFileMutation?.({ absolutePath: abs, path })
				if (signal?.aborted) throw new Error("Operation aborted")
				await writeFile(abs, finalContent, "utf-8")

				const { diff, firstChangedLine } = generateDiffString(baseContent, newContent)
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.\n${diff}` }],
					details: { diff, firstChangedLine },
				}
			})
		},
	}
}
