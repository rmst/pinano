import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { LEGACY_PRODUCT_STATE_DIRECTORY, PRODUCT_STATE_DIRECTORY, PROJECT_DOCUMENTS_DIRECTORY_NAME } from "../../../../protocol/src/product.js"

export const PROJECT_STATE_DIRNAME = PRODUCT_STATE_DIRECTORY
export const LEGACY_PROJECT_STATE_DIRNAME = LEGACY_PRODUCT_STATE_DIRECTORY
export const PROJECT_METADATA_RELATIVE_PATH = `${PROJECT_STATE_DIRNAME}/project.json`
export const LEGACY_PROJECT_METADATA_RELATIVE_PATH = `${LEGACY_PROJECT_STATE_DIRNAME}/project.json`

const PROJECT_PREVIEWS_DIRECTORY_NAME = "previews"
const PROJECT_PREVIEWS_TREE_GITIGNORE_ENTRY = `!${PROJECT_PREVIEWS_DIRECTORY_NAME}/**`

const projectMetadataMigrations = new Map()

/** Project metadata is JSON, so a recursively key-sorted representation gives us runtime-portable semantic equality. @param {unknown} value */
function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue)
	if (!value || typeof value !== "object") return value
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]))
}

/** @param {unknown} value */
export function cleanProjectId(value) {
	if (typeof value !== "string") return ""
	const id = value.trim().toLowerCase()
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : ""
}

/** @param {unknown} a @param {unknown} b */
function jsonValuesEqual(a, b) {
	return JSON.stringify(canonicalJsonValue(a)) === JSON.stringify(canonicalJsonValue(b))
}

/** @param {unknown} value */
export function cleanProjectName(value) {
	if (typeof value !== "string") return ""
	return value.replace(/\s+/g, " ").trim().slice(0, 64)
}

/** @param {unknown} value */
export function projectNameKey(value) {
	return cleanProjectName(value).toLowerCase()
}

/** @param {unknown} a @param {unknown} b */
export function projectNamesEqual(a, b) {
	const left = projectNameKey(a)
	const right = projectNameKey(b)
	return left !== "" && left === right
}

/**
 * @param {string} path
 * @param {string} [home]
 */
export function compactUserPath(path, home = homedir()) {
	const absolute = resolve(path)
	const resolvedHome = resolve(home)
	if (absolute === resolvedHome) return "~"
	if (absolute.startsWith(`${resolvedHome}/`)) return `~${absolute.slice(resolvedHome.length)}`
	return absolute
}

/** @param {string} cwd */
export async function cwdHasGitMetadata(cwd) {
	try {
		await lstat(join(cwd, ".git"))
		return true
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT") return false
		throw err
	}
}

/** @param {string} cwd */
async function readJsonObject(path) {
	try {
		const data = JSON.parse(await readFile(path, "utf-8"))
		return data && typeof data === "object" && !Array.isArray(data) ? data : {}
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT" || err instanceof SyntaxError) return undefined
		throw err
	}
}

/** @param {string} path */
async function pathExists(path) {
	try {
		await lstat(path)
		return true
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT") return false
		throw err
	}
}

/** Create a directory only when its parent still exists, so delayed project writes cannot recreate a removed project root. @param {string} path */
async function ensureChildDirectory(path) {
	try {
		await mkdir(path)
	} catch (/** @type {any} */ err) {
		if (err?.code !== "EEXIST") throw err
		const info = await lstat(path)
		if (!info.isDirectory() || info.isSymbolicLink()) throw err
	}
}

/** Create the preview-local ignore without overwriting an existing policy. @param {string} root */
export async function initializeProjectPreviewDirectoryIgnore(root) {
	const previewsDir = join(resolve(root), PROJECT_STATE_DIRNAME, PROJECT_PREVIEWS_DIRECTORY_NAME)
	try {
		const info = await lstat(previewsDir)
		if (!info.isDirectory() || info.isSymbolicLink()) return false
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false
		throw err
	}
	try {
		await writeFile(join(previewsDir, ".gitignore"), "*\n", { flag: "wx" })
		return true
	} catch (/** @type {any} */ err) {
		if (err?.code === "EEXIST") return false
		throw err
	}
}

