import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"

import { DOCKER_PROXY_ROUTE } from "../../internal-proxy-routes.js"
import { effectiveSandboxMounts, hostPathForMountedPath } from "../../app/sandbox-paths.js"
import { addSessionWorkspaceRootMount } from "../../app/tool-state-mounts.js"
import { internalHttpJsonResponse, internalHttpRequestBodyText } from "../../app/worker-internal-http.js"

export { DOCKER_PROXY_ROUTE }
export const DOCKER_PROXY_OWNER_LABEL = "com.pinano.proxy"
export const DOCKER_PROXY_OWNER_VALUE = "docker"
export const DOCKER_PROXY_SESSION_LABEL = "com.pinano.session"
export const DOCKER_PROXY_ENVIRONMENT_LABEL = "com.pinano.environment"

const DOCKER_CLI_ERROR_EXIT_CODE = 125
const MAX_PROXY_OUTPUT_BYTES = 8 * 1024 * 1024

const RUN_BOOLEAN_FLAGS = new Set([
	"--help",
	"--init",
	"--interactive",
	"--no-healthcheck",
	"--oom-kill-disable",
	"--privileged",
	"--publish-all",
	"--read-only",
	"--rm",
	"--tty",
])

const RUN_VALUE_FLAGS = new Set([
	"--add-host",
	"--cpus",
	"--detach-keys",
	"--dns",
	"--dns-option",
	"--dns-search",
	"--entrypoint",
	"--env",
	"--hostname",
	"--label",
	"--memory",
	"--memory-reservation",
	"--memory-swap",
	"--name",
	"--network",
	"--net",
	"--platform",
	"--pull",
	"--shm-size",
	"--stop-signal",
	"--stop-timeout",
	"--ulimit",
	"--user",
	"--workdir",
])

const RUN_REJECTED_FLAGS = new Set([
	"--cap-add",
	"--cgroupns",
	"--cidfile",
	"--device",
	"--device-cgroup-rule",
	"--env-file",
	"--expose",
	"--gpus",
	"--group-add",
	"--health-cmd",
	"--health-interval",
	"--health-retries",
	"--health-start-period",
	"--health-timeout",
	"--ipc",
	"--isolation",
	"--label-file",
	"--pid",
	"--publish",
	"--restart",
	"--runtime",
	"--security-opt",
	"--userns",
	"--uts",
	"--volume-driver",
	"--volumes-from",
])

const PS_BOOLEAN_FLAGS = new Set(["--all", "--latest", "--no-trunc", "--quiet", "--size"])
const PS_VALUE_FLAGS = new Set(["--format", "--last"])
const LOGS_BOOLEAN_FLAGS = new Set(["--details", "--follow", "--timestamps"])
const LOGS_VALUE_FLAGS = new Set(["--since", "--tail", "--until"])
const STOP_BOOLEAN_FLAGS = new Set([])
const STOP_VALUE_FLAGS = new Set(["--time"])
const RM_BOOLEAN_FLAGS = new Set(["--force", "--link", "--volumes"])
const RM_VALUE_FLAGS = new Set([])
const INSPECT_BOOLEAN_FLAGS = new Set(["--size"])
const INSPECT_VALUE_FLAGS = new Set(["--format"])
const EXEC_BOOLEAN_FLAGS = new Set(["--interactive", "--tty"])
const EXEC_VALUE_FLAGS = new Set(["--detach-keys", "--env", "--user", "--workdir"])
const MOUNT_SPEC_KEYS = new Set(["type", "source", "src", "target", "destination", "dst", "readonly", "ro", "consistency"])

class DockerProxyCliError extends Error {
	constructor(message, exitCode = DOCKER_CLI_ERROR_EXIT_CODE) {
		super(message)
		this.exitCode = exitCode
	}
}

function cliError(message) {
	return new DockerProxyCliError(message)
}

function stringOrUndefined(value) {
	return typeof value === "string" && value ? value : undefined
}

function optionName(arg) {
	const index = arg.indexOf("=")
	return index < 0 ? arg : arg.slice(0, index)
}

