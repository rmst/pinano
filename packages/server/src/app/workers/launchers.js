import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { SESSION_ID_ENV } from "../../../../protocol/src/internal-api-env.js"
import { applyProductEnvAliases } from "../../../../protocol/src/product.js"
import { createSeatbeltSandboxArgs } from "../sandbox/seatbelt.js"
import { environmentContainerHomePath, environmentHomePath, managedContainerHomePath, optionalProductHomePath, optionalRuntimeSourceReferencePath } from "../paths.js"
import { ensureSessionWorkspaceDir } from "../session/workspaces.js"
import { addWritableMountUnlessCovered, assertReadOnlyMountsNotCoveredByWritable, effectiveSandboxMounts, minimizeCoveredMounts, mountedPathForHostPath, pathIsWithin } from "../sandbox/paths.js"
import { bubblewrapIsolationArgs, bubblewrapSecurityProbeArgs } from "../sandbox/bwrap/isolation.js"
import { addImplicitStateMounts, addManagedContainerHomeMount, normalizeStateMount } from "./tool/state-mounts.js"
import { bestEffortAutoInstallBundledBubblewrap, bundledBubblewrapBuildFromSourceEnabled, bundledBubblewrapDownloadInfo, verifiedCachedBundledBubblewrapPath } from "../sandbox/bwrap/bundled.js"
import { preparePreviewLogPath } from "../preview/log-files.js"
import { previewLogPath } from "../preview/manifest.js"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..", "..", "..", "..")
const defaultWorkerPath = join(here, "tool", "worker.js")
export const terminalWorkerPath = join(here, "terminal.js")
const defaultWorkerEntry = "packages/server/src/app/workers/tool/worker.js"
const MIN_NODE_VERSION = [22, 6, 0]
const defaultRemoteSourceRootProbe = "printf %s \"${HOME:-/tmp}/.cerex/workers/source\""
const defaultContainerSourceRootProbe = "printf %s \"${TMPDIR:-/tmp}/.cerex/workers/source\""
const defaultManagedContainerSourceRoot = "/tmp/.cerex/workers/source"
const sourceSnapshotVersion = "source-v4"
const sourcePackageRoots = ["packages/protocol", "packages/sdk", "packages/server"]
const defaultManagedContainerImage = "docker.io/library/node:22-alpine"
const managedContainerEngines = ["podman", "docker"]
const containerWorkerStopGraceMs = 1000
const managedContainerRemovalRetryInitialMs = 250
const managedContainerRemovalRetryMaxMs = 30000
const managedContainerRemovalTimeoutMs = 5000
const managedPreviewContainerBindHost = "0.0.0.0"
const managedPreviewRouteHost = "127.0.0.1"
const managedContainerDiagnosticMaxChars = 4000
const macosHomebrewPathEntries = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
const bubblewrapProbeArgs = bubblewrapSecurityProbeArgs()

/** @param {string} s */
export function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

/** Run a command and preserve its exit status. Intended for bounded one-shot sandbox jobs. */
function runCaptured(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] })
		const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
		let stdout = Buffer.alloc(0)
		let stderr = Buffer.alloc(0)
		let outputBytes = 0
		let finished = false
		let timeoutTimer
		let killTimer
		let stopError
		let abort = () => {}
		const finish = (err, result) => {
			if (finished) return
			finished = true
			clearTimeout(timeoutTimer)
			clearTimeout(killTimer)
			options.signal?.removeEventListener("abort", abort)
			if (err) reject(err)
			else resolve(result)
		}
		const stop = (err, signal = "SIGKILL") => {
			if (finished || stopError) return
			stopError = err
			child.kill(signal)
			if (signal !== "SIGKILL") killTimer = setTimeout(() => child.kill("SIGKILL"), 1000)
		}
		const append = (current, chunk) => {
			const value = Buffer.from(chunk)
			outputBytes += value.length
			if (outputBytes > maxOutputBytes) throw new Error(`Sandboxed command output exceeded ${maxOutputBytes} bytes`)
			return Buffer.concat([current, value])
		}
		child.stdout.on("data", (chunk) => {
			try { stdout = append(stdout, chunk) } catch (err) { stop(err) }
		})
		child.stderr.on("data", (chunk) => {
			try { stderr = append(stderr, chunk) } catch (err) { stop(err) }
		})
		child.on("error", (err) => finish(err))
		child.on("close", (exitCode, signal) => {
			if (stopError) finish(stopError)
			else finish(undefined, { stdout, stderr, exitCode: exitCode ?? (signal ? 128 : 1), signal })
		})
		abort = () => stop(new Error("Sandboxed command was cancelled"), "SIGTERM")
		if (options.signal?.aborted) abort()
		else options.signal?.addEventListener("abort", abort, { once: true })
		if (Number.isFinite(options.timeoutMs)) timeoutTimer = setTimeout(() => stop(new Error("Sandboxed command timed out")), options.timeoutMs)
		if (options.input !== undefined && !stopError) {
			child.stdin.on("error", (err) => stop(err))
			child.stdin.end(options.input)
		}
	})
}

function sourceReadyCheck(path) {
	return `test -f ${shellQuote(`${path}/.source-ready`)}`
}

function writeSourceReady(path) {
	const marker = shellQuote(`${path}/.source-ready`)
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

function processFailureStatus({ exitCode, signal } = {}) {
	if (signal) return `signal ${signal}`
	if (exitCode !== undefined && exitCode !== null) return `code ${exitCode}`
	return "failed"
}

function processFailureMessage(command, failure) {
	const detail = (failure.stderr || "").trim()
	return `${command} failed (${processFailureStatus(failure)})${detail ? `: ${detail}` : ""}`
}

class ProcessFailureError extends Error {
	/** @param {string} command @param {{ exitCode?: number | null, signal?: string | null, stdout?: string, stderr?: string }} failure */
	constructor(command, failure = {}) {
		super(processFailureMessage(command, failure))
		this.name = "ProcessFailureError"
		this.command = command
		this.exitCode = failure.exitCode
		this.signal = failure.signal
		this.stdout = failure.stdout ?? ""
		this.stderr = failure.stderr ?? ""
	}
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
			else reject(new ProcessFailureError(command, { exitCode: code, signal, stdout, stderr }))
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

function sessionWorkspaceEnv(sessionDir, sessionId = undefined) {
	const session = sessionId ? { [SESSION_ID_ENV]: sessionId } : {}
	if (!sessionDir) return applyProductEnvAliases(session)
	return applyProductEnvAliases({
		...session,
		CEREX_SESSION_DIR: sessionDir,
	})
}

function executionTempEnv(tmp) {
	return {
		TMPDIR: tmp,
		TEMP: tmp,
		TMP: tmp,
		DARWIN_USER_TEMP_DIR: `${tmp}/`,
		CEREX_FALLBACK_TOOLS_TMPDIR: tmp,
	}
}

function containerExecutionTempEnv(...envs) {
	const tmp = envs.map((env) => env?.TMPDIR).find((value) => typeof value === "string" && value) ?? "/tmp"
	return executionTempEnv(tmp)
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
	return applyProductEnvAliases({
		...process.env,
		NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
		...platformToolPathEnv(options.platform),
		...(options.toolHome ? toolHomeEnv(options.toolHome) : {}),
		...(options.home ? { HOME: options.home } : {}),
		...(options.executionTemp ? executionTempEnv(options.executionTemp) : {}),
		...sessionWorkspaceEnv(options.sessionDir, options.sessionId),
	})
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
		...executionTempEnv(tmp),
		DARWIN_USER_CACHE_DIR: `${join(cache, "darwin")}/`,
		GIT_OPTIONAL_LOCKS: "0",
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

async function prepareExecutionTemp(path) {
	const dirs = [dirname(path), path]
	await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })))
	await Promise.all(dirs.map((dir) => chmod(dir, 0o700)))
}

