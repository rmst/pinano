import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { createSeatbeltSandboxArgs } from "./seatbelt-sandbox.js"
import { environmentHomePath, optionalPinanoHomePath, optionalRuntimeSourceReferencePath } from "./paths.js"
import { ensureSessionWorkspaceDir } from "./session-workspaces.js"
import { assertReadOnlyMountsNotCoveredByWritable, effectiveSandboxMounts, mountedPathForHostPath, pathIsWithin } from "./sandbox-paths.js"
import { configuredWorkerSpec } from "./service-config.js"
import { addImplicitPinanoStateMounts, normalizePinanoStateMount } from "./tool-state-mounts.js"
import { bundledBubblewrapDownloadInfo, verifiedCachedBundledBubblewrapPath } from "./bundled-bwrap.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")
const defaultWorkerPath = join(here, "tool-worker.js")
const defaultWorkerEntry = "src/app/tool-worker.js"
const MIN_NODE_VERSION = [22, 6, 0]
const defaultRemoteSourceRootProbe = "printf %s \"${HOME:-/tmp}/.pinano/workers/source\""
const defaultContainerSourceRootProbe = "printf %s \"${TMPDIR:-/tmp}/.pinano/workers/source\""
const defaultManagedContainerSourceRoot = "/tmp/.pinano/workers/source"
const sourceSnapshotVersion = "pinano-source-v2"
const defaultManagedContainerImage = "docker.io/library/node:22-alpine"
const managedContainerEngines = ["podman", "docker"]
const containerWorkerStopGraceMs = 1000
const macosHomebrewPathEntries = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
const bubblewrapProbeArgs = [
	"--die-with-parent",
	"--ro-bind", "/", "/",
	"--dev", "/dev",
	"--proc", "/proc",
	"--tmpfs", "/tmp",
	"--chdir", "/",
	"/bin/sh", "-c", "true",
]

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

function sessionWorkspaceEnv(sessionDir) {
	if (!sessionDir) return {}
	const tmp = join(sessionDir, "tmp")
	return {
		PINANO_SESSION_DIR: sessionDir,
		TMPDIR: tmp,
		TEMP: tmp,
		TMP: tmp,
		DARWIN_USER_TEMP_DIR: `${tmp}/`,
		PINANO_FALLBACK_TOOLS_TMPDIR: tmp,
	}
}

function prependPathEntries(path, entries) {
	const seen = new Set()
	return [
		...entries,
		...String(path || "").split(delimiter).filter(Boolean),
	].filter((entry) => {
		if (seen.has(entry)) return false
		seen.add(entry)
		return true
	}).join(delimiter)
}

function platformToolPathEnv(platform, baseEnv = process.env) {
	if (platform !== "darwin") return {}
	return { PATH: prependPathEntries(baseEnv.PATH, macosHomebrewPathEntries) }
}

function localWorkerEnv(options = {}) {
	return {
		...process.env,
		NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
		...platformToolPathEnv(options.platform),
		...(options.toolHome ? toolHomeEnv(options.toolHome) : {}),
		...sessionWorkspaceEnv(options.sessionDir),
	}
}

function toolHomeEnv(home) {
	const tmp = join(home, ".tmp")
	const cache = join(home, ".cache")
	return {
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: cache,
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		TMPDIR: tmp,
		TEMP: tmp,
		TMP: tmp,
		DARWIN_USER_CACHE_DIR: `${join(cache, "darwin")}/`,
		DARWIN_USER_TEMP_DIR: `${tmp}/`,
		GIT_OPTIONAL_LOCKS: "0",
		PINANO_FALLBACK_TOOLS_TMPDIR: tmp,
	}
}

function toolHomeDirs(home) {
	const env = toolHomeEnv(home)
	return [
		home,
		env.XDG_CONFIG_HOME,
		env.XDG_CACHE_HOME,
		env.XDG_DATA_HOME,
		env.XDG_STATE_HOME,
		env.TMPDIR,
		env.DARWIN_USER_CACHE_DIR,
	]
}

