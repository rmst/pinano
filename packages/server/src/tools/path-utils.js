import os from "node:os"
import { isAbsolute, resolve } from "node:path"

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

function normalizeUnicodeSpaces(str) {
	return str.replace(UNICODE_SPACES, " ")
}

/** Strip a leading "@" used by some chat UIs to flag file references. */
function normalizeAtPrefix(filePath) {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath
}

/** Expand `~` and normalize odd unicode spaces. */
export function expandPath(filePath) {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath))
	if (normalized === "~") return os.homedir()
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1)
	return normalized
}

/** Resolve `filePath` against `cwd`. Handles `~` expansion and absolute paths. */
export function resolveToCwd(filePath, cwd) {
	const expanded = expandPath(filePath)
	if (isAbsolute(expanded)) return expanded
	return resolve(cwd, expanded)
}
