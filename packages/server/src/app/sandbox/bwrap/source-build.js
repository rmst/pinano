import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { delimiter } from "node:path"
import { dirname, isAbsolute, join } from "node:path"

import { dataRoot } from "../../paths.js"
import { bubblewrapSecurityProbeArgs } from "./isolation.js"

export const bundledBubblewrapSourceBuild = {
	version: 1,
	bubblewrap: {
		name: "bubblewrap",
		version: "0.11.2",
		repository: "https://github.com/containers/bubblewrap.git",
		ref: "refs/tags/v0.11.2",
		commit: "1b80120ef26a28e065e67f89bfef873f13bdd317",
	},
	libcap: {
		name: "libcap",
		version: "2.78",
		repository: "https://git.kernel.org/pub/scm/libs/libcap/libcap.git",
		ref: "refs/tags/libcap-korg-2.78",
		commit: "a1fef85d27d0ee12729a64d1c9b2183c6007e56a",
	},
}

const sourceBuildTools = ["git", "make", "cc", "ar", "ranlib", "grep", "sed"]
const sourceBuildSmokeArgs = bubblewrapSecurityProbeArgs()

/** @param {Buffer | Uint8Array | string} data */
function sha256(data) {
	return createHash("sha256").update(data).digest("hex")
}

function sourceBuildId() {
	const bwrap = bundledBubblewrapSourceBuild.bubblewrap
	const libcap = bundledBubblewrapSourceBuild.libcap
	return `bubblewrap-${bwrap.version}-${bwrap.commit.slice(0, 12)}-libcap-${libcap.version}-${libcap.commit.slice(0, 12)}`
}

/** @param {{ cacheRoot?: string, sourceBuildCacheRoot?: string, asset?: any }} [options] */
export function sourceBuiltBubblewrapCacheRoot(options = {}) {
	const asset = options.asset
	if (!asset?.targetTriple) return undefined
	if (options.sourceBuildCacheRoot) return options.sourceBuildCacheRoot
	if (options.cacheRoot) return join(options.cacheRoot, "source", sourceBuildId(), asset.targetTriple)
	return join(dataRoot(), "tools", "bwrap", "source", sourceBuildId(), asset.targetTriple)
}

/** @param {{ cacheRoot?: string, sourceBuildCacheRoot?: string, asset?: any }} [options] */
export function sourceBuiltBubblewrapPath(options = {}) {
	const root = sourceBuiltBubblewrapCacheRoot(options)
	return root ? join(root, "bwrap") : undefined
}

/** @param {string} path */
export function sourceBuiltBubblewrapManifestPath(path) {
	return `${path}.source-build.json`
}

/** @param {string} command @param {NodeJS.ProcessEnv} [env] */
async function commandExistsOnPath(command, env = process.env) {
	if (!command || command.includes("/")) {
		if (!command || !isAbsolute(command)) return false
		try {
			await access(command, constants.X_OK)
			return true
		} catch {
			return false
		}
	}
	const pathEntries = String(env.PATH ?? "").split(delimiter).filter(Boolean)
	for (const entry of pathEntries) {
		try {
			await access(join(entry, command), constants.X_OK)
			return true
		} catch {}
	}
	return false
}

/** @param {NodeJS.ProcessEnv} [env] */
async function missingSourceBuildTools(env = process.env) {
	const present = await Promise.all(sourceBuildTools.map(async (tool) => [tool, await commandExistsOnPath(tool, env)]))
	return present.filter(([, ok]) => !ok).map(([tool]) => tool)
}

function lastOutput(output) {
	const max = 8000
	return output.length > max ? output.slice(output.length - max) : output
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (chunk) => {
			stdout += chunk
			stdout = lastOutput(stdout)
		})
		child.stderr.on("data", (chunk) => {
			stderr += chunk
			stderr = lastOutput(stderr)
		})
		child.on("error", reject)
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve({ stdout, stderr })
				return
			}
			const suffix = [stdout.trim() ? `stdout:\n${stdout.trim()}` : "", stderr.trim() ? `stderr:\n${stderr.trim()}` : ""].filter(Boolean).join("\n")
			const status = signal ? `signal ${signal}` : `exit ${code}`
			reject(new Error(`${command} ${args.join(" ")} failed with ${status}${suffix ? `\n${suffix}` : ""}`))
		})
	})
}

/**
 * @param {{ name: string, repository: string, ref: string, commit: string }} source
 * @param {string} dest
 * @param {{ env?: NodeJS.ProcessEnv }} options
 */
async function clonePinnedSource(source, dest, options) {
	await run("git", ["init", dest], options)
	await run("git", ["-C", dest, "remote", "add", "origin", source.repository], options)
	try {
		await run("git", ["-C", dest, "fetch", "--depth", "1", "--filter=blob:none", "origin", source.ref], options)
	} catch {
		await run("git", ["-C", dest, "fetch", "--depth", "1", "origin", source.ref], options)
	}
	await run("git", ["-C", dest, "checkout", "--detach", source.commit], options)
	const actual = (await run("git", ["-C", dest, "rev-parse", "HEAD"], options)).stdout.trim()
	if (actual !== source.commit) throw new Error(`${source.name} source resolved to ${actual}, expected ${source.commit}`)
}

