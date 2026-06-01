import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { configuredWorkerSpec } from "./service-config.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")
const defaultWorkerPath = join(here, "tool-worker.js")
const defaultWorkerEntry = "src/app/tool-worker.js"
const MIN_NODE_VERSION = [22, 6, 0]
const defaultRemoteSourceRootProbe = "printf %s \"${HOME:-/tmp}/.pinano/workers/source\""
const sourceSnapshotVersion = "pinano-source-v2"

/** @param {string} s */
export function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function sourceReadyCheck(path) {
	return `test -f ${shellQuote(`${path}/.pinano-source-ready`)}`
}

function writeSourceReady(path) {
	const marker = shellQuote(`${path}/.pinano-source-ready`)
	return `: > ${marker} && chmod 0644 ${marker}`
}

/** @param {string | undefined} workerPath */
function sourceWorkerEntry(workerPath) {
	if (!workerPath) return defaultWorkerEntry
	const entry = relative(repoRoot, resolve(workerPath)).replaceAll("\\", "/")
	if (entry.startsWith("../") || entry === ".." || entry.startsWith("/")) return defaultWorkerEntry
	return entry
}

/** @param {string} version */
function parseNodeVersion(version) {
	const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
	if (!match) return null
	return match.slice(1).map(Number)
}

/** @param {number[]} version */
function nodeVersionOk(version) {
	for (let i = 0; i < MIN_NODE_VERSION.length; i++) {
		if (version[i] > MIN_NODE_VERSION[i]) return true
		if (version[i] < MIN_NODE_VERSION[i]) return false
	}
	return true
}

