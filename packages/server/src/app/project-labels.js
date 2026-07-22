import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const PROJECT_METADATA_RELATIVE_PATH = ".pinano/project.json"

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
async function readProjectMetadataName(cwd) {
	try {
		const data = JSON.parse(await readFile(join(cwd, PROJECT_METADATA_RELATIVE_PATH), "utf-8"))
		return cleanProjectName(data?.name)
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT" || err instanceof SyntaxError) return ""
		throw err
	}
}

/** @param {string} cwd */
export async function ensurePinanoDirectoryIgnored(cwd) {
	const pinanoDir = join(resolve(cwd), ".pinano")
	await mkdir(pinanoDir, { recursive: true })
	const gitignore = join(pinanoDir, ".gitignore")
	let text
	try {
		text = await readFile(gitignore, "utf-8")
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
		text = ""
	}
	const entries = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
	if (entries.includes("*")) return { changed: false, path: gitignore }
	const prefix = text && !text.endsWith("\n") ? "\n" : ""
	await writeFile(gitignore, `${text}${prefix}*\n`)
	return { changed: true, path: gitignore }
}

/** @param {string} cwd */
async function readProjectMetadataObject(cwd) {
	try {
		const data = JSON.parse(await readFile(join(cwd, PROJECT_METADATA_RELATIVE_PATH), "utf-8"))
		return data && typeof data === "object" && !Array.isArray(data) ? data : {}
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT" || err instanceof SyntaxError) return {}
		throw err
	}
}

/**
 * @param {string | undefined} cwd
 * @param {Record<string, unknown>} patch
 */
export async function writeProjectMetadataPatch(cwd, patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("project metadata patch must be an object")
	const root = resolve(cwd || process.cwd())
	const ignore = await ensurePinanoDirectoryIgnored(root)
	const metadataPath = join(root, PROJECT_METADATA_RELATIVE_PATH)
	const before = await readProjectMetadataObject(root)
	const metadata = { ...before, ...patch }
	const beforeText = `${JSON.stringify(before, null, "\t")}\n`
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
 * used for project identity. Pinano reads `.pinano/project.json` from that
 * exact directory and otherwise falls back to a path label instead of guessing
 * an ancestor root.
 * @param {string | undefined} cwd
 */
export async function projectInfoForCwd(cwd) {
	const root = resolve(cwd || process.cwd())
	const name = await readProjectMetadataName(root)
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
