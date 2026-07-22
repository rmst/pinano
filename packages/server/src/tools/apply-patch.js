import { constants } from "node:fs"
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { applyUpdateHunks } from "./apply-patch-edits.js"
import {
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-helpers.js"
import { withFileMutationQueue } from "./file-mutation-queue.js"
import { generateDiffString } from "./line-diff.js"
import { resolveToCwd } from "./path-utils.js"

export const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

const HEADER_RE = /^\*\*\* (Add File|Update File|Delete File): (.+)$/
const MOVE_RE = /^\*\*\* Move to: (.+)$/
const EOF_MARKER = "*** End of File"

function splitLines(input) {
	return normalizeToLF(String(input)).split("\n")
}

function syntaxErrorAt(lineNo, message) {
	return new Error(`Invalid apply_patch input at line ${lineNo}: ${message}`)
}

function ensurePatchPath(path, lineNo) {
	if (typeof path !== "string" || path.length === 0) throw syntaxErrorAt(lineNo, "file path must not be empty")
	if (path.includes("\0")) throw syntaxErrorAt(lineNo, "file path must not contain NUL bytes")
	return path
}

function parseHeader(line, lineNo) {
	const match = HEADER_RE.exec(line)
	if (!match) return null
	return { kind: match[1], path: ensurePatchPath(match[2], lineNo) }
}

function parseMove(line, lineNo) {
	const match = MOVE_RE.exec(line)
	if (!match) return null
	return ensurePatchPath(match[1], lineNo)
}

function parseAdd(lines, state, path) {
	const addLines = []
	while (state.index < lines.length) {
		const line = lines[state.index]
		if (line === "*** End Patch" || parseHeader(line, state.index + 1)) break
		if (!line.startsWith("+")) {
			throw syntaxErrorAt(state.index + 1, "Add File lines must start with '+'")
		}
		addLines.push(line.slice(1))
		state.index++
	}
	if (addLines.length === 0) throw syntaxErrorAt(state.index + 1, "Add File requires at least one '+' line")
	return { type: "add", path, content: addLines.join("\n") + "\n" }
}

function parseUpdate(lines, state, path) {
	let movePath = null
	const hunks = []
	let current = []
	let currentContext = null
	let currentStartLine = null
	let sawLine = false

	const finish = (endOfFile = false) => {
		if (current.length > 0) {
			hunks.push({
				startLine: currentStartLine ?? state.index + 1,
				context: currentContext,
				endOfFile,
				lines: current,
			})
			current = []
		}
		currentContext = null
		currentStartLine = null
	}

	if (state.index < lines.length) {
		const move = parseMove(lines[state.index], state.index + 1)
		if (move !== null) {
			movePath = move
			state.index++
		}
	}

	while (state.index < lines.length) {
		const line = lines[state.index]
		if (line === "*** End Patch" || parseHeader(line, state.index + 1)) break
		if (line === EOF_MARKER) {
			if (!sawLine) throw syntaxErrorAt(state.index + 1, "'*** End of File' requires preceding hunk lines")
			finish(true)
			state.index++
			const next = lines[state.index]
			if (next !== undefined && next !== "*** End Patch" && !parseHeader(next, state.index + 1)) {
				throw syntaxErrorAt(state.index + 1, "expected an operation header after '*** End of File'")
			}
			break
		}
		if (line === "@@" || line.startsWith("@@ ")) {
			finish()
			currentStartLine = state.index + 1
			currentContext = line === "@@" ? null : line.slice(3)
			state.index++
			continue
		}
		const marker = line[0]
		if (marker !== " " && marker !== "+" && marker !== "-") {
			throw syntaxErrorAt(state.index + 1, "Update File hunk lines must start with ' ', '+', '-', or '@@'")
		}
		currentStartLine ??= state.index + 1
		current.push({ kind: marker, text: line.slice(1) })
		sawLine = true
		state.index++
	}
	finish()
	if (!movePath && (!sawLine || hunks.length === 0)) throw syntaxErrorAt(state.index + 1, "Update File requires at least one hunk line or '*** Move to'")
	const changedHunks = hunks.filter((hunk) => hunk.lines.some((line) => line.kind === "+" || line.kind === "-"))
	if (!movePath && hunks.length > 0 && changedHunks.length === 0) {
		throw syntaxErrorAt(hunks[0].startLine, `hunk 1 in ${path} contains no changes`)
	}
	return {
		type: "update",
		path,
		movePath,
		hunks: changedHunks.map(({ context, endOfFile, lines: hunkLines }) => ({ context, endOfFile, lines: hunkLines })),
	}
}

/**
 * Parse a strict Pinano/Codex-style patch.
 * @param {string} input
 * @returns {{ operations: any[] }}
 */
export function parseApplyPatch(input) {
	const lines = splitLines(input)
	if (lines.at(-1) === "") lines.pop()
	if (lines[0] !== "*** Begin Patch") throw syntaxErrorAt(1, "patch must start with '*** Begin Patch'")
	const state = { index: 1 }
	const operations = []
	while (state.index < lines.length) {
		const line = lines[state.index]
		if (line === "*** End Patch") {
			state.index++
			if (state.index !== lines.length) throw syntaxErrorAt(state.index + 1, "content after '*** End Patch' is not allowed")
			if (operations.length === 0) throw syntaxErrorAt(2, "patch must contain at least one operation")
			return { operations }
		}
		const header = parseHeader(line, state.index + 1)
		if (!header) throw syntaxErrorAt(state.index + 1, "expected an operation header")
		state.index++
		if (header.kind === "Add File") operations.push(parseAdd(lines, state, header.path))
		else if (header.kind === "Update File") operations.push(parseUpdate(lines, state, header.path))
		else operations.push({ type: "delete", path: header.path })
	}
	throw syntaxErrorAt(lines.length, "patch must end with '*** End Patch'")
}

function summarizeOperations(operations) {
	const counts = operations.reduce((acc, op) => {
		const key = op.type === "update" && op.movePath ? "move" : op.type
		return { ...acc, [key]: (acc[key] ?? 0) + 1 }
	}, {})
	return [
		counts.add ? `${counts.add} added` : null,
		counts.update ? `${counts.update} updated` : null,
		counts.move ? `${counts.move} moved` : null,
		counts.delete ? `${counts.delete} deleted` : null,
	].filter(Boolean).join(", ")
}

function uniqueFiles(operations, cwd) {
	const byAbs = new Map()
	const add = (path) => {
		const absolutePath = resolveToCwd(path, cwd)
		if (!byAbs.has(absolutePath)) byAbs.set(absolutePath, { absolutePath, path })
	}
	for (const operation of operations) {
		add(operation.path)
		if (operation.movePath) add(operation.movePath)
	}
	return [...byAbs.values()].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath))
}

