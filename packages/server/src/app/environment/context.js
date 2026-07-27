import { homedir } from "node:os"
import { join } from "node:path"

import { insertContextAfterLatestResponsesCompaction } from "../../../../protocol/src/responses-compaction.js"
import { initialSessionEnvironment, loadEnvironmentRegistry, resolveConfiguredEnvironmentId } from "./registry.js"
import { environmentContainerHomePath as defaultEnvironmentContainerHomePath, environmentHomePath as defaultEnvironmentHomePath, managedContainerHomePath, optionalProductHomePath, optionalRuntimeSourceReferencePath } from "../paths.js"
import { previewInstructions } from "../model/instructions/previews.js"
import { assertReadOnlyMountsNotCoveredByWritable, effectiveSandboxMounts, mountedPathForHostPath } from "../sandbox/paths.js"
import { sandboxWithSessionMounts } from "../session/config.js"
import { addImplicitStateMounts, addManagedContainerHomeMount, normalizeStateMount, stateMountEnabled } from "../workers/tool/state-mounts.js"

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

function stateDirLine(path) {
	return path ? `Host Cerex state directory: ${xmlText(path)}.` : undefined
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
	return sandbox?.mountPaths ?? []
}

function sandboxUseSessionWd(sandbox) {
	return sandbox?.useSessionWd ?? true
}

function canCreateImplicitStateMounts(environment) {
	const sandbox = environment?.sandbox
	return sandbox?.type === "native" || (sandbox?.type === "container" && !sandbox.container)
}

function shouldUseManagedContainerIsolatedHome(environment) {
	const sandbox = environment?.sandbox
	return sandbox?.type === "container" && !sandbox.container && sandbox.isolatedHome !== false
}

function effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = [], environmentContainerHomePath = defaultEnvironmentContainerHomePath) {
	const sandbox = sandboxWithSessionMounts(environment?.sandbox, sessionSandboxMounts)
	try {
		let mounts = effectiveSandboxMounts({
			sessionWd: initialCwd,
			useSessionWd: sandboxUseSessionWd(sandbox),
			mountPaths: sandboxMountPaths(sandbox),
		}, "Environment context")
		if (canCreateImplicitStateMounts(environment)) {
			mounts = addImplicitStateMounts(mounts, {
				sessionDir: sessionWorkspacePath,
				stateDirPath,
				stateMount,
				runtimeSourceReferencePath,
			})
		}
		if (shouldUseManagedContainerIsolatedHome(environment)) {
			mounts = addManagedContainerHomeMount(mounts, environmentContainerHomePath(environment.id), managedContainerHomePath)
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
	return `(${kind} of the Cerex service code currently serving this Cerex state directory; you can use this for answering user questions about Cerex).`
}

function runtimeSourceLine(mounts, runtimeSourceReferencePath) {
	if (!runtimeSourceReferencePath || !mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, runtimeSourceReferencePath, { requireOneToOneMapping: true })
	if (!mounted?.readOnly) return undefined
	return `Cerex runtime source: ${xmlText(mounted.path)} ${runtimeSourceDescription("read-only copy")}`
}

function directRuntimeSourceLine(runtimeSourceReferencePath) {
	if (!runtimeSourceReferencePath) return undefined
	return `Cerex runtime source: ${xmlText(runtimeSourceReferencePath)} ${runtimeSourceDescription("service-created copy")}`
}

function stateMountLine(mounts, stateDirPath, stateMount) {
	const mode = normalizeStateMount(stateMount)
	if (!stateMountEnabled(mode) || !stateDirPath || !mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, stateDirPath)
	if (!mounted) return undefined
	const access = rwLabel(mounted.readOnly)
	const usage = "you can use it for inspecting Cerex state, logs, configuration, and session data"
	const caution = mounted.readOnly
		? ""
		: "; edits affect Cerex's live state and should be made only when the user explicitly requests them and you have determined they are safe"
	return `Cerex state directory: ${xmlText(mounted.path)} (${access}; ${usage}${caution}).`
}

function managedContainerHomeLine(environment, environmentContainerHomePath) {
	if (environment?.sandbox?.container) return undefined
	if (environment?.sandbox?.isolatedHome === false) {
		const configuredHome = environment.sandbox.env?.HOME
		return configuredHome
			? `HOME inside this environment: ${xmlText(configuredHome)} (configured by sandbox.env; not isolated by Cerex).`
			: "HOME inside this environment: image/container default (not isolated by Cerex)."
	}
	try {
		return `HOME inside this environment: ${xmlText(managedContainerHomePath)} (Cerex-managed container path backed by host path ${xmlText(environmentContainerHomePath(environment.id))}).`
	} catch {
		return `HOME inside this environment: ${xmlText(managedContainerHomePath)} (Cerex-managed container path).`
	}
}

function containerFilesystemLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = [], environmentContainerHomePath = defaultEnvironmentContainerHomePath) {
	const sandbox = environment.sandbox
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts, environmentContainerHomePath)
	const homeLine = managedContainerHomeLine(environment, environmentContainerHomePath)
	if (sandbox.container) {
		if (!mounts || mounts.length === 0) return [
			"Filesystem: Existing container. Cerex does not create mounts for this environment; host path availability depends on how the container was started.",
		]
		return [
			"Filesystem: Existing container. Cerex does not create mounts for this environment. Expected host path mappings:",
			...mountBullets(mounts),
			stateMountLine(mounts, stateDirPath, stateMount),
			runtimeSourceLine(mounts, runtimeSourceReferencePath),
		]
	}
	if (!mounts) return [
		"Filesystem: Host path mappings could not be resolved for this context.",
		homeLine,
	]
	if (mounts.length === 0) return [
		"Filesystem: No host paths are mounted by Cerex. Container-internal paths may still exist but do not map to host files unless provided by the image or runtime.",
		homeLine,
	]
	return [
		"Filesystem: Host path mappings created by Cerex:",
		homeLine,
		...mountBullets(mounts),
		stateMountLine(mounts, stateDirPath, stateMount),
		runtimeSourceLine(mounts, runtimeSourceReferencePath),
		"Edits under mounted host paths modify host files. Other host paths are not available in the container unless listed.",
	]
}