function inlineOptionValue(arg) {
	const index = arg.indexOf("=")
	return index < 0 ? undefined : arg.slice(index + 1)
}

function inlineShortOptionValue(arg, shortName) {
	const value = arg.slice(shortName.length)
	return value.startsWith("=") ? value.slice(1) : value
}

function outputBase64(value) {
	if (Buffer.isBuffer(value)) return value.toString("base64")
	return Buffer.from(String(value ?? ""), "utf-8").toString("base64")
}

function proxyToolResponse({ stdout = "", stderr = "", exitCode = 0 } = {}) {
	return {
		exitCode,
		stdoutBase64: outputBase64(stdout),
		stderrBase64: outputBase64(stderr),
	}
}

function proxyCliErrorResponse(message, exitCode = DOCKER_CLI_ERROR_EXIT_CODE) {
	return proxyToolResponse({ stderr: `docker proxy: ${message}\n`, exitCode })
}

function parseInternalJsonBody(request) {
	try {
		return JSON.parse(internalHttpRequestBodyText(request) || "{}")
	} catch {
		throw Object.assign(new Error("Invalid JSON body"), { status: 400 })
	}
}

function parseDockerProxyPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw Object.assign(new Error("docker proxy body must be an object"), { status: 400 })
	}
	if (!Array.isArray(payload.argv)) throw Object.assign(new Error("docker proxy argv must be an array"), { status: 400 })
	if (!payload.argv.every((arg) => typeof arg === "string")) throw Object.assign(new Error("docker proxy argv entries must be strings"), { status: 400 })
	return {
		argv: payload.argv,
		cwd: stringOrUndefined(payload.cwd),
		toolCallId: stringOrUndefined(payload.toolCallId),
	}
}

function sandboxMountPaths(sandbox) {
	return sandbox?.mountPaths ?? sandbox?.paths ?? []
}

function sandboxUseSessionWd(sandbox) {
	return sandbox?.useSessionWd ?? true
}

function resolveWorkerPath(path, cwd) {
	if (!path) return undefined
	if (isAbsolute(path)) return resolve(path)
	if (!cwd || !isAbsolute(cwd)) return undefined
	return resolve(cwd, path)
}

function effectiveWorkerMounts(workerContext = {}) {
	const sandbox = workerContext.sandbox ?? { type: "none" }
	let mounts = effectiveSandboxMounts({
		sessionWd: workerContext.sessionWd ?? workerContext.startCwd,
		useSessionWd: sandboxUseSessionWd(sandbox),
		mountPaths: sandboxMountPaths(sandbox),
	}, "Docker proxy path mapping")
	return addSessionWorkspaceRootMount(mounts, stringOrUndefined(workerContext.sessionDir))
}

export function hostPathForWorkerDockerPath(workerPath, workerContext = {}) {
	const path = stringOrUndefined(workerPath)
	if (!path || !isAbsolute(path)) return undefined
	if (workerContext.target?.type !== "local") return undefined
	const sandbox = workerContext.sandbox ?? { type: "none" }
	if (sandbox.type === "none") return { path: resolve(path), readOnly: false }
	if (sandbox.type !== "native" && sandbox.type !== "container") return undefined
	try {
		return hostPathForMountedPath(effectiveWorkerMounts(workerContext), path)
	} catch {
		return undefined
	}
}

function dockerOwnerLabels(context = {}) {
	const sessionId = stringOrUndefined(context.sessionId)
	if (!sessionId) throw cliError("session ownership context is unavailable")
	return {
		[DOCKER_PROXY_OWNER_LABEL]: DOCKER_PROXY_OWNER_VALUE,
		[DOCKER_PROXY_SESSION_LABEL]: sessionId,
		...(stringOrUndefined(context.workerContext?.environmentId) ? { [DOCKER_PROXY_ENVIRONMENT_LABEL]: context.workerContext.environmentId } : {}),
	}
}

function dockerOwnerLabelArgs(context = {}) {
	return Object.entries(dockerOwnerLabels(context)).flatMap(([name, value]) => ["--label", `${name}=${value}`])
}

