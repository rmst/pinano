import { homedir } from "node:os"
import { join } from "node:path"

import { insertContextAfterLatestResponsesCompaction } from "../responses-compaction.js"
import { initialSessionEnvironment, loadEnvironmentRegistry, resolveConfiguredEnvironmentId } from "./environments.js"
import { environmentHomePath as defaultEnvironmentHomePath, optionalPinanoHomePath, optionalRuntimeSourceReferencePath } from "./paths.js"
import { assertReadOnlyMountsNotCoveredByWritable, effectiveSandboxMounts, mountedPathForHostPath } from "./sandbox-paths.js"
import { addImplicitPinanoStateMounts, normalizePinanoStateMount, pinanoStateMountEnabled } from "./tool-state-mounts.js"

function xmlText(value) {
	return String(value ?? "").replace(/[&<>]/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
	})[ch])
}

function xmlAttr(value) {
	return String(value ?? "").replace(/[&"<>\n\r\t]/g, (ch) => ({
		"&": "&amp;",
		"\"": "&quot;",
		"<": "&lt;",
		">": "&gt;",
		"\n": "&#10;",
		"\r": "&#13;",
		"\t": "&#9;",
	})[ch])
}

function platformName(platform) {
	if (platform === "darwin") return "macOS"
	if (platform === "linux") return "Linux"
	if (platform === "win32") return "Windows"
	return platform || "unknown OS"
}

function hostDescription(platform, arch) {
	return `${platformName(platform)}${arch ? ` ${arch}` : ""}`
}

function hostLine(platform, arch, hostUserHome) {
	const host = hostDescription(platform, arch)
	return hostUserHome
		? `Host: ${host}. Host user home: ${xmlText(hostUserHome)}.`
		: `Host: ${host}.`
}

function pinanoStateDirLine(path) {
	return path ? `Host Pinano state directory: ${xmlText(path)}.` : undefined
}

function environmentAttrs(environment) {
	return `id="${xmlAttr(environment.id)}"`
}

function runsDescription(environment, platform, arch) {
	const target = environment?.target
	if (target?.type === "ssh") return `remote SSH host ${xmlText(target.host)}`
	if (environment?.sandbox?.type === "container") {
		const sandbox = environment.sandbox
		const engine = sandbox.engine ? sandbox.engine : sandbox.container ? "docker" : "Podman/Docker"
		const engineLabel = xmlText(engine.charAt(0).toUpperCase() + engine.slice(1))
		if (sandbox.container) return `Linux container on localhost, existing ${engineLabel} container "${xmlText(sandbox.container)}"`
		if (sandbox.image) return `Linux container on localhost, managed from image "${xmlText(sandbox.image)}" using ${engineLabel}`
		return `Linux container on localhost, managed by ${engineLabel}`
	}
	if (target?.type === "local") return `local ${hostDescription(platform, arch)} host`
	return "unknown target"
}

function sandboxMountPaths(sandbox) {
	return sandbox?.mountPaths ?? sandbox?.paths ?? []
}

function sandboxUseSessionWd(sandbox) {
	return sandbox?.useSessionWd ?? true
}

function canCreateImplicitPinanoStateMounts(environment) {
	const sandbox = environment?.sandbox
	return sandbox?.type === "native" || (sandbox?.type === "container" && !sandbox.container)
}

function effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	const sandbox = environment?.sandbox
	try {
		let mounts = effectiveSandboxMounts({
			sessionWd: initialCwd,
			useSessionWd: sandboxUseSessionWd(sandbox),
			mountPaths: sandboxMountPaths(sandbox),
		}, "Environment context")
		if (canCreateImplicitPinanoStateMounts(environment)) {
			mounts = addImplicitPinanoStateMounts(mounts, {
				sessionDir: sessionWorkspacePath,
				pinanoStateDirPath,
				pinanoStateMount,
				runtimeSourceReferencePath,
			})
		}
		return mounts
	} catch {
		return undefined
	}
}

function rwLabel(readOnly) {
	return readOnly ? "read-only" : "read/write"
}

function mountBullet(mount, options = {}) {
	const target = options.showTarget === false || mount.from === mount.to
		? xmlText(mount.from)
		: `${xmlText(mount.from)} -> ${xmlText(mount.to)}`
	return `- ${target} (${rwLabel(mount.readOnly)})`
}

function mountBullets(mounts, options = {}) {
	return mounts.map((mount) => mountBullet(mount, options))
}

function runtimeSourceDescription(kind) {
	return `(${kind} of the Pinano service code currently serving this Pinano state directory; you can use this for answering user questions about Pinano).`
}

function runtimeSourceLine(mounts, runtimeSourceReferencePath) {
	if (!runtimeSourceReferencePath || !mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, runtimeSourceReferencePath, { requireOneToOneMapping: true })
	if (!mounted?.readOnly) return undefined
	return `Pinano runtime source: ${xmlText(mounted.path)} ${runtimeSourceDescription("read-only copy")}`
}

