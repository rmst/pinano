import { randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, rename, stat, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path"

import { runtimeSourceReferencePath, runtimeSourceReferenceRoot } from "./paths.js"

const metadataFileName = ".pinano-runtime-source-reference.json"
const generationRetentionCount = 3
const defaultPackageEntries = ["bin", "src", "README.md", "jsconfig.json"]
const excludedSourceNames = new Set([".git", ".jix", "node_modules"])

function safeGenerationPart(value) {
	return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown"
}

async function readPackageEntries(packageRoot) {
	try {
		const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf-8"))
		const files = Array.isArray(pkg.files) ? pkg.files : defaultPackageEntries
		return [...new Set([
			"package.json",
			...files
				.map(normalizePackageEntry)
				.filter(Boolean),
		])]
	} catch {
		return ["package.json", ...defaultPackageEntries]
	}
}

function normalizePackageEntry(entry) {
	if (typeof entry !== "string") return undefined
	const trimmed = entry.replace(/\/+$/g, "")
	if (!trimmed || trimmed.includes("*") || isAbsolute(trimmed)) return undefined
	const normalized = normalize(trimmed)
	if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) return undefined
	return normalized
}

async function pathExists(path) {
	try {
		await stat(path)
		return true
	} catch (err) {
		if (err?.code === "ENOENT") return false
		throw err
	}
}

async function chmodBestEffort(path, mode) {
	await chmod(path, mode).catch(() => {})
}

async function copyReferenceNode(source, target) {
	const info = await lstat(source)
	if (info.isSymbolicLink()) return
	if (info.isDirectory()) {
		if (excludedSourceNames.has(basename(source))) return
		await mkdir(target, { recursive: true })
		await chmodBestEffort(target, 0o755)
		const entries = await readdir(source, { withFileTypes: true })
		entries.sort((a, b) => a.name.localeCompare(b.name))
		await Promise.all(entries
			.filter((entry) => !excludedSourceNames.has(entry.name))
			.map((entry) => copyReferenceNode(join(source, entry.name), join(target, entry.name))))
		return
	}
	if (!info.isFile()) return
	await mkdir(dirname(target), { recursive: true })
	await copyFile(source, target)
	await chmodBestEffort(target, 0o644)
}

async function copyRuntimePackage(packageRoot, targetRoot) {
	const entries = await readPackageEntries(packageRoot)
	await Promise.all(entries.map(async (entry) => {
		const source = join(packageRoot, entry)
		if (!await pathExists(source)) return
		await copyReferenceNode(source, join(targetRoot, entry))
	}))
}

function referenceMetadata(identity, generationName) {
	return {
		version: 1,
		generation: generationName,
		runtimeKey: identity.runtimeKey,
		codeFingerprint: identity.codeFingerprint,
		packageName: identity.packageName,
		packageVersion: identity.packageVersion,
		mainPath: identity.mainPath,
		sourceRoot: identity.sourceRoot,
		packageRoot: identity.packageRoot,
		execPath: identity.execPath,
		writtenAt: new Date().toISOString(),
	}
}

async function writeMetadata(dir, metadata) {
	const path = join(dir, metadataFileName)
	await writeFile(path, JSON.stringify(metadata, null, "\t"))
	await chmodBestEffort(path, 0o644)
}

async function replaceCurrentSymlink(root, generationName) {
	const current = runtimeSourceReferencePath()
	const tmpLink = join(root, `current.tmp.${randomUUID()}`)
	await symlink(`generations/${generationName}`, tmpLink, "dir")
	try {
		await rename(tmpLink, current)
	} catch (err) {
		if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(err?.code)) {
			await rm(tmpLink, { force: true }).catch(() => {})
			throw err
		}
		await rm(current, { recursive: true, force: true })
		await rename(tmpLink, current)
	}
}

async function cleanupOldGenerations(root, keepGeneration) {
	const generationsRoot = join(root, "generations")
	const entries = await readdir(generationsRoot, { withFileTypes: true }).catch((err) => {
		if (err?.code === "ENOENT") return []
		throw err
	})
	const generationStats = await Promise.all(entries
		.filter((entry) => entry.isDirectory())
		.map(async (entry) => ({ entry, info: await stat(join(generationsRoot, entry.name)).catch(() => null) })))
	const complete = generationStats
		.filter(({ entry }) => !entry.name.includes(".tmp."))
		.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))
	const keep = new Set([keepGeneration, ...complete.slice(0, generationRetentionCount).map(({ entry }) => entry.name)])
	await Promise.all(generationStats
		.filter(({ entry }) => entry.name.includes(".tmp.") || !keep.has(entry.name))
		.map(({ entry }) => rm(join(generationsRoot, entry.name), { recursive: true, force: true }).catch(() => {})))
}

/**
 * Materialize a read-only, code-only copy of the Pinano package that owns the
 * running service. This reference is for tool environments and diagnostics; the
 * service continues to execute from its original packageRoot.
 * @param {object} identity
 * @param {string} identity.packageRoot
 * @param {string} [identity.runtimeKey]
 * @param {string} [identity.codeFingerprint]
 * @param {string} [identity.packageName]
 * @param {string} [identity.packageVersion]
 * @param {string} [identity.mainPath]
 * @param {string} [identity.sourceRoot]
 * @param {string} [identity.execPath]
 */
export async function ensureRuntimeSourceReference(identity) {
	if (!identity?.packageRoot) throw new Error("Cannot create Pinano runtime source reference without packageRoot")
	const root = runtimeSourceReferenceRoot()
	const generationsRoot = join(root, "generations")
	await mkdir(generationsRoot, { recursive: true })
	const generationName = `${safeGenerationPart(identity.codeFingerprint)}.${Date.now()}.${safeGenerationPart(randomUUID())}`
	const tempGeneration = join(generationsRoot, `${generationName}.tmp.${randomUUID()}`)
	const finalGeneration = join(generationsRoot, generationName)
	try {
		await mkdir(tempGeneration, { recursive: true })
		await copyRuntimePackage(identity.packageRoot, tempGeneration)
		await writeMetadata(tempGeneration, referenceMetadata(identity, generationName))
		await chmodBestEffort(tempGeneration, 0o755)
		await rename(tempGeneration, finalGeneration)
		await replaceCurrentSymlink(root, generationName)
		await cleanupOldGenerations(root, generationName)
		return { path: runtimeSourceReferencePath(), generationPath: finalGeneration, generation: generationName }
	} catch (err) {
		await rm(tempGeneration, { recursive: true, force: true }).catch(() => {})
		throw err
	}
}