/** @param {string} root */
async function ensureCanonicalProjectStateDirectoryIgnored(root) {
	const stateDir = join(root, PROJECT_STATE_DIRNAME)
	await ensureChildDirectory(stateDir)
	const gitignore = join(stateDir, ".gitignore")
	let text
	try {
		text = await readFile(gitignore, "utf-8")
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
		text = ""
	}
	const entries = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
	// Initialize existing preview directories before the parent rule exposes their contents; that rule then serves as the one-time migration marker.
	if (!entries.includes(PROJECT_PREVIEWS_TREE_GITIGNORE_ENTRY)) await initializeProjectPreviewDirectoryIgnore(root)
	const required = [
		"*",
		`!${PROJECT_DOCUMENTS_DIRECTORY_NAME}/`,
		`!${PROJECT_DOCUMENTS_DIRECTORY_NAME}/**`,
		`!${PROJECT_PREVIEWS_DIRECTORY_NAME}/`,
		PROJECT_PREVIEWS_TREE_GITIGNORE_ENTRY,
	]
	const missing = required.filter((entry) => !entries.includes(entry))
	if (missing.length === 0) return { changed: false, path: gitignore }
	const prefix = text && !text.endsWith("\n") ? "\n" : ""
	await writeFile(gitignore, `${text}${prefix}${missing.join("\n")}\n`)
	return { changed: true, path: gitignore }
}

/** Remove the legacy state directory only when no worktrees or unknown user state remain. @param {string} cwd */
export async function cleanupLegacyProjectStateDirectory(cwd) {
	const legacyDir = join(resolve(cwd), LEGACY_PROJECT_STATE_DIRNAME)
	let entries
	try {
		entries = await readdir(legacyDir)
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false
		throw err
	}
	if (entries.some((entry) => entry !== ".gitignore")) return false
	if (entries.includes(".gitignore")) await rm(join(legacyDir, ".gitignore"), { force: true })
	try {
		await rmdir(legacyDir)
		return true
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT") return true
		if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST") return false
		throw err
	}
}

/** @param {string} root */
async function migrateLegacyProjectMetadataOnce(root) {
	const canonicalPath = join(root, PROJECT_METADATA_RELATIVE_PATH)
	const legacyPath = join(root, LEGACY_PROJECT_METADATA_RELATIVE_PATH)
	const [canonicalExists, legacyExists] = await Promise.all([pathExists(canonicalPath), pathExists(legacyPath)])
	if (!legacyExists) return { migrated: false, ignoreChanged: false }
	if (canonicalExists) {
		const [canonical, legacy] = await Promise.all([readJsonObject(canonicalPath), readJsonObject(legacyPath)])
		if (!canonical || !legacy || !jsonValuesEqual(canonical, legacy)) {
			throw new Error(`Conflicting project metadata exists at ${canonicalPath} and legacy ${legacyPath}. Remove or reconcile the legacy file.`)
		}
		await rm(legacyPath, { force: true })
	} else {
		await ensureChildDirectory(join(root, PROJECT_STATE_DIRNAME))
		await rename(legacyPath, canonicalPath)
	}
	const ignore = await ensureCanonicalProjectStateDirectoryIgnored(root)
	await cleanupLegacyProjectStateDirectory(root)
	return { migrated: true, ignoreChanged: ignore.changed }
}

/** Move legacy project metadata into `.cerex` before canonical metadata is used. @param {string} cwd */
export async function migrateLegacyProjectMetadata(cwd) {
	const root = resolve(cwd)
	const pending = projectMetadataMigrations.get(root)
	if (pending) return pending
	const migration = migrateLegacyProjectMetadataOnce(root)
	projectMetadataMigrations.set(root, migration)
	try {
		return await migration
	} finally {
		if (projectMetadataMigrations.get(root) === migration) projectMetadataMigrations.delete(root)
	}
}

/** @param {string} cwd */
async function readProjectMetadataObject(cwd) {
	return await readJsonObject(join(cwd, PROJECT_METADATA_RELATIVE_PATH)) ?? {}
}

/** Read a project's internal identity without adding it to user/model-facing project metadata. @param {string | undefined} cwd */
export async function projectIdentityForCwd(cwd) {
	const root = resolve(cwd || process.cwd())
	await migrateLegacyProjectMetadata(root)
	return { id: cleanProjectId((await readProjectMetadataObject(root)).id) || undefined }
}