function serviceHomePath(env = process.env) {
	const home = typeof env.HOME === "string" ? env.HOME.trim() : ""
	if (!home || !isAbsolute(home)) throw new Error("Native sandbox isolatedHome false requires the Cerex service HOME to be an absolute path")
	return resolve(home)
}

function assertWritableSandboxHome(home, mounts) {
	const mounted = mountedPathForHostPath(mounts, home, { requireOneToOneMapping: true })
	if (mounted && !mounted.readOnly) return
	throw new Error(`Native sandbox isolatedHome false requires HOME to be inside a writable sandbox mount: ${home}`)
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
			const containsSource = sourcePackageRoots.some((root) => root === relative || root.startsWith(`${relative}/`) || relative.startsWith(`${root}/`))
			if (!containsSource) continue
			files.push(...await sourceEntries(path, relative))
		} else if (entry.isFile()) {
			if (relative === "package.json" || sourcePackageRoots.some((root) => relative.startsWith(`${root}/`))) files.push({ path, relative })
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
	const dir = await mkdtemp(join(tmpdir(), `worker-source-${hash.slice(0, 12)}-`))
	for (const file of await sourceEntries()) {
		const target = join(dir, file.relative)
		await mkdir(dirname(target), { recursive: true })
		await cp(file.path, target, { recursive: true, force: true })
	}
	await normalizeSnapshotPermissions(dir, { root: true })
	return { dir, hash }
}

async function disposeSourceSnapshot(snapshot) {
	try {
		if (typeof snapshot.dispose === "function") await snapshot.dispose()
		else await rm(snapshot.dir, { recursive: true, force: true })
	} catch {}
}

/** @param {unknown} value */
function requiredRuntimeName(value) {
	return value === "qn" ? "qn" : undefined
}

/** @param {string} output @param {{ requiredRuntime?: unknown }} [options] */
function parseRuntime(output, options = {}) {
	const [runtime, version = ""] = output.trim().split(/\r?\n/)
	const requiredRuntime = requiredRuntimeName(options.requiredRuntime)
	if (requiredRuntime && runtime !== requiredRuntime) throw new Error(`Remote worker environment does not have required runtime: ${requiredRuntime}`)
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
	"  echo 'Cerex worker requires qn or node' >&2",
	"  exit 127",
	"fi",
].join("\n")

function runtimeProbeFor(runtime) {
	if (requiredRuntimeName(runtime) === "qn") return [
		"if command -v qn >/dev/null 2>&1; then",
		"  printf 'qn\\n'",
		"  qn --version 2>/dev/null || true",
		"else",
		"  echo 'Cerex worker requires qn' >&2",
		"  exit 127",
		"fi",
	].join("\n")
	return runtimeProbe
}

function localRuntimeCommand(runtime, env) {
	if (requiredRuntimeName(runtime) !== "qn") return process.execPath
	const result = spawnSync("sh", ["-c", "command -v qn"], { env, encoding: "utf8" })
	const command = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : ""
	if (command) return command
	throw new Error("Local worker environment does not have required runtime: qn")
}