function dockerOwnerFilterArgs(context = {}) {
	return Object.entries(dockerOwnerLabels(context)).flatMap(([name, value]) => ["--filter", `label=${name}=${value}`])
}

function userLabelName(value) {
	const index = value.indexOf("=")
	return index < 0 ? value : value.slice(0, index)
}

function assertUserLabelAllowed(value) {
	const name = userLabelName(value)
	if (!name) throw cliError("docker run --label requires a non-empty name")
	if (name.startsWith("com.pinano.")) throw cliError("com.pinano.* Docker labels are reserved")
}

function normalizeNetworkMode(value) {
	const mode = String(value ?? "").trim()
	if (!mode) throw cliError("docker run --network requires a non-empty value")
	if (["host"].includes(mode) || mode.startsWith("container:")) throw cliError(`docker run --network=${mode} is not allowed`)
	if (!["bridge", "none"].includes(mode)) throw cliError(`docker run --network=${mode} is not available through the Pinano proxy`)
	return mode
}

function splitVolumeMode(mode) {
	return String(mode ?? "").split(",").filter(Boolean)
}

function rewriteVolumeMode(mode, mapped) {
	const tokens = splitVolumeMode(mode)
	const unsupported = tokens.filter((token) => !["ro", "rw", "z", "Z", "cached", "delegated", "consistent"].includes(token))
	if (unsupported.length > 0) throw cliError(`unsupported docker volume option: ${unsupported[0]}`)
	if (mapped.readOnly && tokens.includes("rw")) throw cliError("read-write bind mount requested for a read-only sandbox path")
	const access = mapped.readOnly || tokens.includes("ro") ? "ro" : tokens.includes("rw") ? "rw" : undefined
	const rest = tokens.filter((token) => token !== "ro" && token !== "rw")
	return [...(access ? [access] : []), ...rest].join(",")
}

function pathLikeVolumeSource(source) {
	return source.startsWith("/") || source === "." || source === ".." || source.startsWith("./") || source.startsWith("../")
}

function rewriteBindSource(source, payload, context = {}) {
	if (!pathLikeVolumeSource(source)) throw cliError("named and anonymous Docker volumes are not available through the Pinano proxy")
	const workerPath = resolveWorkerPath(source, payload.cwd)
	if (!workerPath) throw cliError(`bind mount source is not an absolute path and cwd is unavailable: ${source}`)
	const mapped = hostPathForWorkerDockerPath(workerPath, context.workerContext)
	if (!mapped?.path) throw cliError(`bind mount source is outside the sandbox: ${source}`)
	if (mapped.path === "/var/run/docker.sock" || mapped.path === "/run/docker.sock") throw cliError("mounting the Docker socket is not allowed")
	return mapped
}

function rewriteVolumeSpec(spec, payload, context = {}) {
	const parts = String(spec ?? "").split(":")
	if (parts.length < 2 || parts.length > 3) throw cliError(`unsupported docker volume syntax: ${spec}`)
	const [source, target, mode = ""] = parts
	if (!target || !isAbsolute(target)) throw cliError(`docker volume target must be absolute: ${spec}`)
	const mapped = rewriteBindSource(source, payload, context)
	const rewrittenMode = rewriteVolumeMode(mode, mapped)
	return `${mapped.path}:${target}${rewrittenMode ? `:${rewrittenMode}` : ""}`
}

function parseMountSpec(spec) {
	const out = {}
	for (const rawPart of String(spec ?? "").split(",")) {
		const part = rawPart.trim()
		if (!part) continue
		const index = part.indexOf("=")
		if (index < 0) {
			out[part] = true
			continue
		}
		out[part.slice(0, index)] = part.slice(index + 1)
	}
	return out
}