function nativeSandboxName(platform) {
	if (platform === "darwin") return "macOS sandbox-exec"
	if (platform === "linux") return "Linux bubblewrap (bwrap)"
	return "platform native sandbox"
}

function nativeHomeLine(environment, environmentHomePath, serviceHome) {
	if (environment?.sandbox?.isolatedHome === false) {
		return `HOME inside this environment: ${xmlText(serviceHome)} (same as the Cerex service HOME; not isolated by Cerex).`
	}
	try {
		return `HOME inside this environment: ${xmlText(environmentHomePath(environment.id))} (Cerex-managed host path, separate from the host user home).`
	} catch {
		return "HOME inside this environment: Cerex-managed per-environment home."
	}
}

function nativeFilesystemLines(environment, initialCwd, platform, environmentHomePath, serviceHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = []) {
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts)
	const name = nativeSandboxName(platform)
	if (!mounts) return [
		`Filesystem: ${name}. Mount paths could not be resolved for this context.`,
		nativeHomeLine(environment, environmentHomePath, serviceHome),
	]
	try {
		assertReadOnlyMountsNotCoveredByWritable(mounts, "Environment context")
	} catch {
		return [
			`Filesystem: ${name}. Mount paths could not be validated for this context.`,
			nativeHomeLine(environment, environmentHomePath, serviceHome),
		]
	}
	if (mounts.length === 0) return [
		`Filesystem: ${name}. No project host paths are writable.`,
		nativeHomeLine(environment, environmentHomePath, serviceHome),
	]
	const writable = mounts.filter((mount) => !mount.readOnly)
	const readOnly = mounts.filter((mount) => mount.readOnly)
	return [
		`Filesystem: ${name}.`,
		nativeHomeLine(environment, environmentHomePath, serviceHome),
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
		stateMountLine(mounts, stateDirPath, stateMount),
		runtimeSourceLine(mounts, runtimeSourceReferencePath),
		"Other host paths are read-only or unavailable depending on the native sandbox.",
	]
}

function filesystemLines(environment, initialCwd, platform, environmentHomePath, environmentContainerHomePath, serviceHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = []) {
	const sandbox = environment?.sandbox
	if (!sandbox) return ["Filesystem: tool sandbox is unknown."]
	if (sandbox.type === "none") return [
		"Filesystem: direct access to the full host filesystem; no Cerex filesystem sandbox.",
		directRuntimeSourceLine(runtimeSourceReferencePath),
	]
	if (sandbox.type === "native") return nativeFilesystemLines(environment, initialCwd, platform, environmentHomePath, serviceHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts)
	if (sandbox.type === "container") return containerFilesystemLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts, environmentContainerHomePath)
	return [`Filesystem: tool sandbox is ${sandbox.type}.`]
}

function environmentBody(environment, initialCwd, platform, arch, environmentHomePath, environmentContainerHomePath, serviceHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = []) {
	return [
		`<environment ${environmentAttrs(environment)}>`,
		`Runs: ${runsDescription(environment, platform, arch)}.`,
		...filesystemLines(environment, initialCwd, platform, environmentHomePath, environmentContainerHomePath, serviceHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts),
		`</environment>`,
	].filter(Boolean)
}

