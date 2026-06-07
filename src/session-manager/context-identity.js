import { realpathSync } from "node:fs"
import { resolve } from "node:path"

/** Return the stable identity key used to dedupe context files. Existing files are keyed by realpath so symlink spellings of the same AGENTS.md / CLAUDE.md do not load twice. Missing legacy paths fall back to an absolute path string. */
export function contextFileIdentityPath(path) {
	if (typeof path !== "string" || path.length === 0) return ""
	const abs = resolve(path)
	try {
		return realpathSync(abs)
	} catch {
		return abs
	}
}

/** @param {{ path?: string, identityPath?: string } | string | null | undefined} file */
export function contextFileIdentity(file) {
	if (typeof file !== "string" && typeof file?.identityPath === "string" && file.identityPath.length > 0) return file.identityPath
	return contextFileIdentityPath(typeof file === "string" ? file : file?.path)
}