export class LocalWorkerLauncher {
	/** @param {{ cwd?: string, sessionDir?: string, sessionId?: string, environmentId?: string, workerPath?: string, runtime?: "qn" }} options */
	async start(options) {
		await prepareSessionDir(options.sessionDir)
		const executionTemp = join(environmentHomePath(options.environmentId), ".tmp")
		await prepareExecutionTemp(executionTemp)
		const env = localWorkerEnv({ platform: process.platform, executionTemp, sessionDir: options.sessionDir, sessionId: options.sessionId })
		const child = spawnRpc(localRuntimeCommand(options.runtime, env), [options.workerPath ?? defaultWorkerPath], {
			...(options.cwd ? { cwd: options.cwd } : {}),
			env,
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
		...bubblewrapIsolationArgs(),
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		...tmpfsMounts.flatMap((dir) => ["--tmpfs", dir]),
		...tmpfsDirs.flatMap((dir) => ["--dir", dir]),
		...readRoots.flatMap((root) => ["--ro-bind", root, root]),
		...writeRoots.flatMap((root) => ["--bind", root, root]),
		"--chdir", workdir,
		"--",
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

function macosSeatbeltReadableRoots(roots, workerPath, runtimeCommand = process.execPath) {
	return absolutePathVariantSet([...roots, repoRoot, dirname(resolve(workerPath)), ...runtimeRootVariants(runtimeCommand)])
}

function linuxBubblewrapReadableRoots(workerPath, runtimeCommand = process.execPath) {
	return absolutePathVariantSet([
		repoRoot,
		...absolutePathParentVariants(workerPath),
		...runtimeRootVariants(runtimeCommand),
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
			recovery: "Continue without native sandboxing or run Cerex outside any outer sandbox-exec wrapper.",
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
			: " Cerex will not fall back to unsandboxed execution automatically. To run tools unsandboxed anyway, set \"sandbox\": { \"type\": \"none\" } for this environment in environments.json."
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
	const buildFromSource = await bundledBubblewrapBuildFromSourceEnabled(options)
	const downloadInfo = buildFromSource ? undefined : bundledBubblewrapDownloadInfo(options)
	return {
		...systemResult,
		downloadableBundledBubblewrap: downloadInfo,
		recovery: downloadInfo
			? "Install bubblewrap, check network access for Cerex's bundled bubblewrap download, enable unprivileged user namespaces if your distro requires it, or choose unsandboxed execution explicitly."
			: buildFromSource
				? "Install bubblewrap, check that source build tools and network access for pinned upstream repositories are available, enable unprivileged user namespaces if your distro requires it, or choose unsandboxed execution explicitly."
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
	/** @param {{ platform?: string, mountPaths?: any[], useSessionWd?: boolean, isolatedHome?: boolean, stateMount?: unknown, sandboxExecCommand?: string, bwrapCommand?: string }} [options] */
	constructor(options = {}) {
		this.platform = options.platform ?? process.platform
		this.mountPaths = options.mountPaths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.isolatedHome = options.isolatedHome !== false
		this.stateMount = normalizeStateMount(options.stateMount) ?? false
		this.sandboxExecCommand = options.sandboxExecCommand ?? "/usr/bin/sandbox-exec"
		this.bwrapCommand = options.bwrapCommand
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, sessionId?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const sessionWd = options.sessionWd ?? options.cwd
		const workdir = this.useSessionWd ? sessionWd : undefined
		await prepareSessionDir(options.sessionDir)
		const mounts = await addToolStateMounts(effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Native sandbox worker"), {
			sessionDir: options.sessionDir,
			stateMount: this.stateMount,
		})
		assertReadOnlyMountsNotCoveredByWritable(mounts, "Native sandbox worker")
		const readableRoots = mounts.map((mount) => mount.from)
		const writableRoots = mounts.filter((mount) => !mount.readOnly).map((mount) => mount.from)
		if (workdir) await assertDirectory(workdir, "Native sandbox working directory")
		for (const root of readableRoots) await assertDirectory(root, "Native sandbox mount path")
		const workerPath = options.workerPath ?? defaultWorkerPath
		const home = this.isolatedHome ? environmentHomePath(options.environmentId) : serviceHomePath()
		if (!this.isolatedHome) assertWritableSandboxHome(home, mounts)
		const executionTemp = join(environmentHomePath(options.environmentId), ".tmp")
		const workerSessionDir = mountedSessionDir(options.sessionDir, mounts)
		const launchCwd = workdir ?? home
		const env = localWorkerEnv({ platform: this.platform, ...(this.isolatedHome ? { toolHome: home } : { home }), executionTemp, sessionDir: workerSessionDir, sessionId: options.sessionId })
		const runtimeCommand = localRuntimeCommand(options.runtime, env)
		let command
		let args
		if (this.platform === "darwin") {
			const availability = await assertNativeSandboxAvailable({ platform: this.platform, sandboxExecCommand: this.sandboxExecCommand })
			if (this.isolatedHome) await prepareToolHome(home)
			else {
				await assertDirectory(home, "Native sandbox HOME")
				await prepareExecutionTemp(executionTemp)
			}
			command = availability.command
			args = createSeatbeltSandboxArgs({
				command: [runtimeCommand, workerPath],
				readableRoots: macosSeatbeltReadableRoots(readableRoots, workerPath, runtimeCommand),
				writableRoots: absolutePathVariantSet([...writableRoots, this.isolatedHome ? home : executionTemp, ...macosSeatbeltTempRoots()]),
			})
		} else if (this.platform === "linux") {
			if (!this.bwrapCommand) await bestEffortAutoInstallBundledBubblewrap({ platform: this.platform })
			const availability = await assertNativeSandboxAvailable({ platform: this.platform, bwrapCommand: this.bwrapCommand })
			if (this.isolatedHome) await prepareToolHome(home)
			else {
				await assertDirectory(home, "Native sandbox HOME")
				await prepareExecutionTemp(executionTemp)
			}
			command = availability.command
			args = bubblewrapArgs({
				workdir: launchCwd,
				roots: writableRoots,
				writableRoots: [this.isolatedHome ? home : executionTemp],
				readableRoots: [...linuxBubblewrapReadableRoots(workerPath, runtimeCommand), ...readableRoots.filter((root) => !writableRoots.includes(root))],
				command: [runtimeCommand, workerPath],
			})
		} else {
			throw new Error(nativeSandboxUnsupportedMessage(this.platform))
		}
		const child = spawnRpc(command, args, {
			cwd: launchCwd,
			env,
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

function managedContainerUserArg(user) {
	return user === undefined ? processUserArg() : ["--user", user]
}

function containerEnvArgs(env = {}) {
	return Object.entries(applyProductEnvAliases({ ...env })).flatMap(([name, value]) => ["--env", `${name}=${value}`])
}

function volumeArg(mount) {
	return `${mount.from}:${mount.to}:${mount.readOnly ? "ro" : "rw"}`
}

function containerMountsForRun(mounts) {
	return [...mounts].sort((a, b) =>
		a.to.length - b.to.length
		|| a.to.localeCompare(b.to)
		|| a.from.length - b.from.length
		|| a.from.localeCompare(b.from)
		|| Number(a.readOnly) - Number(b.readOnly)
	)
}

function mountLabel(mounts) {
	return mounts.map((mount) => `${mount.from}->${mount.to}:${mount.readOnly ? "ro" : "rw"}`).join("|")
}

function replacementValues(values, replacement) {
	return values
		.filter((value) => value !== undefined && value !== null && String(value) !== "")
		.map((value) => [String(value), replacement])
}

function envRedactions(env = {}) {
	const entries = Object.entries(env)
	const assignmentRedactions = entries.map(([name, value]) => [`${name}=${value}`, "[redacted env]"])
	const valueRedactions = entries
		.map(([, value]) => String(value ?? ""))
		.filter((value) => value.length >= 4)
		.map((value) => [value, "[redacted]"])
	return [...assignmentRedactions, ...valueRedactions]
}

function extraArgRedactions(args = []) {
	return args.flatMap((arg, index) => {
		if (!arg) return []
		if (String(arg).includes("=")) return [[arg, "[redacted arg]"]]
		const previous = args[index - 1]
		if (previous?.startsWith?.("-") && !arg.startsWith("-")) return [[arg, "[redacted arg]"]]
		return []
	})
}

function commandRedactions(command = []) {
	return command.flatMap((arg) => {
		const value = String(arg ?? "")
		if (!value || value === "sh" || value === "-lc") return []
		return [[value, "[redacted command]"]]
	})
}

// Container engines sometimes echo the full argv on failure. These diagnostics can become tool results, so redact launch-only values before surfacing them to the model or user.
function managedContainerOutputRedactions({ workdir, mounts, env, labels, extraArgs, command }) {
	const defaultCommand = ["sh", "-lc", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]
	const containerCommand = command ?? defaultCommand
	return [
		...replacementValues([workdir], "[redacted path]"),
		...replacementValues([`app.cerex.mounts=${mountLabel(mounts)}`], "[redacted mount label]"),
		...replacementValues(labels, "[redacted label]"),
		...replacementValues(mounts.map(volumeArg), "[redacted volume]"),
		...envRedactions(env),
		...extraArgRedactions(extraArgs),
		...commandRedactions(containerCommand),
	].sort((a, b) => b[0].length - a[0].length)
}

function redactDiagnosticText(text, redactions) {
	let redacted = String(text ?? "")
	for (const [value, replacement] of redactions) redacted = redacted.split(value).join(replacement)
	return redacted
}

function truncateDiagnosticText(text, maxChars = managedContainerDiagnosticMaxChars) {
	if (text.length <= maxChars) return text
	return `${text.slice(0, maxChars).trimEnd()}\n[truncated ${text.length - maxChars} chars]`
}

function sanitizedDiagnosticText(text, redactions) {
	return truncateDiagnosticText(redactDiagnosticText(text, redactions).trim())
}

function managedContainerFailureOutput(error, redactions) {
	const fallback = error instanceof ProcessFailureError ? "" : error?.message
	const output = (error?.stderr || error?.stdout || fallback || "").trim()
	if (!output) return ""
	return sanitizedDiagnosticText(output, redactions)
}

function engineLabel(engine) {
	return basename(String(engine || "container engine"))
}

function sanitizedManagedContainerFailureCause(error, redactions) {
	if (error instanceof ProcessFailureError) {
		return new ProcessFailureError(error.command, {
			exitCode: error.exitCode,
			signal: error.signal,
			stdout: sanitizedDiagnosticText(error.stdout, redactions),
			stderr: sanitizedDiagnosticText(error.stderr, redactions),
		})
	}
	if (!error) return undefined
	const sanitized = new Error(sanitizedDiagnosticText(error?.message ?? String(error), redactions))
	sanitized.name = error?.name ?? "Error"
	return sanitized
}

function managedContainerStartupError({ description, engine, image, error, redactions, footer }) {
	const output = managedContainerFailureOutput(error, redactions)
	const lines = [
		`${description} failed to start.`,
		`Engine: ${engineLabel(engine)}`,
		`Image: ${image}`,
		`Exit: ${processFailureStatus(error)}`,
		output ? `Container engine output:\n${output}` : "",
		footer,
	].filter(Boolean)
	const wrapped = new Error(lines.join("\n"), { cause: sanitizedManagedContainerFailureCause(error, redactions) })
	wrapped.name = "ManagedContainerStartupError"
	return wrapped
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
	return addImplicitStateMounts(mounts, {
		sessionDir: options.sessionDir,
		stateDirPath: optionalProductHomePath(),
		stateMount: options.stateMount,
		runtimeSourceReferencePath: await existingRuntimeSourceReferencePath(),
	})
}

async function addManagedContainerIsolatedHome(mounts, options = {}) {
	if (options.isolatedHome === false) return { mounts, env: {} }
	const hostHome = environmentContainerHomePath(options.environmentId)
	await prepareToolHome(hostHome)
	return {
		mounts: addManagedContainerHomeMount(mounts, hostHome, managedContainerHomePath),
		env: toolHomeEnv(managedContainerHomePath),
		hostHome,
		home: managedContainerHomePath,
	}
}

function mountedSessionDir(sessionDir, mounts, options = {}) {
	if (!sessionDir) return undefined
	const mounted = mountedPathForHostPath(mounts, sessionDir)
	if (mounted && !mounted.readOnly) return mounted.path
	return options.fallback === false ? undefined : sessionDir
}

function writableMountedPath(mounts, hostPath, context) {
	if (!hostPath) return undefined
	const mounted = mountedPathForHostPath(mounts, hostPath)
	if (!mounted || mounted.readOnly) throw new Error(`${context} is not covered by a writable sandbox mount: ${hostPath}`)
	return mounted.path
}

function managedContainerHomeProbeScript(env) {
	const dirs = [
		env.HOME,
		env.XDG_CONFIG_HOME,
		env.XDG_CACHE_HOME,
		env.XDG_DATA_HOME,
		env.XDG_STATE_HOME,
		env.TMPDIR,
	].filter(Boolean)
	const marker = `${env.HOME}/.home-write-test`
	return [
		...dirs.map((dir) => `mkdir -p ${shellQuote(dir)}`),
		`: > ${shellQuote(marker)}`,
		`rm -f ${shellQuote(marker)}`,
	].join("\n")
}

async function assertManagedContainerHomeWritable(engine, container, env) {
	if (!env?.HOME) return
	try {
		await run(engine, ["exec", ...containerEnvArgs(env), container, "sh", "-lc", managedContainerHomeProbeScript(env)])
	} catch (err) {
		throw new Error(`Managed container isolated HOME is not writable at ${env.HOME}. Check sandbox.user or set isolatedHome to false for this environment.`, { cause: err })
	}
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
	throw new Error(`No usable container engine found for Cerex's managed tool sandbox. Install and start Podman or Docker, or explicitly configure sandbox.type "none".${detail}`)
}

async function startManagedContainer({ engine, image, user, workdir, mounts, env = {}, network, extraArgs = [], namePrefix = "cerex-worker", labels = [], publish = [], command = undefined, description = "Managed container", failureFooter = undefined }) {
	if (workdir && !isAbsolute(workdir)) throw new Error(`Managed container requires an absolute workdir, got: ${workdir}`)
	if (workdir) await assertDirectory(workdir, "Managed container working directory")
	for (const mount of mounts) await assertPathExists(mount.from, "Managed container mount source")
	const runMounts = containerMountsForRun(mounts)
	const name = `${namePrefix}-${randomUUID()}`
	const args = [
		"run",
		"-d",
		"--rm",
		"--name", name,
		"--label", "app.cerex.managed=true",
		"--label", `app.cerex.mounts=${mountLabel(runMounts)}`,
		...labels.flatMap((label) => ["--label", label]),
		...(workdir ? ["--workdir", workdir] : []),
		...managedContainerUserArg(user),
		...containerEnvArgs(env),
		...(network ? ["--network", network] : []),
		...publish.flatMap((value) => ["--publish", value]),
		...runMounts.flatMap((mount) => ["--volume", volumeArg(mount)]),
		...extraArgs,
		image,
		...(command ?? [
			"sh",
			"-lc",
			"trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
		]),
	]
	try {
		await run(engine, args)
	} catch (error) {
		throw managedContainerStartupError({
			description,
			engine,
			image,
			error,
			redactions: managedContainerOutputRedactions({ workdir, mounts: runMounts, env, labels, extraArgs, command }),
			footer: failureFooter,
		})
	}
	return name
}

function nativeCommandEnvironment(extra, scratch) {
	const inherited = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]
		.map((name) => [name, process.env[name]])
		.filter(([, value]) => typeof value === "string"))
	return { ...inherited, HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), TMP: join(scratch, "tmp"), TEMP: join(scratch, "tmp"), ...extra }
}

/**
 * Run a short-lived shell script in an isolated sibling of a tool environment. The command gets the same project mounts, a fresh HOME, bounded output, and optional stdin; callers must never place secrets in `env` or command arguments.
 * @param {{ sandbox?: any, cwd: string, mounts: any[], script: string, args?: string[], env?: Record<string, string>, input?: string | Buffer, signal?: AbortSignal, timeoutMs?: number }} options
 */
export async function runSandboxedScript(options) {
	const sandbox = options.sandbox ?? { type: "none" }
	if (sandbox.type === "container" && sandbox.container) throw new Error("Secure proxy commands are unavailable with a fixed shared container; configure a managed container image instead")
	const hostScratch = await mkdtemp(join(tmpdir(), "cerex-sandbox-command-"))
	const sandboxScratch = sandbox.type === "container" ? `/opt/${basename(hostScratch)}` : hostScratch
	const sandboxRuntime = sandbox.type === "container" ? `/tmp/${basename(hostScratch)}` : hostScratch
	const hostScript = join(hostScratch, "command.sh")
	const sandboxScript = join(sandboxScratch, "command.sh")
	try {
		await chmod(hostScratch, 0o755)
		await Promise.all([
			mkdir(join(hostScratch, "home"), { recursive: true, mode: 0o700 }),
			mkdir(join(hostScratch, "tmp"), { recursive: true, mode: 0o700 }),
		])
		await writeFile(hostScript, options.script, { mode: 0o755 })
		await chmod(hostScript, 0o755)
		if (sandbox.type === "container") {
			const engine = await detectManagedContainerEngine(sandbox.engine)
			const container = `cerex-sandbox-${randomUUID()}`
			const mounts = containerMountsForRun(minimizeCoveredMounts([
				...options.mounts,
				{ from: hostScratch, to: sandboxScratch, readOnly: true },
			]))
			const env = {
				HOME: join(sandboxRuntime, "home"),
				TMPDIR: join(sandboxRuntime, "tmp"),
				TMP: join(sandboxRuntime, "tmp"),
				TEMP: join(sandboxRuntime, "tmp"),
				...(options.env ?? {}),
			}
			const args = [
				"run", "--rm", "--interactive",
				"--name", container,
				"--label", "app.cerex.managed=true",
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", "256",
				"--read-only",
				"--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
				"--workdir", options.cwd,
				...managedContainerUserArg(sandbox.user),
				...containerEnvArgs(env),
				...(sandbox.network ? ["--network", sandbox.network] : []),
				...mounts.flatMap((mount) => ["--volume", volumeArg(mount)]),
				sandbox.image ?? defaultManagedContainerImage,
				"sh", sandboxScript, ...(options.args ?? []),
			]
			try {
				return await runCaptured(engine, args, {
					env: process.env,
					input: options.input,
					signal: options.signal,
					timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
				})
			} finally {
				const removed = await removeContainer(engine, container)
				if (!removed) {
					managedContainerCleanup(engine, container)()
					throw new Error(`Failed to clean up sandboxed command container: ${container}`)
				}
			}
		}

		const readableRoots = options.mounts.map((mount) => mount.from)
		const writableRoots = options.mounts.filter((mount) => !mount.readOnly).map((mount) => mount.from)
		const env = nativeCommandEnvironment(options.env ?? {}, hostScratch)
		const command = "/bin/sh"
		let sandboxCommand
		let sandboxArgs
		if (process.platform === "darwin") {
			const availability = await assertNativeSandboxAvailable({ platform: process.platform })
			sandboxCommand = availability.command
			sandboxArgs = createSeatbeltSandboxArgs({
				command: [command, hostScript, ...(options.args ?? [])],
				readableRoots: macosSeatbeltReadableRoots([...readableRoots, hostScratch], hostScript, command),
				writableRoots: absolutePathVariantSet([...writableRoots, hostScratch]),
			})
		} else if (process.platform === "linux") {
			await bestEffortAutoInstallBundledBubblewrap({ platform: process.platform })
			const availability = await assertNativeSandboxAvailable({ platform: process.platform })
			sandboxCommand = availability.command
			sandboxArgs = bubblewrapArgs({
				workdir: options.cwd,
				roots: writableRoots,
				writableRoots: [hostScratch],
				readableRoots: [...readableRoots.filter((root) => !writableRoots.includes(root)), ...linuxBubblewrapReadableRoots(hostScript, command)],
				command: [command, hostScript, ...(options.args ?? [])],
			})
		} else {
			throw new Error(nativeSandboxUnsupportedMessage(process.platform))
		}
		return await runCaptured(sandboxCommand, sandboxArgs, {
			cwd: options.cwd,
			env,
			input: options.input,
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
		})
	} finally {
		await rm(hostScratch, { recursive: true, force: true })
	}
}

function containerRemovalAlreadyComplete(output) {
	return /\bno such container\b|\bno container with (?:name|id)\b|\bcontainer\b.*\b(?:does not exist|not found)\b|\b(?:does not exist|not found)\b.*\bcontainer\b/i.test(output)
}

function removeContainer(engine, container, options = {}) {
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : managedContainerRemovalTimeoutMs
	return new Promise((resolve) => {
		let output = ""
		let settled = false
		let child
		let timer
		const finish = (ok) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(ok)
		}
		const appendOutput = (chunk) => {
			output = `${output}${chunk}`
			if (output.length > 8000) output = output.slice(-8000)
		}
		try {
			child = spawn(engine, ["rm", "-f", container], { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
		} catch (err) {
			appendOutput(err?.message ?? String(err))
			finish(containerRemovalAlreadyComplete(output))
			return
		}
		timer = setTimeout(() => {
			try { child.kill("SIGKILL") } catch {}
		}, timeoutMs)
		timer.unref?.()
		child.stdout?.on("data", appendOutput)
		child.stderr?.on("data", appendOutput)
		child.on("error", (err) => {
			appendOutput(err?.message ?? String(err))
			finish(containerRemovalAlreadyComplete(output))
		})
		child.on("exit", (code) => {
			finish(code === 0 || containerRemovalAlreadyComplete(output))
		})
	})
}

function managedContainerCleanup(engine, container, options = {}) {
	let cleaned = false
	let running = false
	let retryTimer
	let retryDelayMs = Number.isFinite(options.initialRetryMs) ? Math.max(1, options.initialRetryMs) : managedContainerRemovalRetryInitialMs
	const maxRetryMs = Number.isFinite(options.maxRetryMs) ? Math.max(1, options.maxRetryMs) : managedContainerRemovalRetryMaxMs
	const scheduleRetry = () => {
		const delayMs = retryDelayMs
		retryDelayMs = Math.min(retryDelayMs * 2, maxRetryMs)
		retryTimer = setTimeout(() => {
			retryTimer = undefined
			attempt()
		}, delayMs)
		retryTimer.unref?.()
	}
	const attempt = () => {
		if (cleaned || running || retryTimer) return
		running = true
		removeContainer(engine, container, options)
			.then((ok) => {
				running = false
				if (ok) {
					cleaned = true
					return
				}
				scheduleRetry()
			})
			.catch(() => {
				running = false
				scheduleRetry()
			})
	}
	return attempt
}

function workerPidFile(sourceRoot, runId) {
	return `${sourceRoot.replace(/\/$/, "")}/.worker-${runId}.pid`
}

function managedPreviewBindHost(network) {
	return network === "host" ? managedPreviewRouteHost : managedPreviewContainerBindHost
}

function managedPreviewPublishBindings(network, routeHost, routePort, bindPort) {
	if (network === "host") return []
	if (network === "none") throw new Error("Managed container previews are unavailable when sandbox.network is \"none\"")
	return [`${routeHost}:${routePort}:${bindPort}`]
}

function managedPreviewEnv(options) {
	return applyProductEnvAliases({
		...containerExecutionTempEnv(options.homeEnv, options.previewEnv, options.sandboxEnv),
		...(options.sandboxEnv ?? {}),
		...(options.previewEnv ?? {}),
		...(options.homeEnv ?? {}),
		...sessionWorkspaceEnv(options.sessionDir, options.sessionId),
		CEREX_PREVIEW: "1",
		CEREX_PREVIEW_ID: options.id,
		CEREX_PREVIEW_NAME: options.name,
		CEREX_PREVIEW_HOST: options.bindHost,
		CEREX_PREVIEW_PORT: String(options.bindPort),
		CEREX_PREVIEW_PUBLIC_URL: options.publicUrl,
		...(options.logPath ? { CEREX_PREVIEW_LOG_PATH: options.logPath } : {}),
	})
}

function managedPreviewCommand(command, options = {}) {
	if (typeof command !== "string" || !command) throw new Error("Managed container preview command must be a non-empty string")
	const shellCommand = `/bin/sh -c ${shellQuote(command)}`
	const marker = shellQuote(`[cerex] --- ${options.appendLog ? "restarting" : "starting"} ${new Date().toISOString()} ---`)
	const redirect = options.appendLog ? ">>" : ">"
	return [
		`if [ -n "\${CEREX_PREVIEW_LOG_PATH:-}" ] && mkdir -p "$(dirname "$CEREX_PREVIEW_LOG_PATH")"; then`,
		`printf '%s\\n' ${marker} ${redirect} "$CEREX_PREVIEW_LOG_PATH"`,
		`printf '%s\\n' '[cerex] preview process starting' >> "$CEREX_PREVIEW_LOG_PATH"`,
		`exec ${shellCommand} >> "$CEREX_PREVIEW_LOG_PATH" 2>&1`,
		"fi",
		`exec ${shellCommand}`,
	].join("\n")
}

function managedPreviewWorkdir(baseCwd, cwd = ".") {
	if (typeof baseCwd !== "string" || !baseCwd) throw new Error("Managed container preview base working directory is required")
	if (typeof cwd !== "string" || !cwd || isAbsolute(cwd)) throw new Error("Managed container preview working directory must be relative")
	const root = resolve(baseCwd)
	const workdir = resolve(root, cwd)
	if (!pathIsWithin(root, workdir)) throw new Error("Managed container preview working directory must stay within its base directory")
	return workdir
}

function managedPreviewLabels(options) {
	return [
		"app.cerex.preview=true",
		`app.cerex.preview.id=${options.id}`,
		...(options.sessionId ? [`app.cerex.session=${options.sessionId}`] : []),
		...(options.environmentId ? [`app.cerex.environment=${options.environmentId}`] : []),
	]
}

async function managedContainerRunning(engine, container, env = process.env) {
	try {
		const result = await run(engine, ["inspect", "--format", "{{.State.Running}}", container], { env })
		return result.stdout.trim() === "true"
	} catch {
		return false
	}
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
	/** @param {{ target: string, remoteRoot?: string, createSourceSnapshot?: typeof createSourceSnapshot }} options */
	constructor(options) {
		this.target = options.target
		this.remoteRoot = options.remoteRoot
		this.createSourceSnapshot = options.createSourceSnapshot ?? createSourceSnapshot
	}

	async sourceRoot() {
		return this.remoteRoot ?? (await run("ssh", [this.target, defaultRemoteSourceRootProbe])).stdout.trim()
	}

	remotePath(root, name) {
		return `${root.replace(/\/$/, "")}/${name}`
	}

	/** @param {{ cwd?: string, workerPath?: string }} options */
	async start(options) {
		const runtime = parseRuntime((await run("ssh", [this.target, runtimeProbeFor(options.runtime)])).stdout, { requiredRuntime: options.runtime })
		const sourceRoot = await this.sourceRoot()
		const snapshot = await this.createSourceSnapshot()
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
						`echo 'failed to install worker source snapshot' >&2`,
						`exit 1`,
					].join("\n")
					return (await run("ssh", [this.target, script])).stdout
				},
			})
			const startDir = options.cwd ? shellQuote(options.cwd) : '"${HOME:-.}"'
			const command = `cd ${startDir} && exec ${runtime.command} ${shellQuote(`${remoteSource}/${sourceWorkerEntry(options.workerPath)}`)}`
			const child = spawnRpc("ssh", ["-T", this.target, command])
			child.once("exit", () => disposeSourceSnapshot(snapshot).catch(() => {}))
			return { child, stop: () => child.kill("SIGTERM") }
		} catch (err) {
			await disposeSourceSnapshot(snapshot)
			throw err
		}
	}
}

class ContainerExecWorkerLauncher {
	/** @param {{ engine: string, container: string, remoteRoot?: string, mountPaths?: any[], useSessionWd?: boolean, env?: Record<string, string>, createSourceSnapshot?: typeof createSourceSnapshot }} options */
	constructor(options) {
		if (!options.container) throw new Error("Container worker requires a running container name or id")
		this.engine = options.engine
		this.container = options.container
		this.remoteRoot = options.remoteRoot
		this.mountPaths = options.mountPaths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.env = options.env ?? {}
		this.createSourceSnapshot = options.createSourceSnapshot ?? createSourceSnapshot
	}

	async sourceRoot() {
		return this.remoteRoot ?? (await run(this.engine, ["exec", this.container, "sh", "-lc", defaultContainerSourceRootProbe])).stdout.trim()
	}

	remotePath(root, name) {
		return `${root.replace(/\/$/, "")}/${name}`
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, sessionId?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const snapshot = await this.createSourceSnapshot()
		try {
			await prepareSessionDir(options.sessionDir)
			const sessionWd = options.sessionWd ?? options.cwd
			const mounts = effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Container exec worker")
			const workerSessionDir = mountedSessionDir(options.sessionDir, mounts, { fallback: false })
			const env = applyProductEnvAliases({ ...containerExecutionTempEnv(this.env), ...this.env, ...sessionWorkspaceEnv(workerSessionDir, options.sessionId) })
			const runtime = parseRuntime((await run(this.engine, ["exec", this.container, "sh", "-lc", runtimeProbeFor(options.runtime)])).stdout, { requiredRuntime: options.runtime })
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
						`echo 'failed to install worker source snapshot' >&2`,
						`exit 1`,
					].join("\n")
					return (await run(this.engine, ["exec", "-u", "0", this.container, "sh", "-lc", script])).stdout
				},
			})
			const workdir = this.useSessionWd ? sessionWd : undefined
			const workdirArgs = workdir ? ["-w", workdir] : []
			const runId = `worker-${randomUUID()}`
			const pidFile = workerPidFile(sourceRoot, runId)
			const child = spawnRpc(this.engine, [
				"exec",
				"-i",
				...workdirArgs,
				...containerEnvArgs(env),
				"--env", `CEREX_WORKER_PID_FILE=${pidFile}`,
				this.container,
				runtime.command,
				`${remoteSource}/${sourceWorkerEntry(options.workerPath)}`,
				`--worker-run-id=${runId}`,
			])
			child.once("exit", () => disposeSourceSnapshot(snapshot).catch(() => {}))
			return {
				child,
				stop: stopContainerExecWorker({ engine: this.engine, container: this.container, child, pidFile, runId }),
			}
		} catch (err) {
			await disposeSourceSnapshot(snapshot)
			throw err
		}
	}
}