async function withMutationQueues(files, fn, index = 0) {
	if (index >= files.length) return fn()
	return withFileMutationQueue(files[index].absolutePath, () => withMutationQueues(files, fn, index + 1))
}

async function assertReadableWritable(abs, path) {
	try {
		await access(abs, constants.R_OK | constants.W_OK)
	} catch (error) {
		const code = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error)
		throw new Error(`Could not access file: ${path}. ${code}.`)
	}
}

async function planPatch(operations, cwd, signal) {
	const files = uniqueFiles(operations, cwd)
	const states = new Map()
	const loadPath = async (path) => {
		const absolutePath = resolveToCwd(path, cwd)
		let state = states.get(absolutePath)
		if (state) return state
		state = { absolutePath, path, exists: true, bom: "", ending: "\n", baseContent: "", content: "" }
		try {
			const raw = (await readFile(absolutePath)).toString("utf-8")
			const stripped = stripBom(raw)
			state.bom = stripped.bom
			state.ending = detectLineEnding(stripped.text)
			state.baseContent = normalizeToLF(stripped.text)
			state.content = state.baseContent
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				state.exists = false
			} else {
				throw error
			}
		}
		states.set(absolutePath, state)
		return state
	}

	for (const operation of operations) {
		if (signal?.aborted) throw new Error("Operation aborted")
		const state = await loadPath(operation.path)
		if (operation.type === "add") {
			const existedBeforeAdd = state.exists && !state.deleted
			if (existedBeforeAdd) await assertReadableWritable(state.absolutePath, operation.path)
			state.exists = true
			state.added = true
			state.deleted = false
			state.bom = ""
			state.ending = "\n"
			state.baseContent = ""
			state.content = operation.content
		} else if (operation.type === "delete") {
			if (!state.exists || state.deleted) throw new Error(`Cannot delete ${operation.path}: file does not exist.`)
			await assertReadableWritable(state.absolutePath, operation.path)
			state.deleted = true
		} else if (operation.type === "update") {
			if (!state.exists || state.deleted) throw new Error(`Cannot update ${operation.path}: file does not exist.`)
			await assertReadableWritable(state.absolutePath, operation.path)
			const nextContent = operation.hunks.length > 0
				? applyUpdateHunks(state.content, operation.hunks, operation.path)
				: state.content
			if (operation.hunks.length > 0 && nextContent === state.content) throw new Error(`No changes made to ${operation.path}.`)
			if (!operation.movePath) {
				state.content = nextContent
				continue
			}
			const destination = await loadPath(operation.movePath)
			if (destination.absolutePath === state.absolutePath) {
				if (operation.hunks.length === 0) throw new Error(`No changes made to ${operation.path}.`)
				state.content = nextContent
				continue
			}
			if (destination.exists && !destination.deleted) await assertReadableWritable(destination.absolutePath, operation.movePath)
			const destinationPreviouslyExists = destination.exists && !destination.deleted
			destination.exists = true
			destination.deleted = false
			destination.added = !destinationPreviouslyExists
			destination.bom = state.bom
			destination.ending = state.ending
			destination.content = nextContent
			destination.movedFrom = operation.path
			state.deleted = true
			state.movedTo = operation.movePath
		}
	}

	return { files, states: [...states.values()] }
}

