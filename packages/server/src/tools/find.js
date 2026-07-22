import { spawn } from "node:child_process"

import { resolveToCwd } from "./path-utils.js"
import { walk } from "./walk.js"

const findSchema = {
	type: "object",
	properties: {
		glob: { type: "string", description: "Glob pattern to match, e.g. '**/*.ts' or 'src/**/*.{js,ts}'" },
		path: { type: "string", description: "Directory to search in (default: cwd)" },
		limit: { type: "number", description: "Maximum number of results (default: 200)" },
	},
	required: ["glob"],
	additionalProperties: false,
}

let rgProbe

function probeRg() {
	if (rgProbe) return rgProbe
	rgProbe = new Promise((resolve) => {
		let child
		try {
			child = spawn("rg", ["--version"])
		} catch {
			resolve(false)
			return
		}
		let done = false
		const finish = (v) => {
			if (done) return
			done = true
			resolve(v)
		}
		child.on("error", () => finish(false))
		child.on("close", (code) => finish(code === 0))
	})
	return rgProbe
}

/** Test-only: force the probe result. Pass `undefined` to clear the cache. */
export function _setRgAvailable(value) {
	rgProbe = value === undefined ? undefined : Promise.resolve(value)
}

/**
 * Find files by glob. Uses ripgrep when available, falls back to a pure-JS
 * walker (respects .gitignore) when `rg` is missing.
 *
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createFindTool(cwd) {
	return {
		name: "find",
		label: "find",
		description:
			"Find files by glob pattern. Honors .gitignore. Returns paths relative to the search directory, sorted lexically.",
		parameters: findSchema,
		async execute(_id, { glob, path, limit = 200 }, signal) {
			if (typeof glob !== "string" || glob.length === 0) {
				throw new Error("find: `glob` is required (e.g. '*.ts', '**/*.{js,ts}')")
			}
			const target = path ? resolveToCwd(path, cwd) : cwd
			const haveRg = await probeRg()
			const all = haveRg ? await runRg({ glob, target, cwd, signal }) : await runJs({ glob, target, signal })
			all.sort()
			const limited = all.slice(0, limit)
			const text =
				limited.length === 0
					? "(no matches)"
					: limited.join("\n") + (all.length > limit ? `\n[Showing first ${limit} of ${all.length} matches]` : "")
			return {
				content: [{ type: "text", text }],
				details: { count: all.length, limitReached: all.length > limit },
			}
		},
	}
}

function runRg({ glob, target, cwd, signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"))
			return
		}
		const child = spawn("rg", ["--files", "-g", glob, target], { cwd })
		if (!child.stdout || !child.stderr) {
			reject(new Error("ripgrep: failed to attach to child process streams"))
			return
		}
		let stdout = ""
		let stderr = ""
		let aborted = false
		const onAbort = () => {
			aborted = true
			child.kill("SIGTERM")
		}
		signal?.addEventListener("abort", onAbort, { once: true })
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf-8")
		})
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf-8")
		})
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort)
			reject(err)
		})
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort)
			if (aborted) {
				reject(new Error("Operation aborted"))
				return
			}
			if (code === 2) {
				reject(new Error(stderr.trim() || "ripgrep failed"))
				return
			}
			resolve(stdout.split("\n").filter(Boolean))
		})
	})
}

async function runJs({ glob, target, signal }) {
	const results = []
	for await (const { fullPath } of walk(target, { glob, signal })) {
		if (signal?.aborted) throw new Error("Operation aborted")
		results.push(fullPath)
	}
	return results
}