export class DockerWorkerLauncher extends ContainerExecWorkerLauncher {
	/** @param {{ container: string, remoteRoot?: string, mountPaths?: any[], useSessionWd?: boolean, env?: Record<string, string> }} options */
	constructor(options) {
		super({ ...options, engine: "docker" })
	}
}

export class ManagedContainerPreviewProcess {
	/**
	 * @param {object} options
	 * @param {string} options.id
	 * @param {string} options.name
	 * @param {string} options.command
	 * @param {string | undefined} options.baseCwd
	 * @param {string | undefined} options.cwd
	 * @param {string} options.host
	 * @param {number} options.port
	 * @param {string} options.publicUrl
	 * @param {string | undefined} options.logPath
	 * @param {string | undefined} options.sessionWd
	 * @param {string | undefined} options.sessionDir
	 * @param {string | undefined} options.sessionId
	 * @param {string | undefined} options.environmentId
	 * @param {any} options.sandbox
	 * @param {unknown} options.stateMount
	 * @param {Record<string, string> | undefined} options.env
	 */
	constructor(options) {
		const sandbox = options.sandbox ?? {}
		this.id = options.id
		this.name = options.name
		this.command = options.command
		this.cwd = managedPreviewWorkdir(options.baseCwd, options.cwd)
		this.routeHost = options.host || managedPreviewRouteHost
		this.routePort = options.port
		this.bindHost = managedPreviewBindHost(sandbox.network)
		this.bindPort = options.port
		this.publicUrl = options.publicUrl
		this.appendLog = options.appendLog === true
		this.sessionWd = options.sessionWd ?? options.baseCwd
		this.sessionDir = options.sessionDir
		this.sessionId = options.sessionId
		this.logPath = options.logPath ?? previewLogPath(this.sessionDir, this.name)
		this.environmentId = options.environmentId
		this.sandbox = sandbox
		this.env = options.env
		this.isolatedHome = sandbox.isolatedHome !== false
		this.stateMount = options.stateMount
		this.startedAt = Date.now()
		this.lastActivityAt = this.startedAt
		this.running = false
		this.container = undefined
		this.engine = undefined
		this.engineEnv = undefined
		this.cleanup = undefined
	}