async function prepareToolHome(home) {
	const dirs = [...new Set([dirname(dirname(home)), dirname(home), ...toolHomeDirs(home)])]
	await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })))
	await Promise.all(dirs.map((dir) => chmod(dir, 0o700)))
}

async function prepareSessionDir(sessionDir) {
	if (sessionDir) await ensureSessionWorkspaceDir(sessionDir)
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
	/** @param {{ cwd?: string, sessionDir?: string, workerPath?: string }} options */
	async start(options) {
		await prepareSessionDir(options.sessionDir)
		const child = spawnRpc(process.execPath, [options.workerPath ?? defaultWorkerPath], {
			...(options.cwd ? { cwd: options.cwd } : {}),
			env: localWorkerEnv({ platform: process.platform, sessionDir: options.sessionDir }),
		})
		return { child, stop: () => child.kill("SIGTERM") }
	}
}

function tmpfsDestinationDirs(path, bases) {
	const base = bases.find((item) => path === item || path.startsWith(`${item}/`))
	if (!base || path === base) return []
	const dirs = []
	let current = path
	while (current !== base && current !== "/") {
		dirs.unshift(current)
		current = dirname(current)
	}
	return dirs
}

function hiddenHomeMounts() {
	const envHome = process.env.HOME && isAbsolute(process.env.HOME) ? resolve(process.env.HOME) : undefined
	const envHomeMount = envHome === "/root" ? envHome : envHome ? dirname(envHome) : undefined
	return [...new Set(["/home", "/Users", "/root", "/var/home", envHomeMount].filter((path) =>
		path && path !== "/" && existsSync(path) && !pathIsWithin("/tmp", path) && !pathIsWithin("/var/tmp", path)
	))]
}

function bubblewrapArgs({ workdir, roots, writableRoots = [], readableRoots = [], command }) {
	const tmpfsMounts = ["/tmp", "/var/tmp", ...hiddenHomeMounts()]
	const readRoots = [...new Set(readableRoots.map((root) => resolve(root)).filter((root) => root !== "/"))]
	const writeRoots = [...new Set([...roots, ...writableRoots].map((root) => resolve(root)))]
	const tmpfsDirs = [...new Set([...writeRoots, ...readRoots].flatMap((root) => tmpfsDestinationDirs(root, tmpfsMounts)))]
	return [
		"--die-with-parent",
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		...tmpfsMounts.flatMap((dir) => ["--tmpfs", dir]),
		...tmpfsDirs.flatMap((dir) => ["--dir", dir]),
		...readRoots.flatMap((root) => ["--ro-bind", root, root]),
		...writeRoots.flatMap((root) => ["--bind", root, root]),
		"--chdir", workdir,
		...command,
	]
}

function absolutePathVariants(path) {
	if (!path || !isAbsolute(path)) return []
	const resolved = resolve(path)
	const variants = [resolved]
	try {
		variants.push(resolve(realpathSync(resolved)))
	} catch {}
	return variants
}

function absolutePathVariantSet(paths) {
	return [...new Set(paths.flatMap((path) => absolutePathVariants(path)))]
}

function absolutePathParentVariants(path) {
	if (!path || !isAbsolute(path)) return []
	const resolved = resolve(path)
	const variants = [dirname(resolved)]
	try {
		variants.push(dirname(resolve(realpathSync(resolved))))
	} catch {}
	return absolutePathVariantSet(variants)
}

function runtimeRootVariants(path) {
	const parentDirs = absolutePathParentVariants(path)
	return absolutePathVariantSet([
		...parentDirs,
		...parentDirs.filter((parent) => basename(parent) === "bin").map(dirname),
	])
}

function macosSeatbeltTempRoots() {
	return absolutePathVariantSet([
		tmpdir(),
		process.env.TMPDIR,
		process.env.DARWIN_USER_CACHE_DIR,
		process.env.DARWIN_USER_TEMP_DIR,
	])
}