function rewriteMountSpec(spec, payload, context = {}) {
	const mount = parseMountSpec(spec)
	const unknown = Object.keys(mount).filter((key) => !MOUNT_SPEC_KEYS.has(key))
	if (unknown.length > 0) throw cliError(`unsupported docker mount option: ${unknown[0]}`)
	const type = mount.type ?? "volume"
	if (type !== "bind") throw cliError("only type=bind Docker mounts are available through the Pinano proxy")
	if (mount["bind-propagation"]) throw cliError("Docker bind propagation options are not available through the Pinano proxy")
	const source = mount.source ?? mount.src
	const target = mount.target ?? mount.destination ?? mount.dst
	if (!source) throw cliError("docker bind mount source is required")
	if (!target || typeof target !== "string" || !isAbsolute(target)) throw cliError("docker bind mount target must be absolute")
	const mapped = rewriteBindSource(source, payload, context)
	const requestedRw = mount.readonly === "false" || mount.ro === "false"
	if (mapped.readOnly && requestedRw) throw cliError("read-write bind mount requested for a read-only sandbox path")
	const readonly = mapped.readOnly || mount.readonly === true || mount.readonly === "true" || mount.ro === true || mount.ro === "true"
	return [
		"type=bind",
		`source=${mapped.path}`,
		`target=${target}`,
		...(readonly ? ["readonly"] : []),
	].join(",")
}

function consumeLongValueOption(argv, index, out) {
	const arg = argv[index]
	if (arg.includes("=")) {
		out.push(arg)
		return index + 1
	}
	if (index + 1 >= argv.length) throw cliError(`${arg} requires a value`)
	out.push(arg, argv[index + 1])
	return index + 2
}

function consumeRejectedOption(argv, index, messagePrefix) {
	const arg = argv[index]
	const name = optionName(arg)
	throw cliError(`${messagePrefix} ${name} is not available through the Pinano proxy`)
}

function consumeRunVolume(argv, index, payload, context, out) {
	const arg = argv[index]
	if (arg === "-v") {
		if (index + 1 >= argv.length) throw cliError("-v requires a value")
		out.push("--volume", rewriteVolumeSpec(argv[index + 1], payload, context))
		return index + 2
	}
	if (arg.startsWith("-v") && arg.length > 2) {
		out.push("--volume", rewriteVolumeSpec(arg.slice(2), payload, context))
		return index + 1
	}
	if (arg.startsWith("--volume=")) {
		out.push("--volume", rewriteVolumeSpec(inlineOptionValue(arg), payload, context))
		return index + 1
	}
	if (arg === "--volume") {
		if (index + 1 >= argv.length) throw cliError("--volume requires a value")
		out.push("--volume", rewriteVolumeSpec(argv[index + 1], payload, context))
		return index + 2
	}
	return undefined
}

function consumeRunMount(argv, index, payload, context, out) {
	const arg = argv[index]
	if (arg.startsWith("--mount=")) {
		out.push("--mount", rewriteMountSpec(inlineOptionValue(arg), payload, context))
		return index + 1
	}
	if (arg === "--mount") {
		if (index + 1 >= argv.length) throw cliError("--mount requires a value")
		out.push("--mount", rewriteMountSpec(argv[index + 1], payload, context))
		return index + 2
	}
	return undefined
}

function consumeRunShortOption(argv, index, out) {
	const arg = argv[index]
	if (/^-[dit]+$/.test(arg) && arg.includes("d")) throw cliError("detached docker run containers are not available through the Pinano proxy")
	if (/^-[it]+$/.test(arg)) {
		out.push(arg)
		return index + 1
	}
	const valueShort = new Map([
		["-e", "--env"],
		["-h", "--hostname"],
		["-l", "--label"],
		["-m", "--memory"],
		["-u", "--user"],
		["-w", "--workdir"],
	])
	for (const [shortName, longName] of valueShort.entries()) {
		if (arg === shortName) {
			if (index + 1 >= argv.length) throw cliError(`${shortName} requires a value`)
			if (longName === "--label") assertUserLabelAllowed(argv[index + 1])
			out.push(longName, argv[index + 1])
			return index + 2
		}
		if (arg.startsWith(shortName) && arg.length > 2) {
			const value = inlineShortOptionValue(arg, shortName)
			if (longName === "--label") assertUserLabelAllowed(value)
			out.push(longName, value)
			return index + 1
		}
	}
	if (arg === "-p" || arg.startsWith("-p") || arg === "-P") throw cliError("docker run port publishing is not available through the Pinano proxy")
	return undefined
}