	async start() {
		const useSessionWd = this.sandbox.useSessionWd ?? true
		const workdir = this.cwd ?? (useSessionWd ? this.sessionWd : undefined)
		await prepareSessionDir(this.sessionDir)
		let mounts = await addToolStateMounts(effectiveSandboxMounts({
			sessionWd: this.sessionWd,
			useSessionWd,
			mountPaths: this.sandbox.mountPaths ?? [],
		}, "Managed container preview"), {
			sessionDir: this.sessionDir,
			stateMount: this.stateMount,
		})
		if (this.logPath) {
			await preparePreviewLogPath(this.logPath)
			mounts = addWritableMountUnlessCovered(mounts, dirname(this.logPath))
		}
		const home = await addManagedContainerIsolatedHome(mounts, {
			environmentId: this.environmentId,
			isolatedHome: this.isolatedHome,
		})
		const previewSessionDir = mountedSessionDir(this.sessionDir, home.mounts)
		const containerLogPath = writableMountedPath(home.mounts, this.logPath, "Managed container preview log path")
		const env = managedPreviewEnv({
			id: this.id,
			name: this.name,
			bindHost: this.bindHost,
			bindPort: this.bindPort,
			publicUrl: this.publicUrl,
			sessionDir: previewSessionDir,
			sessionId: this.sessionId,
			logPath: containerLogPath,
			sandboxEnv: this.sandbox.env,
			previewEnv: this.env,
			homeEnv: home.env,
		})
		const engine = await detectManagedContainerEngine(this.sandbox.engine)
		const engineEnv = { ...process.env }
		const container = await startManagedContainer({
			engine,
			image: this.sandbox.image ?? defaultManagedContainerImage,
			user: this.sandbox.user,
			workdir,
			mounts: home.mounts,
			env,
			network: this.sandbox.network,
			extraArgs: this.sandbox.extraArgs,
			namePrefix: "cerex-preview",
			labels: managedPreviewLabels(this),
			publish: managedPreviewPublishBindings(this.sandbox.network, this.routeHost, this.routePort, this.bindPort),
			command: ["/bin/sh", "-c", managedPreviewCommand(this.command, { appendLog: this.appendLog })],
			description: "Managed container preview",
			failureFooter: "The preview command did not run.",
		})
		this.engine = engine
		this.engineEnv = engineEnv
		this.container = container
		this.cleanup = managedContainerCleanup(engine, container, { env: engineEnv })
		this.running = true
		return this.inspect()
	}

