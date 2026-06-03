import { isAbsolute, resolve } from "node:path"

import { insertContextAfterLatestResponsesCompaction } from "../responses-compaction.js"
import { initialSessionEnvironment, loadEnvironmentRegistry } from "./environments.js"

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

function liveCwd(environment, currentId, currentCwd) {
	return environment.id === currentId ? currentCwd : undefined
}

function defaultCwd(environment) {
	return environment.cwd
}

function environmentAttrs(environment) {
	return `id="${xmlAttr(environment.id)}"`
}

function resolvedRoot(cwd, configuredPath) {
	if (isAbsolute(configuredPath)) return configuredPath
	return resolve(cwd, configuredPath)
}

function rootDescription(cwd, configuredPath) {
	const root = resolvedRoot(cwd, configuredPath)
	if (configuredPath === ".") return xmlText(root)
	if (isAbsolute(configuredPath)) return xmlText(root)
	return `${xmlText(root)} (from "${xmlText(configuredPath)}")`
}

function configuredPathList(paths) {
	return paths.map((path) => `"${xmlText(path)}"`).join(", ")
}

function writableRoots(rootBase, paths) {
	if (!Array.isArray(paths) || paths.length === 0) return "not specified"
	if (!rootBase?.cwd) return `configured as ${configuredPathList(paths)}; relative entries resolve from the cwd used when this environment's worker starts`
	const roots = paths.map((path) => rootDescription(rootBase.cwd, path)).join("; ")
	return `${roots} (${configuredPathList(paths)} resolved from ${rootBase.label} ${xmlText(rootBase.cwd)})`
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

function nativeSandboxDescription(platform) {
	if (platform === "darwin") return "macOS sandbox-exec. Standard system and developer-tool paths are readable; writes are expected only under the writable roots and the per-environment tool home."
	if (platform === "linux") return "Linux bubblewrap (bwrap). The host filesystem is exposed mostly read-only; writes are expected only under the writable roots and the per-environment tool home."
	return "platform native sandbox. Writes are expected only under the writable roots and the per-environment tool home."
}

function sandboxDescription(environment, platform) {
	const sandbox = environment?.sandbox
	if (!sandbox) return "tool sandbox is unknown"
	if (sandbox.type === "none") return "no Pinano filesystem sandbox"
	if (sandbox.type === "native") return nativeSandboxDescription(platform)
	if (sandbox.type === "container") return "writable roots are mounted at the same absolute paths inside the container. Editing files there edits the mounted project files on the host. Other host paths are unavailable unless mounted."
	return `tool sandbox is ${sandbox.type}`
}

function cwdLines(environment, currentId, currentCwd, initialCwd) {
	const current = liveCwd(environment, currentId, currentCwd)
	const configuredDefault = defaultCwd(environment)
	if (current && configuredDefault && current === configuredDefault) return [`Cwd: current/default ${xmlText(current)}.`]
	if (current && configuredDefault) return [`Cwd: current ${xmlText(current)}; default ${xmlText(configuredDefault)}.`]
	if (current) {
		const suffix = initialCwd
			? ` No default cwd is configured; switching here without cwd preserves the session cwd. Relative sandbox paths are based on worker startup cwd ${xmlText(initialCwd)}.`
			: " No default cwd is configured; switching here without cwd preserves the session cwd."
		return [`Cwd: current ${xmlText(current)}.${suffix}`]
	}
	if (configuredDefault) return [`Cwd: default ${xmlText(configuredDefault)}.`]
	return ["Cwd: no default configured; switching here without cwd preserves the session cwd."]
}

function writableRootBase(environment, currentId, currentCwd, initialCwd) {
	const configuredDefault = defaultCwd(environment)
	if (configuredDefault) return { cwd: configuredDefault, label: "default cwd" }
	if (environment.id === currentId && initialCwd) return { cwd: initialCwd, label: "worker startup cwd" }
	if (environment.id === currentId && currentCwd) return { cwd: currentCwd, label: "current cwd" }
	return undefined
}

function environmentBody(environment, currentId, currentCwd, initialCwd, platform, arch) {
	const sandbox = environment?.sandbox
	const rootBase = writableRootBase(environment, currentId, currentCwd, initialCwd)
	return [
		`<environment ${environmentAttrs(environment)}>`,
		`Runs: ${runsDescription(environment, platform, arch)}.`,
		...cwdLines(environment, currentId, currentCwd, initialCwd),
		`Filesystem: ${sandboxDescription(environment, platform)}`,
		sandbox?.type && sandbox.type !== "none" ? `Writable roots: ${writableRoots(rootBase, sandbox.paths)}.` : undefined,
		`</environment>`,
	].filter(Boolean)
}

/**
 * Render concise model-visible information about Pinano tool environments.
 * @param {object} [options]
 * @param {string} [options.cwd] Current session cwd in the selected environment.
 * @param {string} [options.initialCwd] Session/worktree cwd used as the stable base for sandbox paths when no environment cwd is configured.
 * @param {string} [options.environmentId] Current environment id.
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [options.registry]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 */
export function environmentContextFor(options = {}) {
	const registry = options.registry ?? loadEnvironmentRegistry()
	const currentId = options.environmentId ?? registry.default
	const currentCwd = options.cwd ?? process.cwd()
	const initialCwd = options.initialCwd
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch
	const environments = Object.values(registry.environments ?? {}).sort((a, b) => a.id.localeCompare(b.id))
	const lines = [
		"<environment_context>",
		"Pinano tool calls run in one selected environment; this affects shell commands, file tools, and cwd.",
		`Host: ${hostDescription(platform, arch)}.`,
		`Current tool environment: ${currentId}. Default tool environment: ${registry.default}.`,
		"Switch environments with sessionWrite by setting environmentId.",
		...environments.flatMap((environment) => environmentBody(environment, currentId, currentCwd, initialCwd, platform, arch)),
		"</environment_context>",
	]
	return lines.join("\n")
}

/** @param {string} cwd @param {ReturnType<typeof loadEnvironmentRegistry>} [registry] */
export function initialEnvironmentContextFor(cwd, registry = loadEnvironmentRegistry()) {
	const initial = initialSessionEnvironment(cwd, registry)
	return environmentContextFor({ cwd: initial.cwd, initialCwd: initial.cwd, environmentId: initial.environmentId, registry })
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