/** @param {string} command @param {string[]} args @param {any} [options] */
function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk) => { stdout += chunk })
		child.stderr?.on("data", (chunk) => { stderr += chunk })
		child.on("error", reject)
		child.on("exit", (code, signal) => {
			if (code === 0) resolve({ stdout, stderr })
			else reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` (${signal})` : ` (code ${code})`}${stderr ? `: ${stderr.trim()}` : ""}`))
		})
		if (options.input) {
			options.input.on("data", (chunk) => child.stdin.write(chunk))
			options.input.on("end", () => child.stdin.end())
			options.input.on("error", reject)
		}
	})
}

/** @param {string} command @param {string[]} args @param {any} [options] */
function spawnRpc(command, args, options = {}) {
	return spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
}

async function sourceEntries(dir = repoRoot, prefix = "") {
	const entries = await readdir(dir, { withFileTypes: true })
	entries.sort((a, b) => a.name.localeCompare(b.name))
	const files = []
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".jix") continue
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (prefix === "" && entry.name !== "src") continue
			files.push(...await sourceEntries(path, relative))
		} else if (entry.isFile()) {
			if (relative === "package.json" || relative.startsWith("src/")) files.push({ path, relative })
		}
	}
	return files
}

export async function currentSourceHash() {
	const hash = createHash("sha256")
	hash.update(sourceSnapshotVersion)
	hash.update("\0")
	for (const file of await sourceEntries()) {
		hash.update(file.relative)
		hash.update("\0")
		hash.update(await readFile(file.path))
		hash.update("\0")
	}
	return hash.digest("hex")
}

async function normalizeSnapshotPermissions(dir, { root = false } = {}) {
	if (!root) await chmod(dir, 0o755)
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) await normalizeSnapshotPermissions(path)
		else if (entry.isFile()) await chmod(path, 0o644)
	}
}

export async function createSourceSnapshot() {
	const hash = await currentSourceHash()
	const dir = await mkdtemp(join(tmpdir(), `pinano-worker-source-${hash.slice(0, 12)}-`))
	for (const file of await sourceEntries()) {
		const target = join(dir, file.relative)
		await mkdir(dirname(target), { recursive: true })
		await cp(file.path, target, { recursive: true, force: true })
	}
	await normalizeSnapshotPermissions(dir, { root: true })
	return { dir, hash }
}

/** @param {string} output */
function parseRuntime(output) {
	const [runtime, version = ""] = output.trim().split(/\r?\n/)
	if (runtime === "node") {
		const parsed = parseNodeVersion(version)
		if (!parsed || !nodeVersionOk(parsed)) throw new Error(`Remote Node ${version || "unknown"} is too old; need >= ${MIN_NODE_VERSION.join(".")}`)
		return { command: "node", version }
	}
	if (runtime === "qn") return { command: "qn", version }
	throw new Error("Remote worker environment has neither qn nor node")
}

const runtimeProbe = [
	"if command -v qn >/dev/null 2>&1; then",
	"  printf 'qn\\n'",
	"  qn --version 2>/dev/null || true",
	"elif command -v node >/dev/null 2>&1; then",
	"  printf 'node\\n'",
	"  node -v",
	"else",
	"  echo 'pinano worker requires qn or node' >&2",
	"  exit 127",
	"fi",
].join("\n")

export class LocalWorkerLauncher {
	/** @param {{ cwd?: string, workerPath?: string }} options */
	async start(options) {
		const child = spawnRpc(process.execPath, [options.workerPath ?? defaultWorkerPath], {
			...(options.cwd ? { cwd: options.cwd } : {}),
			env: { ...process.env, NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1" },
		})
		return { child, stop: () => child.kill("SIGTERM") }
	}
}

async function deploySourceSnapshot(snapshot, { exists, copy, install }) {
	const remoteSource = await exists(snapshot.hash)
	if (remoteSource) return remoteSource
	const tempName = `${snapshot.hash}.tmp.${randomUUID()}`
	try {
		await copy(snapshot.dir, tempName)
		return await install(snapshot.hash, tempName)
	} catch (err) {
		await install(undefined, tempName).catch(() => {})
		throw err
	}
}

export class SshWorkerLauncher {
	/** @param {{ target: string, remoteRoot?: string }} options */
	constructor(options) {
		this.target = options.target
		this.remoteRoot = options.remoteRoot
	}

	async sourceRoot() {
		return this.remoteRoot ?? (await run("ssh", [this.target, defaultRemoteSourceRootProbe])).stdout.trim()
	}

	remotePath(root, name) {
		return `${root.replace(/\/$/, "")}/${name}`
	}

	/** @param {{ cwd?: string, workerPath?: string }} options */
	async start(options) {
		const runtime = parseRuntime((await run("ssh", [this.target, runtimeProbe])).stdout)
		const sourceRoot = await this.sourceRoot()
		const snapshot = await createSourceSnapshot()
		try {
			const remoteSource = await deploySourceSnapshot(snapshot, {
				exists: async (hash) => {
					const path = this.remotePath(sourceRoot, hash)
					const check = `${sourceReadyCheck(path)} && printf %s ${shellQuote(path)}`
					const result = await run("ssh", [this.target, check]).catch(() => undefined)
					return result?.stdout || undefined
				},
				copy: async (sourceDir, tempName) => {
					const tempPath = this.remotePath(sourceRoot, tempName)
					const tar = spawn("tar", ["-C", sourceDir, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] })
					const unpack = `rm -rf ${shellQuote(tempPath)} && mkdir -p ${shellQuote(tempPath)} && tar -xf - -C ${shellQuote(tempPath)}`
					await run("ssh", [this.target, unpack], { input: tar.stdout })
				},
				install: async (hash, tempName) => {
					const tempPath = tempName ? this.remotePath(sourceRoot, tempName) : undefined
					if (!hash) {
						if (tempPath) await run("ssh", [this.target, `rm -rf ${shellQuote(tempPath)}`]).catch(() => {})
						return undefined
					}
					const finalPath = this.remotePath(sourceRoot, hash)
					if (!tempName) return finalPath
					const script = [
						`if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`mkdir -p ${shellQuote(sourceRoot)}`,
						writeSourceReady(tempPath),
						`if test -e ${shellQuote(finalPath)}; then if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi; rm -rf ${shellQuote(finalPath)}; fi`,
						`if mv ${shellQuote(tempPath)} ${shellQuote(finalPath)} 2>/dev/null; then printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`rm -rf ${shellQuote(tempPath)}`,
						`echo 'failed to install pinano source snapshot' >&2`,
						`exit 1`,
					].join("\n")
					return (await run("ssh", [this.target, script])).stdout
				},
			})
			const startDir = options.cwd ? shellQuote(options.cwd) : '"${HOME:-.}"'
			const command = `cd ${startDir} && exec ${runtime.command} ${shellQuote(`${remoteSource}/${sourceWorkerEntry(options.workerPath)}`)}`
			const child = spawnRpc("ssh", ["-T", this.target, command])
			child.once("exit", () => rm(snapshot.dir, { recursive: true, force: true }).catch(() => {}))
			return { child, stop: () => child.kill("SIGTERM") }
		} catch (err) {
			await rm(snapshot.dir, { recursive: true, force: true }).catch(() => {})
			throw err
		}
	}
}

export class DockerWorkerLauncher {
	/** @param {{ container: string, remoteRoot?: string }} options */
	constructor(options) {
		if (!options.container) throw new Error("worker=docker:<container> requires a running container name or id")
		this.container = options.container
		this.remoteRoot = options.remoteRoot
	}

	async sourceRoot() {
		return this.remoteRoot ?? (await run("docker", ["exec", this.container, "sh", "-lc", defaultRemoteSourceRootProbe])).stdout.trim()
	}

	remotePath(root, name) {
		return `${root.replace(/\/$/, "")}/${name}`
	}

	/** @param {{ cwd?: string, workerPath?: string }} options */
	async start(options) {
		const snapshot = await createSourceSnapshot()
		try {
			const runtime = parseRuntime((await run("docker", ["exec", this.container, "sh", "-lc", runtimeProbe])).stdout)
			const sourceRoot = await this.sourceRoot()
			const remoteSource = await deploySourceSnapshot(snapshot, {
				exists: async (hash) => {
					const path = this.remotePath(sourceRoot, hash)
					const result = await run("docker", ["exec", this.container, "sh", "-lc", `${sourceReadyCheck(path)} && printf %s ${shellQuote(path)}`]).catch(() => undefined)
					return result?.stdout || undefined
				},
				copy: async (sourceDir, tempName) => {
					const tempPath = this.remotePath(sourceRoot, tempName)
					await run("docker", ["exec", "-u", "0", this.container, "rm", "-rf", tempPath])
					await run("docker", ["exec", this.container, "mkdir", "-p", tempPath])
					await run("docker", ["cp", `${sourceDir}/.`, `${this.container}:${tempPath}/`])
					await run("docker", ["exec", "-u", "0", this.container, "sh", "-lc", `chmod -R a+rX ${shellQuote(tempPath)}`])
				},
				install: async (hash, tempName) => {
					const tempPath = tempName ? this.remotePath(sourceRoot, tempName) : undefined
					if (!hash) {
						if (tempPath) await run("docker", ["exec", "-u", "0", this.container, "rm", "-rf", tempPath]).catch(() => {})
						return undefined
					}
					const finalPath = this.remotePath(sourceRoot, hash)
					if (!tempName) return finalPath
					const script = [
						`if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`mkdir -p ${shellQuote(sourceRoot)}`,
						writeSourceReady(tempPath),
						`if test -e ${shellQuote(finalPath)}; then if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi; rm -rf ${shellQuote(finalPath)}; fi`,
						`if mv ${shellQuote(tempPath)} ${shellQuote(finalPath)} 2>/dev/null; then printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`if ${sourceReadyCheck(finalPath)}; then rm -rf ${shellQuote(tempPath)}; printf %s ${shellQuote(finalPath)}; exit 0; fi`,
						`rm -rf ${shellQuote(tempPath)}`,
						`echo 'failed to install pinano source snapshot' >&2`,
						`exit 1`,
					].join("\n")
					return (await run("docker", ["exec", "-u", "0", this.container, "sh", "-lc", script])).stdout
				},
			})
			const workdirArgs = options.cwd ? ["-w", options.cwd] : []
			const child = spawnRpc("docker", ["exec", "-i", ...workdirArgs, this.container, runtime.command, `${remoteSource}/${sourceWorkerEntry(options.workerPath)}`])
			child.once("exit", () => rm(snapshot.dir, { recursive: true, force: true }).catch(() => {}))
			return { child, stop: () => child.kill("SIGTERM") }
		} catch (err) {
			await rm(snapshot.dir, { recursive: true, force: true }).catch(() => {})
			throw err
		}
	}
}

/** @param {string | undefined} spec */
export function parseWorkerSpec(spec) {
	if (!spec || spec === "local") return { type: "local" }
	if (spec.startsWith("docker:")) {
		const container = spec.slice("docker:".length)
		if (!container || container.includes(":")) throw new Error(`Invalid docker worker spec: ${spec}`)
		return { type: "docker", container }
	}
	if (spec.startsWith("ssh:")) {
		const target = spec.slice("ssh:".length)
		if (!target || target.includes("/")) throw new Error(`Invalid ssh worker spec: ${spec}`)
		return { type: "ssh", target }
	}
	throw new Error(`Invalid worker spec: ${spec}. Use local, docker:<container>, or ssh:<target>.`)
}

/** @param {string | undefined} spec */
export function createWorkerLauncher(spec = configuredWorkerSpec()) {
	const parsed = parseWorkerSpec(spec)
	if (parsed.type === "local") return new LocalWorkerLauncher()
	if (parsed.type === "docker") return new DockerWorkerLauncher({ container: parsed.container })
	if (parsed.type === "ssh") return new SshWorkerLauncher({ target: parsed.target })
	throw new Error(`Unsupported worker launcher type: ${parsed.type}`)
}