function directRuntimeSourceLine(runtimeSourceReferencePath) {
	if (!runtimeSourceReferencePath) return undefined
	return `Pinano runtime source: ${xmlText(runtimeSourceReferencePath)} ${runtimeSourceDescription("service-created copy")}`
}

function pinanoStateMountLine(mounts, pinanoStateDirPath, pinanoStateMount) {
	const mode = normalizePinanoStateMount(pinanoStateMount)
	if (!pinanoStateMountEnabled(mode) || !pinanoStateDirPath || !mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, pinanoStateDirPath)
	if (!mounted) return undefined
	const access = rwLabel(mounted.readOnly)
	const usage = "you can use it for inspecting Pinano state, logs, configuration, and session data"
	const caution = mounted.readOnly
		? ""
		: "; edits affect Pinano's live state and should be made only when the user explicitly requests them and you have determined they are safe"
	return `Pinano state directory: ${xmlText(mounted.path)} (${access}; ${usage}${caution}).`
}

function containerFilesystemLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	const sandbox = environment.sandbox
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)
	if (sandbox.container) {
		if (!mounts || mounts.length === 0) return [
			"Filesystem: Existing container. Pinano does not create mounts for this environment; host path availability depends on how the container was started.",
		]
		return [
			"Filesystem: Existing container. Pinano does not create mounts for this environment. Expected host path mappings:",
			...mountBullets(mounts),
			pinanoStateMountLine(mounts, pinanoStateDirPath, pinanoStateMount),
			runtimeSourceLine(mounts, runtimeSourceReferencePath),
		]
	}
	if (!mounts) return [
		"Filesystem: Host path mappings could not be resolved for this context.",
	]
	if (mounts.length === 0) return [
		"Filesystem: No host paths are mounted by Pinano. Container-internal paths may still exist but do not map to host files unless provided by the image or runtime.",
	]
	return [
		"Filesystem: Host path mappings created by Pinano:",
		...mountBullets(mounts),
		pinanoStateMountLine(mounts, pinanoStateDirPath, pinanoStateMount),
		runtimeSourceLine(mounts, runtimeSourceReferencePath),
		"Edits under mounted host paths modify host files. Other host paths are not available in the container unless listed.",
	]
}

function nativeSandboxName(platform) {
	if (platform === "darwin") return "macOS sandbox-exec"
	if (platform === "linux") return "Linux bubblewrap (bwrap)"
	return "platform native sandbox"
}

function nativeHomeLine(environment, environmentHomePath) {
	try {
		return `HOME inside this environment: ${xmlText(environmentHomePath(environment.id))} (Pinano-managed host path, separate from the host user home).`
	} catch {
		return "HOME inside this environment: Pinano-managed per-environment home."
	}
}

function nativeFilesystemLines(environment, initialCwd, platform, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)
	const name = nativeSandboxName(platform)
	if (!mounts) return [
		`Filesystem: ${name}. Mount paths could not be resolved for this context.`,
		nativeHomeLine(environment, environmentHomePath),
	]
	try {
		assertReadOnlyMountsNotCoveredByWritable(mounts, "Environment context")
	} catch {
		return [
			`Filesystem: ${name}. Mount paths could not be validated for this context.`,
			nativeHomeLine(environment, environmentHomePath),
		]
	}
	if (mounts.length === 0) return [
		`Filesystem: ${name}. No project host paths are writable.`,
		nativeHomeLine(environment, environmentHomePath),
	]
	const writable = mounts.filter((mount) => !mount.readOnly)
	const readOnly = mounts.filter((mount) => mount.readOnly)
	return [
		`Filesystem: ${name}.`,
		nativeHomeLine(environment, environmentHomePath),
		...(writable.length > 0 ? [
			"Writable host paths:",
			...mountBullets(writable, { showTarget: false }),
		] : [
			"No project host paths are writable.",
		]),
		...(readOnly.length > 0 ? [
			"Read-only host paths:",
			...mountBullets(readOnly, { showTarget: false }),
		] : []),
		pinanoStateMountLine(mounts, pinanoStateDirPath, pinanoStateMount),
		runtimeSourceLine(mounts, runtimeSourceReferencePath),
		"Other host paths are read-only or unavailable depending on the native sandbox.",
	]
}

function filesystemLines(environment, initialCwd, platform, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	const sandbox = environment?.sandbox
	if (!sandbox) return ["Filesystem: tool sandbox is unknown."]
	if (sandbox.type === "none") return [
		"Filesystem: direct access to the full host filesystem; no Pinano filesystem sandbox.",
		directRuntimeSourceLine(runtimeSourceReferencePath),
	]
	if (sandbox.type === "native") return nativeFilesystemLines(environment, initialCwd, platform, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)
	if (sandbox.type === "container") return containerFilesystemLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)
	return [`Filesystem: tool sandbox is ${sandbox.type}.`]
}