function macosSeatbeltReadableRoots(roots, workerPath) {
	return absolutePathVariantSet([...roots, repoRoot, dirname(resolve(workerPath)), dirname(resolve(process.execPath))])
}

function linuxBubblewrapReadableRoots(workerPath) {
	return absolutePathVariantSet([
		repoRoot,
		...absolutePathParentVariants(workerPath),
		...runtimeRootVariants(process.execPath),
	])
}

function nativeSandboxUnsupportedMessage(platform) {
	return `Native sandbox workers are not supported on ${platform}. Configure sandbox.type "container" or explicitly configure sandbox.type "none".`
}

/**
 * @param {{ platform?: string, sandboxExecCommand?: string, bwrapCommand?: string }} [options]
 * @returns {{ platform: string, command: string, args: string[], message: string, recovery: string } | undefined}
 */
export function nativeSandboxProbeSpec(options = {}) {
	const platform = options.platform ?? process.platform
	if (platform === "darwin") {
		return {
			platform,
			command: options.sandboxExecCommand ?? "/usr/bin/sandbox-exec",
			args: ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
			message: "Native macOS sandboxing requires a working sandbox-exec.",
			recovery: "Continue without native sandboxing or run Pinano outside any outer sandbox-exec wrapper.",
		}
	}
	if (platform === "linux") {
		return {
			platform,
			command: options.bwrapCommand ?? "bwrap",
			args: bubblewrapProbeArgs,
			message: "Native Linux sandboxing requires a working bubblewrap (bwrap).",
			recovery: "Install bubblewrap, enable unprivileged user namespaces if your distro requires it, or choose unsandboxed execution explicitly.",
		}
	}
	return undefined
}

export class NativeSandboxUnavailableError extends Error {
	/**
	 * @param {{ platform: string, command?: string, args?: string[], message: string, recovery?: string, detail?: string }} result
	 * @param {{ failClosedHint?: boolean, cause?: unknown }} [options]
	 */
	constructor(result, options = {}) {
		const detail = result.detail ? `\n${result.detail}` : ""
		const hint = options.failClosedHint === false
			? ""
			: " Pinano will not fall back to unsandboxed execution automatically. To run tools unsandboxed anyway, set \"sandbox\": { \"type\": \"none\" } for this environment in environments.json."
		super(`${result.message}${result.recovery ? ` ${result.recovery}` : ""}${hint}${detail}`, { cause: options.cause })
		this.name = "NativeSandboxUnavailableError"
		this.platform = result.platform
		this.command = result.command
		this.args = result.args
		this.detail = result.detail
	}
}

function nativeSandboxProbeDetail(command, err) {
	const detail = err?.message ?? String(err)
	return detail.includes(command) ? detail : `${command}: ${detail}`
}

function nativeSandboxProbeFailed(spec, err) {
	return {
		ok: false,
		supported: true,
		...spec,
		error: err,
		detail: nativeSandboxProbeDetail(spec.command, err),
	}
}

async function runNativeSandboxProbe(spec) {
	try {
		await run(spec.command, spec.args)
		return { ok: true, supported: true, ...spec }
	} catch (err) {
		return nativeSandboxProbeFailed(spec, err)
	}
}

function commandMissingError(err) {
	return err?.code === "ENOENT" || err?.code === "ENOTDIR"
}

function joinedProbeDetails(...results) {
	return results.map((result) => result?.detail).filter(Boolean).join("\n")
}