function consumeRunLongOption(argv, index, out, state = {}) {
	const arg = argv[index]
	const name = optionName(arg)
	if (name === "--detach") throw cliError("detached docker run containers are not available through the Pinano proxy")
	if (RUN_REJECTED_FLAGS.has(name)) return consumeRejectedOption(argv, index, "docker run")
	if (RUN_BOOLEAN_FLAGS.has(name)) {
		if (name === "--privileged" && !arg.includes("=")) throw cliError("docker run --privileged is not available through the Pinano proxy")
		if (name === "--publish-all") throw cliError("docker run --publish-all is not available through the Pinano proxy")
		if (name === "--privileged" && inlineOptionValue(arg) !== "false") throw cliError("docker run --privileged is not available through the Pinano proxy")
		if (name === "--rm") {
			const value = inlineOptionValue(arg)
			if (value !== undefined && value !== "true") throw cliError("docker run --rm=false is not available through the Pinano proxy")
			state.autoRemove = true
			out.push("--rm")
			return index + 1
		}
		out.push(arg)
		return index + 1
	}
	if (!RUN_VALUE_FLAGS.has(name)) return undefined
	const value = inlineOptionValue(arg)
	if (name === "--network" || name === "--net") {
		if (value !== undefined) {
			const mode = normalizeNetworkMode(value)
			state.networkMode = mode
			out.push("--network", mode)
			return index + 1
		}
		if (index + 1 >= argv.length) throw cliError(`${name} requires a value`)
		const mode = normalizeNetworkMode(argv[index + 1])
		state.networkMode = mode
		out.push("--network", mode)
		return index + 2
	}
	if (name === "--label") {
		const labelValue = value ?? argv[index + 1]
		if (labelValue === undefined) throw cliError("--label requires a value")
		assertUserLabelAllowed(labelValue)
	}
	return consumeLongValueOption(argv, index, out)
}

function planDockerRun(prefix, rest, payload, context = {}) {
	const out = [...prefix]
	const state = {}
	let index = 0
	let optionsEnded = false
	while (index < rest.length) {
		const arg = rest[index]
		if (arg === "--") {
			optionsEnded = true
			index++
			break
		}
		if (!arg.startsWith("-") || arg === "-") break
		const volumeNext = consumeRunVolume(rest, index, payload, context, out)
		if (volumeNext !== undefined) {
			index = volumeNext
			continue
		}
		const mountNext = consumeRunMount(rest, index, payload, context, out)
		if (mountNext !== undefined) {
			index = mountNext
			continue
		}
		const shortNext = arg.startsWith("-") && !arg.startsWith("--") ? consumeRunShortOption(rest, index, out) : undefined
		if (shortNext !== undefined) {
			index = shortNext
			continue
		}
		const longNext = arg.startsWith("--") ? consumeRunLongOption(rest, index, out, state) : undefined
		if (longNext !== undefined) {
			index = longNext
			continue
		}
		throw cliError(`unsupported docker run option: ${optionName(arg)}`)
	}
	if (index >= rest.length) throw cliError("docker run requires an image")
	if (context.workerContext?.sandbox?.network === "none") {
		if (state.networkMode && state.networkMode !== "none") throw cliError("docker run network must be none in this environment")
		if (!state.networkMode) out.push("--network", "none")
	}
	return {
		args: [
			...out,
			...(state.autoRemove ? [] : ["--rm"]),
			...dockerOwnerLabelArgs(context),
			...(optionsEnded ? ["--"] : []),
			...rest.slice(index),
		],
	}
}