async function commitPatch(plan, options, signal) {
	for (const state of plan.states) {
		if (signal?.aborted) throw new Error("Operation aborted")
		await options.beforeFileMutation?.({ absolutePath: state.absolutePath, path: state.path })
	}
	for (const state of plan.states.filter((state) => !state.deleted)) {
		if (signal?.aborted) throw new Error("Operation aborted")
		await mkdir(dirname(state.absolutePath), { recursive: true })
		await writeFile(state.absolutePath, state.bom + restoreLineEndings(state.content, state.ending), "utf-8")
	}
	for (const state of plan.states.filter((state) => state.deleted)) {
		if (signal?.aborted) throw new Error("Operation aborted")
		await unlink(state.absolutePath)
	}
}

function renderResult(operations, states) {
	const parts = []
	for (const state of states) {
		if (state.movedTo) continue
		if (state.deleted) {
			parts.push(`Deleted ${state.path}.`)
			continue
		}
		const { diff, firstChangedLine } = generateDiffString(state.baseContent, state.content)
		if (state.movedFrom) parts.push(`Moved ${state.movedFrom} to ${state.path}.`)
		else parts.push(`${state.added ? "Added" : "Updated"} ${state.path}.`)
		if (diff) parts.push(diff)
		state.diff = diff
		state.firstChangedLine = firstChangedLine
	}
	return `Patch applied successfully (${summarizeOperations(operations)}).\n${parts.join("\n")}`
}

/**
 * @param {string} cwd
 * @param {{ beforeFileMutation?: (info: { absolutePath: string, path: string }) => Promise<void> | void }} [options]
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createApplyPatchTool(cwd, options = {}) {
	return {
		kind: "custom",
		name: "apply_patch",
		label: "apply_patch",
		description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
		format: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_GRAMMAR,
		},
		executionMode: "sequential",
		codeMode: {
			outputSchema: { type: "object", properties: {}, additionalProperties: false },
			projectResult: () => ({}),
		},
		async execute(_id, input, signal) {
			const patch = typeof input === "string" ? input : String(input ?? "")
			const parsed = parseApplyPatch(patch)
			const files = uniqueFiles(parsed.operations, cwd)
			return withMutationQueues(files, async () => {
				const plan = await planPatch(parsed.operations, cwd, signal)
				await commitPatch(plan, options, signal)
				const text = renderResult(parsed.operations, plan.states)
				return {
					content: [{ type: "text", text }],
					details: {
						operations: parsed.operations.map((op) => ({ type: op.type, path: op.path, movePath: op.movePath })),
						files: plan.states.map((state) => ({
							path: state.path,
							absolutePath: state.absolutePath,
							deleted: state.deleted === true,
							added: state.added === true,
							movedFrom: state.movedFrom,
							movedTo: state.movedTo,
							diff: state.diff,
							firstChangedLine: state.firstChangedLine,
						})),
					},
				}
			})
		},
	}
}