/** @param {string} cwd */
export async function ensureProjectStateDirectoryIgnored(cwd) {
	const root = resolve(cwd)
	const migration = await migrateLegacyProjectMetadata(root)
	const ignore = await ensureCanonicalProjectStateDirectoryIgnored(root)
	return { ...ignore, changed: migration.ignoreChanged || ignore.changed }
}

/** Ensure that a project root has a durable local identity. Supplying replace=true is reserved for resolving copied metadata whose ID already belongs to another registered root.
 * @param {string | undefined} cwd
 * @param {{ id?: string, replace?: boolean }} [options]
 */
export async function ensureProjectIdentityForCwd(cwd, options = {}) {
	const root = resolve(cwd || process.cwd())
	await migrateLegacyProjectMetadata(root)
	const metadata = await readProjectMetadataObject(root)
	const existingId = cleanProjectId(metadata.id)
	const requestedId = options.id === undefined ? "" : cleanProjectId(options.id)
	if (options.id !== undefined && !requestedId) throw Object.assign(new Error("project id must be a UUID"), { status: 400 })
	if (existingId && requestedId && existingId !== requestedId && options.replace !== true) {
		throw Object.assign(new Error("project already has a different identity"), { status: 409 })
	}
	const id = options.replace === true ? requestedId || randomUUID() : existingId || requestedId || randomUUID()
	const write = await writeProjectMetadataPatch(root, { id })
	return {
		id,
		project: await projectInfoForCwd(root),
		changed: write.changed,
		ignoreChanged: write.ignoreChanged,
		metadataPath: write.metadataPath,
		gitignorePath: write.gitignorePath,
	}
}

/**
 * @param {string | undefined} cwd
 * @param {Record<string, unknown>} patch
 */
export async function writeProjectMetadataPatch(cwd, patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("project metadata patch must be an object")
	const root = resolve(cwd || process.cwd())
	const ignore = await ensureProjectStateDirectoryIgnored(root)
	const metadataPath = join(root, PROJECT_METADATA_RELATIVE_PATH)
	const canonicalBefore = await readJsonObject(metadataPath)
	const before = await readProjectMetadataObject(root)
	const metadata = { ...before, ...patch }
	const beforeText = canonicalBefore ? `${JSON.stringify(canonicalBefore, null, "\t")}\n` : undefined
	const afterText = `${JSON.stringify(metadata, null, "\t")}\n`
	const changed = beforeText !== afterText
	if (changed) await writeFile(metadataPath, afterText)
	return {
		changed,
		ignoreChanged: ignore.changed,
		metadata,
		metadataPath,
		gitignorePath: ignore.path,
	}
}

/**
 * @param {string | undefined} cwd
 * @param {unknown} value
 */
export async function setProjectNameForCwd(cwd, value) {
	const root = resolve(cwd || process.cwd())
	const name = cleanProjectName(value)
	if (!name) throw Object.assign(new Error("project name must not be empty"), { status: 400 })
	const write = await writeProjectMetadataPatch(root, { name })
	const project = await projectInfoForCwd(root)
	return {
		project,
		changed: write.changed,
		ignoreChanged: write.ignoreChanged,
		metadataPath: write.metadataPath,
		gitignorePath: write.gitignorePath,
	}
}

/**
 * Project association is intentionally shallow: callers choose the directory
 * used for project identity. Cerex reads `.cerex/project.json` from that
 * exact directory and otherwise falls back to a path label instead of guessing
 * an ancestor root.
 * @param {string | undefined} cwd
 */
export async function projectInfoForCwd(cwd) {
	const root = resolve(cwd || process.cwd())
	await migrateLegacyProjectMetadata(root)
	const metadata = await readProjectMetadataObject(root)
	const name = cleanProjectName(metadata.name)
	if (name) return {
		label: name,
		name,
		source: "project-json",
		root,
		metadataPath: join(root, PROJECT_METADATA_RELATIVE_PATH),
	}
	if (await cwdHasGitMetadata(root)) {
		return {
			label: compactUserPath(root),
			source: "path",
			root,
			metadataPath: join(root, PROJECT_METADATA_RELATIVE_PATH),
			missingProjectMetadata: true,
		}
	}
	return {
		label: compactUserPath(root),
		source: "path",
		root,
	}
}