/** @param {{ platform: string, arch?: string, cacheRoot?: string, asset?: any, bwrapCommand?: string }} options */
async function probeLinuxNativeSandbox(options) {
	const systemSpec = nativeSandboxProbeSpec({ ...options, bwrapCommand: options.bwrapCommand })
	const systemResult = await runNativeSandboxProbe(systemSpec)
	if (systemResult.ok || options.bwrapCommand || !commandMissingError(systemResult.error)) return systemResult
	const bundledPath = await verifiedCachedBundledBubblewrapPath(options)
	if (bundledPath) {
		const bundledSpec = { ...systemSpec, command: bundledPath, bundledBubblewrap: { path: bundledPath, cached: true } }
		const bundledResult = await runNativeSandboxProbe(bundledSpec)
		if (bundledResult.ok) return { ...bundledResult, systemProbe: systemResult }
		return {
			...bundledResult,
			systemProbe: systemResult,
			detail: joinedProbeDetails(systemResult, bundledResult),
		}
	}
	const downloadInfo = bundledBubblewrapDownloadInfo(options)
	return {
		...systemResult,
		downloadableBundledBubblewrap: downloadInfo,
		recovery: downloadInfo
			? "Install bubblewrap, run Pinano interactively and press D to download Pinano's bundled bubblewrap, enable unprivileged user namespaces if your distro requires it, or choose unsandboxed execution explicitly."
			: systemResult.recovery,
	}
}

/** @param {{ platform?: string, sandboxExecCommand?: string, bwrapCommand?: string }} [options] */
export async function probeNativeSandbox(options = {}) {
	const platform = options.platform ?? process.platform
	if (platform === "linux") return await probeLinuxNativeSandbox({ ...options, platform })
	const spec = nativeSandboxProbeSpec({ ...options, platform })
	if (!spec) {
		return {
			ok: false,
			supported: false,
			platform,
			message: nativeSandboxUnsupportedMessage(platform),
			recovery: "Configure sandbox.type \"container\" or explicitly configure sandbox.type \"none\".",
		}
	}
	return await runNativeSandboxProbe(spec)
}

/** @param {{ platform?: string, sandboxExecCommand?: string, bwrapCommand?: string }} [options] */
async function assertNativeSandboxAvailable(options = {}) {
	const result = await probeNativeSandbox(options)
	if (!result.ok) throw new NativeSandboxUnavailableError(result, { cause: result.error })
	return result
}

export class NativeSandboxWorkerLauncher {
	/** @param {{ platform?: string, mountPaths?: any[], paths?: any[], useSessionWd?: boolean, pinanoStateMount?: unknown, sandboxExecCommand?: string, bwrapCommand?: string }} [options] */
	constructor(options = {}) {
		this.platform = options.platform ?? process.platform
		this.mountPaths = options.mountPaths ?? options.paths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.pinanoStateMount = normalizePinanoStateMount(options.pinanoStateMount) ?? false
		this.sandboxExecCommand = options.sandboxExecCommand ?? "/usr/bin/sandbox-exec"
		this.bwrapCommand = options.bwrapCommand
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const sessionWd = options.sessionWd ?? options.cwd
		const workdir = this.useSessionWd ? sessionWd : undefined
		await prepareSessionDir(options.sessionDir)
		const mounts = await addToolStateMounts(effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Native sandbox worker"), {
			sessionDir: options.sessionDir,
			pinanoStateMount: this.pinanoStateMount,
		})
		assertReadOnlyMountsNotCoveredByWritable(mounts, "Native sandbox worker")
		const readableRoots = mounts.map((mount) => mount.from)
		const writableRoots = mounts.filter((mount) => !mount.readOnly).map((mount) => mount.from)
		if (workdir) await assertDirectory(workdir, "Native sandbox working directory")
		for (const root of readableRoots) await assertDirectory(root, "Native sandbox mount path")
		const workerPath = options.workerPath ?? defaultWorkerPath
		const toolHome = environmentHomePath(options.environmentId)
		const workerSessionDir = mountedSessionDir(options.sessionDir, mounts)
		const launchCwd = workdir ?? toolHome
		let command
		let args
		if (this.platform === "darwin") {
			const availability = await assertNativeSandboxAvailable({ platform: this.platform, sandboxExecCommand: this.sandboxExecCommand })
			await prepareToolHome(toolHome)
			command = availability.command
			args = createSeatbeltSandboxArgs({
				command: [process.execPath, workerPath],
				readableRoots: macosSeatbeltReadableRoots(readableRoots, workerPath),
				writableRoots: absolutePathVariantSet([...writableRoots, toolHome, ...macosSeatbeltTempRoots()]),
			})
		} else if (this.platform === "linux") {
			const availability = await assertNativeSandboxAvailable({ platform: this.platform, bwrapCommand: this.bwrapCommand })
			await prepareToolHome(toolHome)
			command = availability.command
			args = bubblewrapArgs({
				workdir: launchCwd,
				roots: writableRoots,
				writableRoots: [toolHome],
				readableRoots: [...linuxBubblewrapReadableRoots(workerPath), ...readableRoots.filter((root) => !writableRoots.includes(root))],
				command: [process.execPath, workerPath],
			})
		} else {
			throw new Error(nativeSandboxUnsupportedMessage(this.platform))
		}
		const child = spawnRpc(command, args, {
			cwd: launchCwd,
			env: localWorkerEnv({ platform: this.platform, toolHome, sessionDir: workerSessionDir }),
		})
		return {
			child,
			stop: () => child.kill("SIGTERM"),
		}
	}
}