function consumeSimpleFlag(argv, index, out, spec) {
	const arg = argv[index]
	if (!arg.startsWith("-") || arg === "-") return undefined
	const name = optionName(arg)
	if (spec.rejectFilter && (name === "--filter" || arg === "-f" || arg.startsWith("-f"))) throw cliError(`${spec.command} --filter is not available through the Pinano proxy`)
	if (arg === "--") return index + 1
	if (arg.startsWith("--")) {
		if (spec.boolean.has(name)) {
			out.push(arg)
			return index + 1
		}
		if (spec.value.has(name)) return consumeLongValueOption(argv, index, out)
		return undefined
	}
	if (spec.shortBooleanPattern?.test(arg)) {
		out.push(arg)
		return index + 1
	}
	for (const [shortName, longName] of spec.shortValues ?? []) {
		if (arg === shortName) {
			if (index + 1 >= argv.length) throw cliError(`${shortName} requires a value`)
			out.push(longName, argv[index + 1])
			return index + 2
		}
		if (arg.startsWith(shortName) && arg.length > 2) {
			out.push(longName, inlineShortOptionValue(arg, shortName))
			return index + 1
		}
	}
	return undefined
}

function parseOptionsAndRefs(rest, spec, options = {}) {
	const out = []
	let index = 0
	let optionsEnded = false
	while (index < rest.length) {
		const arg = rest[index]
		if (!optionsEnded && arg === "--") {
			optionsEnded = true
			out.push("--")
			index++
			break
		}
		if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
			const next = consumeSimpleFlag(rest, index, out, spec)
			if (!next) throw cliError(`unsupported ${spec.command} option: ${optionName(arg)}`)
			index = next
			continue
		}
		break
	}
	const refs = rest.slice(index)
	if (options.exactRefs !== undefined && refs.length !== options.exactRefs) throw cliError(`${spec.command} requires ${options.exactRefs} container ${options.exactRefs === 1 ? "argument" : "arguments"}`)
	if (options.minRefs !== undefined && refs.length < options.minRefs) throw cliError(`${spec.command} requires at least ${options.minRefs} container argument${options.minRefs === 1 ? "" : "s"}`)
	return { options: out, refs }
}

function planDockerPs(prefix, rest, context = {}) {
	const parsed = parseOptionsAndRefs(rest, {
		command: "docker ps",
		boolean: PS_BOOLEAN_FLAGS,
		value: PS_VALUE_FLAGS,
		rejectFilter: true,
		shortBooleanPattern: /^-[aqls]+$/,
		shortValues: [["-n", "--last"]],
	}, { exactRefs: 0 })
	return {
		args: [
			...prefix,
			...dockerOwnerFilterArgs(context),
			...parsed.options,
		],
	}
}

function planDockerContainerRefs(prefix, rest, spec, context = {}, options = {}) {
	const parsed = parseOptionsAndRefs(rest, spec, options)
	return {
		args: [...prefix, ...parsed.options, ...parsed.refs],
		verifyRefs: parsed.refs,
	}
}

function planDockerExec(prefix, rest) {
	const out = []
	let index = 0
	let optionsEnded = false
	while (index < rest.length) {
		const arg = rest[index]
		if (!optionsEnded && arg === "--") {
			optionsEnded = true
			out.push("--")
			index++
			break
		}
		if (!optionsEnded && arg === "--privileged") throw cliError("docker exec --privileged is not available through the Pinano proxy")
		if (!optionsEnded && (arg === "--env-file" || arg.startsWith("--env-file="))) throw cliError("docker exec --env-file is not available through the Pinano proxy")
		if (!optionsEnded && optionName(arg) === "--detach") throw cliError("detached docker exec processes are not available through the Pinano proxy")
		if (!optionsEnded && /^-[dit]+$/.test(arg) && arg.includes("d")) throw cliError("detached docker exec processes are not available through the Pinano proxy")
		if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
			const next = consumeSimpleFlag(rest, index, out, {
				command: "docker exec",
				boolean: EXEC_BOOLEAN_FLAGS,
				value: EXEC_VALUE_FLAGS,
				shortBooleanPattern: /^-[it]+$/,
				shortValues: [["-e", "--env"], ["-u", "--user"], ["-w", "--workdir"]],
			})
			if (!next) throw cliError(`unsupported docker exec option: ${optionName(arg)}`)
			index = next
			continue
		}
		break
	}
	if (index >= rest.length) throw cliError("docker exec requires a container")
	const ref = rest[index]
	const command = rest.slice(index + 1)
	if (command.length === 0) throw cliError("docker exec requires a command")
	return {
		args: [...prefix, ...out, ref, ...command],
		verifyRefs: [ref],
	}
}