	async touch() {
		this.lastActivityAt = Date.now()
		if (this.engine && this.container && !await managedContainerRunning(this.engine, this.container, this.engineEnv)) this.running = false
		return { ok: true, preview: this.inspect() }
	}

	stop() {
		const cleanup = this.cleanup
		this.cleanup = undefined
		this.running = false
		this.lastActivityAt = Date.now()
		cleanup?.()
		return { ok: Boolean(cleanup) }
	}

	inspect(now = Date.now()) {
		return {
			id: this.id,
			name: this.name,
			cwd: this.cwd,
			host: this.routeHost,
			port: this.routePort,
			bindHost: this.bindHost,
			bindPort: this.bindPort,
			publicUrl: this.publicUrl,
			running: this.running,
			container: this.container,
			engine: this.engine,
			ageMs: now - this.startedAt,
			idleMs: now - this.lastActivityAt,
			logPath: this.logPath,
		}
	}
}

export class ManagedContainerWorkerLauncher {
	/** @param {{ engine?: string, image?: string, user?: string, remoteRoot?: string, mountPaths?: any[], useSessionWd?: boolean, isolatedHome?: boolean, stateMount?: unknown, env?: Record<string, string>, network?: string, extraArgs?: string[], createSourceSnapshot?: typeof createSourceSnapshot }} [options] */
	constructor(options = {}) {
		this.engine = options.engine
		this.image = options.image ?? defaultManagedContainerImage
		this.user = options.user
		this.remoteRoot = options.remoteRoot
		this.mountPaths = options.mountPaths ?? []
		this.useSessionWd = options.useSessionWd ?? true
		this.isolatedHome = options.isolatedHome !== false
		this.stateMount = normalizeStateMount(options.stateMount) ?? false
		this.env = options.env ?? {}
		this.network = options.network
		this.extraArgs = options.extraArgs ?? []
		this.createSourceSnapshot = options.createSourceSnapshot ?? createSourceSnapshot
	}

