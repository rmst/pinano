/** Helpers for projecting durable context-load entries into compact, user-visible transcript markers. The model-visible context bundle keeps the full file contents; display messages intentionally carry only metadata and paths. */

function timestampMs(value) {
	if (typeof value === "number") return value
	const ms = Date.parse(String(value ?? ""))
	return Number.isFinite(ms) ? ms : Date.now()
}

function displayFile(file) {
	return {
		path: file.path,
		...(file.scopeDir ? { scopeDir: file.scopeDir } : {}),
		...(file.hash ? { hash: file.hash } : {}),
	}
}

export function contextLoadDisplayFiles(load) {
	if (!load || load.disabled) return []
	return (load.files ?? [])
		.filter((file) => typeof file?.path === "string" && file.path.length > 0)
		.map(displayFile)
}

export function contextLoadDisplayText(load) {
	const files = contextLoadDisplayFiles(load)
	if (files.length === 0) return ""
	return files.map((file) => `loaded ${file.path}`).join("\n")
}

export function contextLoadDisplayMessage(input = {}) {
	const value = input ?? {}
	const load = value.contextLoad ?? value
	const text = contextLoadDisplayText(load)
	if (!text) return undefined
	return {
		role: "contextLoad",
		content: [{ type: "text", text }],
		timestamp: timestampMs(value.timestamp ?? load.loadedAt),
		contextLoad: {
			source: load.source ?? "unknown",
			...(load.cwd ? { cwd: load.cwd } : {}),
			...(load.loadedAt ? { loadedAt: load.loadedAt } : {}),
			files: contextLoadDisplayFiles(load),
		},
	}
}

export function contextLoadPathsFromMessage(message) {
	if (message?.role !== "contextLoad") return []
	return contextLoadDisplayFiles(message.contextLoad).map((file) => file.path)
}