function processUserArg() {
	if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return []
	return ["--user", `${process.getuid()}:${process.getgid()}`]
}

function containerEnvArgs(env = {}) {
	return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`])
}

function volumeArg(mount) {
	return `${mount.from}:${mount.to}:${mount.readOnly ? "ro" : "rw"}`
}

function mountLabel(mounts) {
	return mounts.map((mount) => `${mount.from}->${mount.to}:${mount.readOnly ? "ro" : "rw"}`).join("|")
}

async function assertDirectory(path, context) {
	let info
	try {
		info = await stat(path)
	} catch (err) {
		if (err?.code === "ENOENT") throw new Error(`${context} does not exist: ${path}`)
		throw err
	}
	if (!info.isDirectory()) throw new Error(`${context} must be a directory: ${path}`)
}

async function assertPathExists(path, context) {
	try {
		await stat(path)
	} catch (err) {
		if (err?.code === "ENOENT") throw new Error(`${context} does not exist: ${path}`)
		throw err
	}
}

async function existingRuntimeSourceReferencePath() {
	const path = optionalRuntimeSourceReferencePath()
	if (!path) return undefined
	try {
		const info = await stat(path)
		return info.isDirectory() ? path : undefined
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

async function addToolStateMounts(mounts, options = {}) {
	return addImplicitPinanoStateMounts(mounts, {
		sessionDir: options.sessionDir,
		pinanoStateDirPath: optionalPinanoHomePath(),
		pinanoStateMount: options.pinanoStateMount,
		runtimeSourceReferencePath: await existingRuntimeSourceReferencePath(),
	})
}

function mountedSessionDir(sessionDir, mounts, options = {}) {
	if (!sessionDir) return undefined
	const mounted = mountedPathForHostPath(mounts, sessionDir)
	if (mounted && !mounted.readOnly) return mounted.path
	return options.fallback === false ? undefined : sessionDir
}

async function detectManagedContainerEngine(preferred) {
	const candidates = preferred ? [preferred] : managedContainerEngines
	const failures = []
	for (const engine of candidates) {
		try {
			await run(engine, ["info"])
			return engine
		} catch (err) {
			failures.push(`${engine}: ${err?.message ?? err}`)
		}
	}
	const detail = failures.length > 0 ? `\n${failures.join("\n")}` : ""
	throw new Error(`No usable container engine found for Pinano's managed tool sandbox. Install and start Podman or Docker, or explicitly configure sandbox.type "none".${detail}`)
}

async function startManagedContainer({ engine, image, workdir, mounts, env = {}, network, extraArgs = [] }) {
	if (workdir && !isAbsolute(workdir)) throw new Error(`Managed container worker requires an absolute workdir, got: ${workdir}`)
	if (workdir) await assertDirectory(workdir, "Managed container working directory")
	for (const mount of mounts) await assertPathExists(mount.from, "Managed container mount source")
	const name = `pinano-worker-${randomUUID()}`
	await run(engine, [
		"run",
		"-d",
		"--name", name,
		"--label", "com.pinano.managed=true",
		"--label", `com.pinano.mounts=${mountLabel(mounts)}`,
		...(workdir ? ["--workdir", workdir] : []),
		...processUserArg(),
		...containerEnvArgs(env),
		...(network ? ["--network", network] : []),
		...mounts.flatMap((mount) => ["--volume", volumeArg(mount)]),
		...extraArgs,
		image,
		"sh",
		"-lc",
		"trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
	])
	return name
}