	/** @param {{ cwd?: string, sessionWd?: string, sessionDir?: string, sessionId?: string, environmentId?: string, workerPath?: string }} options */
	async start(options) {
		const sessionWd = options.sessionWd ?? options.cwd
		const workdir = this.useSessionWd ? sessionWd : undefined
		await prepareSessionDir(options.sessionDir)
		const mounts = await addToolStateMounts(effectiveSandboxMounts({ sessionWd, useSessionWd: this.useSessionWd, mountPaths: this.mountPaths }, "Managed container worker"), {
			sessionDir: options.sessionDir,
			stateMount: this.stateMount,
		})
		const home = await addManagedContainerIsolatedHome(mounts, {
			environmentId: options.environmentId,
			isolatedHome: this.isolatedHome,
		})
		const workerSessionDir = mountedSessionDir(options.sessionDir, home.mounts)
		const env = applyProductEnvAliases({ ...containerExecutionTempEnv(home.env, this.env), ...this.env, ...home.env, ...sessionWorkspaceEnv(workerSessionDir, options.sessionId) })
		const engine = await detectManagedContainerEngine(this.engine)
		const engineEnv = { ...process.env }
		const container = await startManagedContainer({
			engine,
			image: this.image,
			user: this.user,
			workdir,
			mounts: home.mounts,
			env,
			network: this.network,
			extraArgs: this.extraArgs,
			description: "Managed container tool environment",
			failureFooter: "No tool command ran.",
		})
		const cleanup = managedContainerCleanup(engine, container, { env: engineEnv })
		try {
			await assertManagedContainerHomeWritable(engine, container, home.env)
			const handle = await new ContainerExecWorkerLauncher({
				engine,
				container,
				remoteRoot: this.remoteRoot ?? defaultManagedContainerSourceRoot,
				mountPaths: this.mountPaths,
				useSessionWd: this.useSessionWd,
				env,
				createSourceSnapshot: this.createSourceSnapshot,
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

/** @param {{ target: any, sandbox: any }} environment */
export function createWorkerLauncher(environment) {
	const target = environment.target ?? { type: "local" }
	const sandbox = environment.sandbox ?? { type: "none" }
	if (target.type === "ssh") {
		if (sandbox.type === "none") return new SshWorkerLauncher({ target: target.host })
		throw new Error(`Sandbox type "${sandbox.type}" for ssh targets is not implemented yet`)
	}
	if (target.type !== "local") throw new Error(`Unsupported environment target type: ${target.type}`)
	if (sandbox.type === "none") return new LocalWorkerLauncher()
	if (sandbox.type === "native") return new NativeSandboxWorkerLauncher({ mountPaths: sandbox.mountPaths, useSessionWd: sandbox.useSessionWd, isolatedHome: sandbox.isolatedHome, stateMount: environment.stateMount })
	if (sandbox.type === "container") {
		if (sandbox.container) {
			return new ContainerExecWorkerLauncher({
				engine: sandbox.engine ?? "docker",
				container: sandbox.container,
				mountPaths: sandbox.mountPaths,
				useSessionWd: sandbox.useSessionWd,
				env: sandbox.env,
			})
		}
		return new ManagedContainerWorkerLauncher({
			engine: sandbox.engine,
			image: sandbox.image,
			user: sandbox.user,
			mountPaths: sandbox.mountPaths,
			useSessionWd: sandbox.useSessionWd,
			isolatedHome: sandbox.isolatedHome,
			stateMount: environment.stateMount,
			env: sandbox.env,
			network: sandbox.network,
			extraArgs: sandbox.extraArgs,
		})
	}
	throw new Error(`Unsupported sandbox type: ${sandbox.type}`)
}