/** @param {unknown} value */
function isSourceBuildManifest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const manifest = /** @type {any} */ (value)
	return manifest.kind === "source-build"
		&& manifest.version === bundledBubblewrapSourceBuild.version
		&& manifest.bubblewrap?.commit === bundledBubblewrapSourceBuild.bubblewrap.commit
		&& manifest.libcap?.commit === bundledBubblewrapSourceBuild.libcap.commit
		&& typeof manifest.binarySha256 === "string"
}

/** @param {string} binarySha256 */
function sourceBuildManifest(binarySha256) {
	return {
		kind: "source-build",
		version: bundledBubblewrapSourceBuild.version,
		builtAt: new Date().toISOString(),
		binarySha256,
		bubblewrap: bundledBubblewrapSourceBuild.bubblewrap,
		libcap: bundledBubblewrapSourceBuild.libcap,
	}
}

/** @param {{ cacheRoot?: string, sourceBuildCacheRoot?: string, asset?: any }} [options] */
export async function verifiedCachedSourceBuiltBubblewrapPath(options = {}) {
	const path = sourceBuiltBubblewrapPath(options)
	if (!path || !existsSync(path)) return undefined
	try {
		const [binary, manifestText] = await Promise.all([
			readFile(path),
			readFile(sourceBuiltBubblewrapManifestPath(path), "utf8"),
		])
		const manifest = JSON.parse(manifestText)
		if (!isSourceBuildManifest(manifest)) return undefined
		if (sha256(binary) !== manifest.binarySha256) return undefined
		await chmod(path, 0o755).catch(() => {})
		return path
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

/** @param {{ cacheRoot?: string, sourceBuildCacheRoot?: string, asset?: any, env?: NodeJS.ProcessEnv }} [options] */
export async function buildBundledBubblewrapFromSource(options = {}) {
	const asset = options.asset
	const path = sourceBuiltBubblewrapPath(options)
	if (!asset || !path) throw new Error("Cannot build bundled Bubblewrap from source for this platform or architecture")
	const existing = await verifiedCachedSourceBuiltBubblewrapPath(options)
	if (existing) return { path: existing, asset, reused: true, sourceBuild: bundledBubblewrapSourceBuild }
	const env = options.env ?? process.env
	const missing = await missingSourceBuildTools(env)
	if (missing.length > 0) throw new Error(`Cannot build bundled Bubblewrap from source; missing build tools: ${missing.join(", ")}`)

	const root = dirname(path)
	const workDir = join(root, `.build.${process.pid}.${randomUUID()}`)
	const bwrapDir = join(workDir, "bubblewrap")
	const libcapDir = join(workDir, "libcap")
	const buildDir = join(workDir, "build")
	await mkdir(buildDir, { recursive: true, mode: 0o700 })
	try {
		await Promise.all([
			clonePinnedSource(bundledBubblewrapSourceBuild.bubblewrap, bwrapDir, { env }),
			clonePinnedSource(bundledBubblewrapSourceBuild.libcap, libcapDir, { env }),
		])
		await writeFile(join(buildDir, "config.h"), `#define PACKAGE_STRING "bubblewrap ${bundledBubblewrapSourceBuild.bubblewrap.version}"\n`)
		await run("make", [
			"-C", join(libcapDir, "libcap"),
			"CC=cc",
			"BUILD_CC=cc",
			"AR=ar",
			"RANLIB=ranlib",
			"SHARED=no",
			"PTHREADS=no",
			"USE_GPERF=no",
			"INDENT=",
			"libcap.a",
		], { env })
		const sources = ["bubblewrap.c", "bind-mount.c", "network.c", "utils.c"].map((file) => join(bwrapDir, file))
		await run("cc", [
			"-D_GNU_SOURCE",
			`-I${buildDir}`,
			`-I${bwrapDir}`,
			`-I${join(libcapDir, "libcap", "include")}`,
			`-I${join(libcapDir, "libcap", "include", "uapi")}`,
			"-O2",
			"-g",
			"-c",
			...sources,
		], { cwd: buildDir, env })
		const candidate = join(buildDir, "bwrap")
		await run("cc", [
			"-o", candidate,
			join(buildDir, "bubblewrap.o"),
			join(buildDir, "bind-mount.o"),
			join(buildDir, "network.o"),
			join(buildDir, "utils.o"),
			join(libcapDir, "libcap", "libcap.a"),
		], { env })
		if (await commandExistsOnPath("strip", env)) {
			await run("strip", [candidate], { env }).catch(() => {})
		}
		const version = (await run(candidate, ["--version"], { env })).stdout.trim()
		if (version !== `bubblewrap ${bundledBubblewrapSourceBuild.bubblewrap.version}`) {
			throw new Error(`Source-built Bubblewrap reported ${JSON.stringify(version)}`)
		}
		await run(candidate, sourceBuildSmokeArgs, { env })
		await chmod(candidate, 0o755)
		const tempPath = join(root, `.bwrap.${process.pid}.${randomUUID()}.tmp`)
		const tempManifestPath = sourceBuiltBubblewrapManifestPath(tempPath)
		await rename(candidate, tempPath)
		const binarySha256 = sha256(await readFile(tempPath))
		await writeFile(tempManifestPath, JSON.stringify(sourceBuildManifest(binarySha256), null, "\t"))
		await rename(tempPath, path)
		await rename(tempManifestPath, sourceBuiltBubblewrapManifestPath(path))
		await chmod(path, 0o755).catch(() => {})
		return { path, asset, reused: false, sourceBuild: bundledBubblewrapSourceBuild }
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {})
	}
}