export function sessionWorkspaceToolPathForEnvironment(environment, initialCwd, runtimeSourceReferencePath, workspacePath, stateDirPath, stateMount, sessionSandboxMounts = [], environmentContainerHomePath = defaultEnvironmentContainerHomePath) {
	if (!workspacePath) return undefined
	if (environment?.target?.type && environment.target.type !== "local") return undefined
	if (!environment?.sandbox || environment.sandbox.type === "none") return workspacePath
	const mounts = effectiveMountsForContext(environment, initialCwd, runtimeSourceReferencePath, workspacePath, stateDirPath, stateMount, sessionSandboxMounts, environmentContainerHomePath)
	if (!mounts) return undefined
	const mounted = mountedPathForHostPath(mounts, workspacePath)
	if (environment.sandbox.type === "container" && environment.sandbox.container) return mounted && !mounted.readOnly ? mounted.path : undefined
	return mounted && !mounted.readOnly ? mounted.path : undefined
}

function sessionWorkspaceLines(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts = [], sessionId = undefined, environmentContainerHomePath = defaultEnvironmentContainerHomePath) {
	const path = sessionWorkspaceToolPathForEnvironment(environment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts, environmentContainerHomePath)
	if (!path && !sessionId) return []
	return [
		"Session files:",
		...(sessionId ? [`- CEREX_SESSION: ${xmlText(sessionId)}`] : []),
		...(path ? [`- CEREX_SESSION_DIR: ${xmlText(path)}`] : []),
	]
}

function sessionPreviewLines(previewPublicUrl) {
	if (!previewPublicUrl) return []
	const instructions = previewInstructions()
	return instructions ? instructions.split("\n") : []
}

/**
 * Render concise model-visible information about Cerex tool environments.
 * @param {object} [options]
 * @param {string} [options.cwd] Current session cwd, used as a fallback when initialCwd is omitted.
 * @param {string} [options.initialCwd] Stable sandbox base working directory used for mountPaths.
 * @param {string} [options.environmentId] Current environment id.
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [options.registry]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.hostUserHome]
 * @param {string} [options.stateDirPath]
 * @param {string | undefined} [options.runtimeSourceReferencePath]
 * @param {string | undefined} [options.sessionWorkspacePath]
 * @param {string | undefined} [options.sessionId]
 * @param {string | undefined} [options.previewPublicUrl]
 * @param {unknown} [options.stateMount]
 * @param {any[]} [options.sandboxMounts]
 * @param {(environmentId: string) => string} [options.environmentHomePath]
 * @param {(environmentId: string) => string} [options.environmentContainerHomePath]
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
	const stateDirPath = Object.hasOwn(options, "stateDirPath") ? options.stateDirPath : optionalProductHomePath()
	const runtimeSourceReferencePath = Object.hasOwn(options, "runtimeSourceReferencePath") ? options.runtimeSourceReferencePath : optionalRuntimeSourceReferencePath()
	const sessionWorkspacePath = options.sessionWorkspacePath
	const sessionId = options.sessionId
	const previewPublicUrl = options.previewPublicUrl
	const stateMount = normalizeStateMount(options.stateMount) ?? false
	const sessionSandboxMounts = Array.isArray(options.sandboxMounts) ? options.sandboxMounts : []
	const environmentHomePath = options.environmentHomePath ?? defaultEnvironmentHomePath
	const environmentContainerHomePath = options.environmentContainerHomePath ?? defaultEnvironmentContainerHomePath
	const environments = Object.values(registry.environments ?? {}).sort((a, b) => a.id.localeCompare(b.id))
	const currentEnvironment = environments.find((environment) => environment.id === currentId)
	const lines = [
		"<environment_context>",
		"Cerex tool calls run in one selected environment; this affects shell commands, filesystem access, and cwd.",
		hostLine(platform, arch, hostUserHome),
		stateDirLine(stateDirPath),
		`Current tool environment: ${currentId}${currentFallback ? ` (stored ${requestedId} is unavailable)` : ""}. Default tool environment: ${registry.default}.`,
		"Switch environments or cwd with `cerex session set cwd <path>` or `cerex session set environment <id>`.",
		...sessionWorkspaceLines(currentEnvironment, initialCwd, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts, sessionId, environmentContainerHomePath),
		...sessionPreviewLines(previewPublicUrl),
		...environments.flatMap((environment) => environmentBody(environment, initialCwd, platform, arch, environmentHomePath, environmentContainerHomePath, hostUserHome, runtimeSourceReferencePath, sessionWorkspacePath, stateDirPath, stateMount, sessionSandboxMounts)),
		"</environment_context>",
	].filter(Boolean)
	return lines.join("\n")
}

/** @param {string} cwd @param {ReturnType<typeof loadEnvironmentRegistry>} [registry] @param {{ stateMount?: unknown }} [options] */
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