function removeContainer(engine, container) {
	return (spawnSync(engine, ["rm", "-f", container], { stdio: "ignore" }).status ?? 1) === 0
}

function workerPidFile(sourceRoot, runId) {
	return `${sourceRoot.replace(/\/$/, "")}/.pinano-worker-${runId}.pid`
}

function containerWorkerSignalScript({ pidFile, runId, signal }) {
	return [
		`pid_file=${shellQuote(pidFile)}`,
		`run_id=${shellQuote(runId)}`,
		`if ! test -f "$pid_file"; then exit 0; fi`,
		`pid=$(cat "$pid_file" 2>/dev/null || true)`,
		`case "$pid" in ''|*[!0-9]*) exit 0;; esac`,
		`cmd=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || ps -p "$pid" -o args= 2>/dev/null || true)`,
		`case "$cmd" in *"$run_id"*) kill -${signal} "$pid" 2>/dev/null || true;; *) exit 0;; esac`,
	].join("\n")
}

function signalContainerWorker(engine, container, pidFile, runId, signal) {
	spawnSync(engine, ["exec", "-u", "0", container, "sh", "-lc", containerWorkerSignalScript({ pidFile, runId, signal })], { stdio: "ignore", timeout: 1000 })
}

function stopContainerExecWorker({ engine, container, child, pidFile, runId }) {
	let stopped = false
	return () => {
		if (stopped) return
		stopped = true
		signalContainerWorker(engine, container, pidFile, runId, "TERM")
		try {
			if (child.stdin && !child.stdin.destroyed) child.stdin.end()
		} catch {}
		child.kill("SIGTERM")
		const killTimer = setTimeout(() => {
			signalContainerWorker(engine, container, pidFile, runId, "KILL")
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
		}, containerWorkerStopGraceMs)
		killTimer.unref?.()
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

class ContainerExecWorkerLauncher {
	/** @param {{ engine: string, container: string, remoteRoot?: string, mountPaths?: any[], paths?: any[], useSessionWd?: boolean, env?: Record<string, string> }} options */
	constructor(options) {
		if (!options.container) throw new Error("Container worker requires a running container name or id")
		this.engine = options.engine
		this.container = options.container
		this.remoteRoot = options.remoteRoot
		this.mountPaths = options.mountPaths ?? options.paths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.env = options.env ?? {}
	}

	async sourceRoot() {
		return this.remoteRoot ?? (await run(this.engine, ["exec", this.container, "sh", "-lc", defaultContainerSourceRootProbe])).stdout.trim()
	}

	remotePath(root, name) {
		return `${root.replace(/\/$/, "")}/${name}`
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const snapshot = await createSourceSnapshot()
		try {
			await prepareSessionDir(options.sessionDir)
			const sessionWd = options.sessionWd ?? options.cwd
			const mounts = effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Container exec worker")
			const workerSessionDir = mountedSessionDir(options.sessionDir, mounts, { fallback: false })
			const env = { ...this.env, ...sessionWorkspaceEnv(workerSessionDir) }
			const runtime = parseRuntime((await run(this.engine, ["exec", this.container, "sh", "-lc", runtimeProbe])).stdout)
			const sourceRoot = await this.sourceRoot()
			const remoteSource = await deploySourceSnapshot(snapshot, {
				exists: async (hash) => {
					const path = this.remotePath(sourceRoot, hash)
					const result = await run(this.engine, ["exec", this.container, "sh", "-lc", `${sourceReadyCheck(path)} && printf %s ${shellQuote(path)}`]).catch(() => undefined)
					return result?.stdout || undefined
				},
				copy: async (sourceDir, tempName) => {
					const tempPath = this.remotePath(sourceRoot, tempName)
					await run(this.engine, ["exec", "-u", "0", this.container, "rm", "-rf", tempPath])
					await run(this.engine, ["exec", this.container, "mkdir", "-p", tempPath])
					await run(this.engine, ["cp", `${sourceDir}/.`, `${this.container}:${tempPath}/`])
					await run(this.engine, ["exec", "-u", "0", this.container, "sh", "-lc", `chmod -R a+rX ${shellQuote(tempPath)}`])
				},
				install: async (hash, tempName) => {
					const tempPath = tempName ? this.remotePath(sourceRoot, tempName) : undefined
					if (!hash) {
						if (tempPath) await run(this.engine, ["exec", "-u", "0", this.container, "rm", "-rf", tempPath]).catch(() => {})
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
					return (await run(this.engine, ["exec", "-u", "0", this.container, "sh", "-lc", script])).stdout
				},
			})
			const workdir = this.useSessionWd ? sessionWd : undefined
			const workdirArgs = workdir ? ["-w", workdir] : []
			const runId = `pinano-worker-${randomUUID()}`
			const pidFile = workerPidFile(sourceRoot, runId)
			const child = spawnRpc(this.engine, [
				"exec",
				"-i",
				...workdirArgs,
				...containerEnvArgs(env),
				"--env", `PINANO_WORKER_PID_FILE=${pidFile}`,
				this.container,
				runtime.command,
				`${remoteSource}/${sourceWorkerEntry(options.workerPath)}`,
				`--pinano-worker-run-id=${runId}`,
			])
			child.once("exit", () => rm(snapshot.dir, { recursive: true, force: true }).catch(() => {}))
			return {
				child,
				stop: stopContainerExecWorker({ engine: this.engine, container: this.container, child, pidFile, runId }),
			}
		} catch (err) {
			await rm(snapshot.dir, { recursive: true, force: true }).catch(() => {})
			throw err
		}
	}
}

export class DockerWorkerLauncher extends ContainerExecWorkerLauncher {
	/** @param {{ container: string, remoteRoot?: string, mountPaths?: any[], paths?: any[], useSessionWd?: boolean, env?: Record<string, string> }} options */
	constructor(options) {
		super({ ...options, engine: "docker" })
	}
}

export class ManagedContainerWorkerLauncher {
	/** @param {{ engine?: string, image?: string, remoteRoot?: string, mountPaths?: any[], paths?: any[], useSessionWd?: boolean, pinanoStateMount?: unknown, env?: Record<string, string>, network?: string, extraArgs?: string[] }} [options] */
	constructor(options = {}) {
		this.engine = options.engine
		this.image = options.image ?? defaultManagedContainerImage
		this.remoteRoot = options.remoteRoot
		this.mountPaths = options.mountPaths ?? options.paths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.pinanoStateMount = normalizePinanoStateMount(options.pinanoStateMount) ?? false
		this.env = options.env ?? {}
		this.network = options.network
		this.extraArgs = options.extraArgs ?? []
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const sessionWd = options.sessionWd ?? options.cwd
		const workdir = this.useSessionWd ? sessionWd : undefined
		await prepareSessionDir(options.sessionDir)
		const mounts = await addToolStateMounts(effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Managed container worker"), {
			sessionDir: options.sessionDir,
			pinanoStateMount: this.pinanoStateMount,
		})
		const workerSessionDir = mountedSessionDir(options.sessionDir, mounts)
		const env = { ...this.env, ...sessionWorkspaceEnv(workerSessionDir) }
		const engine = await detectManagedContainerEngine(this.engine)
		const container = await startManagedContainer({
			engine,
			image: this.image,
			workdir,
			mounts,
			env,
			network: this.network,
			extraArgs: this.extraArgs,
		})
		let cleaned = false
		const cleanup = () => {
			if (cleaned) return
			cleaned = removeContainer(engine, container)
		}
		try {
			const handle = await new ContainerExecWorkerLauncher({
				engine,
				container,
				remoteRoot: this.remoteRoot ?? defaultManagedContainerSourceRoot,
				mountPaths: this.mountPaths,
				useSessionWd: this.useSessionWd,
				env,
			}).start({ ...options, cwd: workdir, sessionWd })
			handle.child.once("exit", cleanup)
			return {
				child: handle.child,
				stop: () => {
					handle.stop?.()
					cleanup()
				},
			}
		} catch (err) {
			cleanup()
			throw err
		}
	}
}

/** @param {string | undefined} spec */
export function parseWorkerSpec(spec) {
	if (!spec || spec === "container") return { type: "container" }
	if (spec === "local") return { type: "local" }
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
	throw new Error(`Invalid worker spec: ${spec}. Use container, local, docker:<container>, or ssh:<target>.`)
}

/** @param {string | { target: any, sandbox: any } | undefined} spec @param {{ image?: string, mountPaths?: any[], paths?: any[], useSessionWd?: boolean, pinanoStateMount?: unknown, env?: Record<string, string>, network?: string, extraArgs?: string[] }} [options] */
export function createWorkerLauncher(spec = configuredWorkerSpec(), options = {}) {
	if (spec && typeof spec === "object") return createEnvironmentWorkerLauncher(spec)
	const parsed = parseWorkerSpec(spec)
	if (parsed.type === "container") return new ManagedContainerWorkerLauncher({
		image: options.image,
		mountPaths: options.mountPaths,
		paths: options.paths,
		useSessionWd: options.useSessionWd,
		pinanoStateMount: options.pinanoStateMount,
		env: options.env,
		network: options.network,
		extraArgs: options.extraArgs,
	})
	if (parsed.type === "local") return new LocalWorkerLauncher()
	if (parsed.type === "docker") return new DockerWorkerLauncher({
		container: parsed.container,
		mountPaths: options.mountPaths,
		paths: options.paths,
		useSessionWd: options.useSessionWd,
		env: options.env,
	})
	if (parsed.type === "ssh") return new SshWorkerLauncher({ target: parsed.target })
	throw new Error(`Unsupported worker launcher type: ${parsed.type}`)
}

/** @param {{ target: any, sandbox: any }} environment */
export function createEnvironmentWorkerLauncher(environment) {
	const target = environment.target ?? { type: "local" }
	const sandbox = environment.sandbox ?? { type: "none" }
	if (target.type === "ssh") {
		if (sandbox.type === "none") return new SshWorkerLauncher({ target: target.host })
		throw new Error(`Sandbox type "${sandbox.type}" for ssh targets is not implemented yet`)
	}
	if (target.type !== "local") throw new Error(`Unsupported environment target type: ${target.type}`)
	if (sandbox.type === "none") return new LocalWorkerLauncher()
	if (sandbox.type === "native") return new NativeSandboxWorkerLauncher({ mountPaths: sandbox.mountPaths, paths: sandbox.paths, useSessionWd: sandbox.useSessionWd, pinanoStateMount: environment.pinanoStateMount })
	if (sandbox.type === "container") {
		if (sandbox.container) {
			return new ContainerExecWorkerLauncher({
				engine: sandbox.engine ?? "docker",
				container: sandbox.container,
				mountPaths: sandbox.mountPaths,
				paths: sandbox.paths,
				useSessionWd: sandbox.useSessionWd,
				env: sandbox.env,
			})
		}
		return new ManagedContainerWorkerLauncher({
			engine: sandbox.engine,
			image: sandbox.image,
			mountPaths: sandbox.mountPaths,
			paths: sandbox.paths,
			useSessionWd: sandbox.useSessionWd,
			pinanoStateMount: environment.pinanoStateMount,
			env: sandbox.env,
			network: sandbox.network,
			extraArgs: sandbox.extraArgs,
		})
	}
	throw new Error(`Unsupported sandbox type: ${sandbox.type}`)
}