function commandHelpResponse() {
	return proxyToolResponse({
		stdout: [
			"Pinano Docker proxy",
			"",
			"Supported commands: run, ps, container ls, logs, stop, rm, exec, inspect.",
			"Containers are limited to this Pinano session and bind mounts are mapped through the active sandbox.",
			"",
		].join("\n"),
	})
}

export function planDockerProxyCommand(payload, context = {}) {
	const argv = payload.argv ?? []
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") return { response: commandHelpResponse() }
	if (argv[0] === "--version" || argv[0] === "version") throw cliError("host Docker version information is not exposed through the Pinano proxy")
	if (argv[0]?.startsWith("-")) throw cliError(`unsupported docker global option: ${optionName(argv[0])}`)

	const command = argv[0]
	if (command === "run") return planDockerRun(["run"], argv.slice(1), payload, context)
	if (command === "ps") return planDockerPs(["ps"], argv.slice(1), context)
	if (command === "logs") return planDockerContainerRefs(["logs"], argv.slice(1), {
		command: "docker logs",
		boolean: LOGS_BOOLEAN_FLAGS,
		value: LOGS_VALUE_FLAGS,
		shortBooleanPattern: /^-[ft]+$/,
	}, context, { exactRefs: 1 })
	if (command === "stop") return planDockerContainerRefs(["stop"], argv.slice(1), {
		command: "docker stop",
		boolean: STOP_BOOLEAN_FLAGS,
		value: STOP_VALUE_FLAGS,
		shortValues: [["-t", "--time"]],
	}, context, { minRefs: 1 })
	if (command === "rm") return planDockerContainerRefs(["rm"], argv.slice(1), {
		command: "docker rm",
		boolean: RM_BOOLEAN_FLAGS,
		value: RM_VALUE_FLAGS,
		shortBooleanPattern: /^-[flv]+$/,
	}, context, { minRefs: 1 })
	if (command === "exec") return planDockerExec(["exec"], argv.slice(1))
	if (command === "inspect") return planDockerContainerRefs(["container", "inspect"], argv.slice(1), {
		command: "docker inspect",
		boolean: INSPECT_BOOLEAN_FLAGS,
		value: INSPECT_VALUE_FLAGS,
		shortValues: [["-f", "--format"]],
	}, context, { minRefs: 1 })

	if (command === "container") {
		const subcommand = argv[1]
		const rest = argv.slice(2)
		if (subcommand === "run") return planDockerRun(["container", "run"], rest, payload, context)
		if (subcommand === "ls" || subcommand === "ps") return planDockerPs(["container", subcommand], rest, context)
		if (subcommand === "logs") return planDockerContainerRefs(["container", "logs"], rest, {
			command: "docker container logs",
			boolean: LOGS_BOOLEAN_FLAGS,
			value: LOGS_VALUE_FLAGS,
			shortBooleanPattern: /^-[ft]+$/,
		}, context, { exactRefs: 1 })
		if (subcommand === "stop") return planDockerContainerRefs(["container", "stop"], rest, {
			command: "docker container stop",
			boolean: STOP_BOOLEAN_FLAGS,
			value: STOP_VALUE_FLAGS,
			shortValues: [["-t", "--time"]],
		}, context, { minRefs: 1 })
		if (subcommand === "rm") return planDockerContainerRefs(["container", "rm"], rest, {
			command: "docker container rm",
			boolean: RM_BOOLEAN_FLAGS,
			value: RM_VALUE_FLAGS,
			shortBooleanPattern: /^-[flv]+$/,
		}, context, { minRefs: 1 })
		if (subcommand === "exec") return planDockerExec(["container", "exec"], rest)
		if (subcommand === "inspect") return planDockerContainerRefs(["container", "inspect"], rest, {
			command: "docker container inspect",
			boolean: INSPECT_BOOLEAN_FLAGS,
			value: INSPECT_VALUE_FLAGS,
			shortValues: [["-f", "--format"]],
		}, context, { minRefs: 1 })
	}

	throw cliError(`unsupported docker command: ${argv.slice(0, 2).filter(Boolean).join(" ") || command}`)
}