function environmentBody(environment, initialCwd, platform, arch, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	return [
		`<environment ${environmentAttrs(environment)}>`,
		`Runs: ${runsDescription(environment, platform, arch)}.`,
		...filesystemLines(environment, initialCwd, platform, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount),
		`</environment>`,
	].filter(Boolean)
}

export function sessionWorkspaceToolPathForEnvironment(environment, initialCwd, runtimeSourceReferencePath, workspacePath, pinanoStateDirPath, pinanoStateMount) {
	if (!workspacePath) return undefined
	if (environment?.target?.type && environment.target.type !== "local") return undefined
	if (!environment?.sandbox || environment.sandbox.type === "none") return workspacePath
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, workspacePath, pinanoStateDirPath, pinanoStateMount)
	if (!mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, workspacePath)
	if (environment.sandbox.type === "container" && environment.sandbox.container) return mounted && !mounted.readOnly ? mounted.path : undefined
	return mounted && !mounted.readOnly ? mounted.path : undefined
}

function sessionWorkspaceLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount) {
	const path = sessionWorkspaceToolPathForEnvironment(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)
	if (!path) return []
	return [
		"Session workspace:",
		`- PINANO_SESSION_DIR: ${xmlText(path)}`,
		`- TMPDIR: ${xmlText(join(path, "tmp"))}`,
	]
}

/**
 * Render concise model-visible information about Pinano tool environments.
 * @param {object} [options]
 * @param {string} [options.cwd] Current session cwd, used as a fallback when initialCwd is omitted.
 * @param {string} [options.initialCwd] Session/worktree cwd used as the stable base for mountPaths.
 * @param {string} [options.environmentId] Current environment id.
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [options.registry]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.hostUserHome]
 * @param {string} [options.pinanoStateDirPath]
 * @param {string | undefined} [options.runtimeSourceReferencePath]
 * @param {string | undefined} [options.sessionWorkspacePath]
 * @param {unknown} [options.pinanoStateMount]
 * @param {(environmentId: string) => string} [options.environmentHomePath]
 */
export function environmentContextFor(options = {}) {
	const registry = options.registry ?? loadEnvironmentRegistry()
	const requestedId = options.environmentId ?? registry.default
	const currentId = resolveConfiguredEnvironmentId(requestedId, registry)
	const currentFallback = currentId !== requestedId
	const initialCwd = options.initialCwd ?? options.cwd ?? process.cwd()
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch
	const hostUserHome = options.hostUserHome ?? homedir()
	const pinanoStateDirPath = Object.hasOwn(options, "pinanoStateDirPath") ? options.pinanoStateDirPath : optionalPinanoHomePath()
	const runtimeSourceReferencePath = Object.hasOwn(options, "runtimeSourceReferencePath") ? options.runtimeSourceReferencePath : optionalRuntimeSourceReferencePath()
	const sessionWorkspacePath = options.sessionWorkspacePath
	const pinanoStateMount = normalizePinanoStateMount(options.pinanoStateMount) ?? false
	const environmentHomePath = options.environmentHomePath ?? defaultEnvironmentHomePath
	const environments = Object.values(registry.environments ?? {}).sort((a, b) => a.id.localeCompare(b.id))
	const currentEnvironment = environments.find((environment) => environment.id === currentId)
	const lines = [
		"<environment_context>",
		"Pinano tool calls run in one selected environment; this affects shell commands, filesystem access, and cwd.",
		hostLine(platform, arch, hostUserHome),
		pinanoStateDirLine(pinanoStateDirPath),
		`Current tool environment: ${currentId}${currentFallback ? ` (stored ${requestedId} is unavailable)` : ""}. Default tool environment: ${registry.default}.`,
		"Switch environments or cwd with sessionWrite.",
		...sessionWorkspaceLines(currentEnvironment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount),
		...environments.flatMap((environment) => environmentBody(environment, initialCwd, platform, arch, environmentHomePath, runtimeSourceReferencePath, sessionWorkspacePath, pinanoStateDirPath, pinanoStateMount)),
		"</environment_context>",
	].filter(Boolean)
	return lines.join("\n")
}

/** @param {string} cwd @param {ReturnType<typeof loadEnvironmentRegistry>} [registry] @param {{ pinanoStateMount?: unknown }} [options] */
export function initialEnvironmentContextFor(cwd, registry = loadEnvironmentRegistry(), options = {}) {
	const initial = initialSessionEnvironment(cwd, registry)
	return environmentContextFor({ ...options, cwd: initial.cwd, initialCwd: initial.cwd, environmentId: initial.environmentId, registry })
}

/** @param {string | undefined} text */
export function environmentContextMessage(text) {
	if (!text) return undefined
	return { role: "user", content: [{ type: "text", text }] }
}

/** @param {string | undefined} text @param {ReadonlyArray<any>} messages */
export function prependEnvironmentContext(text, messages) {
	const message = environmentContextMessage(text)
	return insertContextAfterLatestResponsesCompaction(message ? [message] : [], messages)
}