function appendLimited(chunks, state, chunk, limit) {
	if (state.bytes >= limit) {
		state.truncated = true
		return
	}
	const remaining = limit - state.bytes
	const buffer = Buffer.from(chunk)
	if (buffer.length <= remaining) {
		chunks.push(buffer)
		state.bytes += buffer.length
		return
	}
	chunks.push(buffer.subarray(0, remaining))
	state.bytes += remaining
	state.truncated = true
}

export function runDockerCli(args, options = {}) {
	const command = options.dockerCommand ?? "docker"
	const maxOutputBytes = options.maxOutputBytes ?? MAX_PROXY_OUTPUT_BYTES
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
		const stdoutChunks = []
		const stderrChunks = []
		const stdoutState = { bytes: 0, truncated: false }
		const stderrState = { bytes: 0, truncated: false }
		child.stdout?.on("data", (chunk) => appendLimited(stdoutChunks, stdoutState, chunk, maxOutputBytes))
		child.stderr?.on("data", (chunk) => appendLimited(stderrChunks, stderrState, chunk, maxOutputBytes))
		child.on("error", (err) => {
			resolve({
				exitCode: 127,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks).length > 0 ? Buffer.concat(stderrChunks) : Buffer.from(err?.message || String(err), "utf-8"),
			})
		})
		child.on("close", (code, signal) => {
			const truncated = stdoutState.truncated || stderrState.truncated
			const suffix = truncated ? Buffer.from("\n[pinano docker proxy: output truncated]\n", "utf-8") : Buffer.alloc(0)
			resolve({
				exitCode: code ?? (signal ? 128 : 1),
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat([...stderrChunks, suffix]),
			})
		})
	})
}

async function inspectContainerLabels(ref, context, runDocker) {
	const result = await runDocker(["container", "inspect", "--format", "{{json .Config.Labels}}", ref])
	if (result.exitCode !== 0) return undefined
	try {
		return JSON.parse(String(result.stdout || "").trim() || "{}")
	} catch {
		return undefined
	}
}

async function assertOwnedContainers(refs = [], context = {}, runDocker = runDockerCli) {
	const expected = dockerOwnerLabels(context)
	for (const ref of refs) {
		const labels = await inspectContainerLabels(ref, context, runDocker)
		if (!labels || Object.entries(expected).some(([name, value]) => labels[name] !== value)) {
			throw cliError(`container is not managed by this Pinano session: ${ref}`)
		}
	}
}

export async function runDockerProxyPayload(payload, context = {}, options = {}) {
	try {
		const plan = planDockerProxyCommand(payload, context)
		if (plan.response) return plan.response
		const runDocker = options.runDocker ?? ((args) => runDockerCli(args, options))
		await assertOwnedContainers(plan.verifyRefs, context, runDocker)
		return proxyToolResponse(await runDocker(plan.args))
	} catch (err) {
		if (err instanceof DockerProxyCliError) return proxyCliErrorResponse(err.message, err.exitCode)
		throw err
	}
}

export async function handleDockerProxyRequest(request, workerContext = undefined, options = {}) {
	if (request.method !== "POST") return internalHttpJsonResponse({ error: "Method Not Allowed" }, 405)
	const payload = parseDockerProxyPayload(parseInternalJsonBody(request))
	const result = await runDockerProxyPayload(payload, {
		sessionId: options.sessionId,
		workerContext,
	}, options)
	return internalHttpJsonResponse(result)
}
