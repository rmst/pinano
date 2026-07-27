#!/usr/bin/env node

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { INTERNAL_API_BASE_URL_ENV, INTERNAL_API_TOKEN_ENV, PREVIEW_ACCESS_TOKEN_ENV, SESSION_ID_ENV } from "../../../protocol/src/internal-api-env.js"
import { applyProductEnvAliases, readProductEnv } from "../../../protocol/src/product.js"
import { SESSION_BRIDGE_ROUTE } from "../app/session/bridge-protocol.js"
import { PREVIEW_AUTHORIZATION_HEADER } from "../app/preview/manifest.js"
import { CliError, postInternalEvent } from "./worktree-command-utils.js"

const VERSION = "cerex 0.1"
const REQUEST_TIMEOUT_MS = 5000
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 120000

function usage() {
	return `${VERSION}

Usage:
  cerex session [--id <session-id>] get
  cerex session [--id <session-id>] set <property> <value> [<property> <value> ...]
  cerex session lifecycle <needs-input|ready-for-review>
  cerex session [--id <session-id>] cat [<entry>|<from>:<to>] [--full]
  cerex sessions [--state <state>] [--since <time>] [--limit <n>]
  cerex sessions cat (--all | --state <state> | --since <time> | --limit <n>) [--full]
  cerex project
  cerex project get
  cerex project set <name>
  cerex preview

Without --id, cerex session reads the target session id from $${SESSION_ID_ENV}.
Lifecycle updates are current-session-only and are accepted only during automated worktree lifecycle maintenance.
cerex sessions lists visible sessions. cerex sessions cat concatenates visible transcripts for a filtered collection.

Project commands update project metadata for the current session's project directory.

Always use cerex preview when trying to expose, inspect, or verify a web server, web app, docs server, or static HTML preview for the user. It prints configured preview names, scopes, concrete URLs, source files, and log paths; use the printed URLs instead of constructing preview hostnames.

Static document sites:
  - A project's .cerex/docs/ directory is the root of its built-in document site.
  - Automatically listed static sites use .cerex/previews/<name>.preview.json with { "root": "project/relative/directory", "entry": "optional/start/path", "description": "optional text" }.
  - A *.preview.json file elsewhere in the project can be empty or contain the same optional properties. root defaults to its containing directory when omitted; an explicit root is always project-relative.
  - The filename supplies the automatically listed preview name. Static roots must be non-symlinked project subdirectories; entry defaults to the directory index.
  - HTML is served directly, Markdown is rendered, and other files are served unchanged as assets.
  - A supported index.html, index.htm, or index.md adds the docs project preview automatically; no preview module or process is required.
  - Nested directories use the same index files. URLs otherwise map to exact files; bracketed names have no routing semantics.
  - Local links within a static root stay in its site. Local links elsewhere in the project open in the workbench; local links outside the project are rejected.

Preview modules:
  - Project previews live under .cerex/previews/<name>.preview.js.
  - Temporary session previews live under $CEREX_SESSION_DIR/previews/<name>.preview.js.
  - Preview modules are ES modules that export default { exec, description?, healthPath? }.
  - exec is required. It may be a shell command string or a JS function.
  - Shell exec strings run in the owning session cwd with CEREX_HOST, CEREX_PORT, CEREX_PUBLIC_URL, and CEREX_PREVIEW_LOG.
  - JS exec functions are called as exec({ host, port, publicUrl, logPath, signal, env }).
  - The preview must listen on host:port or $CEREX_HOST:$CEREX_PORT.
  - After writing a preview module, run cerex preview and give the printed URL to the user.

Properties:
  description  short stable UI label
  project-dir  absolute project identity directory; prefer Git root; null clears
  cwd          absolute working directory for subsequent tool calls
  environment  configured environment id for subsequent tool calls

Multiple properties may be updated in one call by repeating property/value pairs.
Quote multi-word values.

Options:
  --state <state>  filter sessions by state (ready-for-review, completed, deferred, running)
  --since <time>   filter sessions updated since an ISO timestamp or duration like 24h, 7d, 30m
  --limit <n>      limit collection commands to the newest n matching sessions
  --all            explicitly allow cerex sessions cat to read all visible sessions
  --full           include complete tool calls and results in transcript exports
  -h, --help   show this help
  --version    show version
`
}

function previewUsage() {
	return `${VERSION}

Usage:
  cerex preview

Always use cerex preview when trying to expose, inspect, or verify a web server, web app, docs server, or static HTML preview for the user. It prints configured preview names, scopes, concrete URLs, source files, and log paths; use the printed URLs instead of constructing preview hostnames.

Static document sites:
  - A project's .cerex/docs/ directory is the root of its built-in document site.
  - Automatically listed static sites use .cerex/previews/<name>.preview.json with { "root": "project/relative/directory", "entry": "optional/start/path", "description": "optional text" }.
  - A *.preview.json file elsewhere in the project can be empty or contain the same optional properties. root defaults to its containing directory when omitted; an explicit root is always project-relative.
  - The filename supplies the automatically listed preview name. Static roots must be non-symlinked project subdirectories; entry defaults to the directory index.
  - HTML is served directly, Markdown is rendered, and other files are served unchanged as assets.
  - A supported index.html, index.htm, or index.md adds the docs project preview automatically; no preview module or process is required.
  - Nested directories use the same index files. URLs otherwise map to exact files; bracketed names have no routing semantics.
  - Local links within a static root stay in its site. Local links elsewhere in the project open in the workbench; local links outside the project are rejected.

Preview modules:
  - Project previews live under .cerex/previews/<name>.preview.js.
  - Temporary session previews live under $CEREX_SESSION_DIR/previews/<name>.preview.js.
  - Preview modules are ES modules that export default { exec, description?, healthPath? }.
  - exec is required. It may be a shell command string or a JS function.
  - Shell exec strings run in the owning session cwd with CEREX_HOST, CEREX_PORT, CEREX_PUBLIC_URL, and CEREX_PREVIEW_LOG.
  - JS exec functions are called as exec({ host, port, publicUrl, logPath, signal, env }).
  - The preview must listen on host:port or $CEREX_HOST:$CEREX_PORT.
  - Cerex starts each preview lazily on first request and writes stdout/stderr to CEREX_PREVIEW_LOG.
  - After writing or changing a preview module, run cerex preview and give the printed URL to the user.

Output columns:
  name<TAB>scope<TAB>url<TAB>source<TAB>log

Preview access:
  - To inspect a printed preview URL yourself from a Cerex tool session, request it with Authorization: Bearer $${PREVIEW_ACCESS_TOKEN_ENV}.
  - If the previewed app itself needs an Authorization header, send that app header as ${PREVIEW_AUTHORIZATION_HEADER}; Cerex forwards it after preview access is authenticated.
  - This token is only for Cerex preview access; do not print its value, write it into files, or include it in user-facing messages.

Options:
  -h, --help  show this help
`
}

function transcriptUsage() {
	return `${VERSION}

Usage:
  cerex session [--id <session-id>] cat [<entry>|<from>:<to>] [--full]
  cerex sessions cat (--all | --state <state> | --since <time> | --limit <n>) [--full]

Print visible transcript branches as tab-separated lines:
  session-id  entry  timestamp  kind  text

Entry numbers are stable, session-local, positive integers and may have gaps. Multiline content uses multiple rows with the same entry number. A selector prints one entry or an inclusive range.

By default, user and assistant text is complete. Consecutive tool calls and results collapse into a tools row with counts and a range to inspect. --full expands every tool call and result.

Examples:
  cerex session cat
  cerex sessions cat --since 60d | rg -i compaction
  cerex session --id <session-id> cat 42
  cerex session --id <session-id> cat 40:45
  cerex session --id <session-id> cat 42 --full

Options:
  --full       include complete tool calls and results
  -h, --help   show this help
`
}

function helpForConfig(config) {
	if (config.helpTopic === "preview") return previewUsage()
	if (config.helpTopic === "transcript") return transcriptUsage()
	return usage()
}

function sessionIdFromEnv(env) {
	const sessionId = String(env[SESSION_ID_ENV] ?? "").trim()
	if (!sessionId) throw new CliError(`${SESSION_ID_ENV} is not set`, 2)
	return sessionId
}

function targetSessionId(target, env) {
	if (target === undefined) return sessionIdFromEnv(env)
	const sessionId = String(target ?? "").trim()
	if (!sessionId) throw new CliError("session id is required", 2)
	return sessionId
}

function normalizeLifecycleState(value) {
	const state = String(value ?? "").trim()
	if (state === "ready-for-review" || state === "ready_for_review" || state === "readyForReview") return "readyForReview"
	if (state === "needs-input" || state === "needs_input") return "needs_input"
	throw new CliError("lifecycle state must be one of needs-input, ready-for-review", 2)
}

function oneValue(values, label) {
	if (values.length !== 1) throw new CliError(`${label} expects exactly one value`, 2)
	return values[0]
}

function atLeastOneValue(values, label) {
	if (values.length < 1) throw new CliError(`${label} expects a value`, 2)
	return values
}

function patchForSet(property, values) {
	if (property === "description") return { descriptionInUi: atLeastOneValue(values, property).join(" ") }
	if (property === "project-dir") {
		const value = oneValue(values, property)
		return { projectDir: value === "null" ? null : value }
	}
	if (property === "cwd") return { cwd: oneValue(values, property) }
	if (property === "environment") return { environmentId: oneValue(values, property) }
	throw new CliError(`unknown session property: ${property}`, 2)
}

const SESSION_SET_PROPERTIES = ["description", "project-dir", "cwd", "environment"]
const SESSION_SET_PROPERTY_SET = new Set(SESSION_SET_PROPERTIES)

function previewAccessInstructions() {
	return `\nAgent access:\n  Request printed preview URLs with \`Authorization: Bearer $${PREVIEW_ACCESS_TOKEN_ENV}\`.\n  If the previewed app itself needs an Authorization header, send that app header as \`${PREVIEW_AUTHORIZATION_HEADER}\`.\n  Do not print the token value, write it into files, or include it in user-facing messages.\n`
}

function parseSetPatch(args) {
	if (args.length < 2) throw new CliError("session set requires <property> <value>", 2)
	let index = 0
	const patch = {}
	while (index < args.length) {
		const property = args[index++]
		if (!SESSION_SET_PROPERTY_SET.has(property)) throw new CliError(`unknown session property: ${property}`, 2)
		const valueStart = index
		while (index < args.length && !SESSION_SET_PROPERTY_SET.has(args[index])) index++
		Object.assign(patch, patchForSet(property, args.slice(valueStart, index)))
	}
	return patch
}

function parseSessionOptions(args, index) {
	let target
	while (index < args.length) {
		const arg = args[index]
		if (arg === "-h" || arg === "--help") break
		if (arg === "--id") {
			if (target !== undefined) throw new CliError("--id may only be supplied once", 2)
			if (index + 1 >= args.length) throw new CliError("--id requires a session id", 2)
			target = args[index + 1]
			index += 2
			continue
		}
		if (arg.startsWith("--id=")) {
			if (target !== undefined) throw new CliError("--id may only be supplied once", 2)
			target = arg.slice("--id=".length)
			index += 1
			continue
		}
		if (arg.startsWith("-")) throw new CliError(`unsupported session option: ${arg}`, 2)
		break
	}
	return { target, index }
}

function parsePositiveInteger(value, option) {
	if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) throw new CliError(`${option} expects a positive integer`, 2)
	return Number(value)
}

function readOptionValue(args, index, option) {
	if (index + 1 >= args.length) throw new CliError(`${option} requires a value`, 2)
	return [args[index + 1], index + 2]
}

function parseSessionsOptions(args, index) {
	const filters = {}
	let all = false
	let full = false
	while (index < args.length) {
		const arg = args[index]
		if (arg === "-h" || arg === "--help") break
		if (arg === "--all") {
			all = true
			index++
		} else if (arg === "--full") {
			full = true
			index++
		} else if (arg === "--state") {
			const [value, next] = readOptionValue(args, index, "--state")
			filters.state = value
			index = next
		} else if (arg.startsWith("--state=")) {
			filters.state = arg.slice("--state=".length)
			index++
		} else if (arg === "--since") {
			const [value, next] = readOptionValue(args, index, "--since")
			filters.since = value
			index = next
		} else if (arg.startsWith("--since=")) {
			filters.since = arg.slice("--since=".length)
			index++
		} else if (arg === "--limit") {
			const [value, next] = readOptionValue(args, index, "--limit")
			filters.limit = parsePositiveInteger(value, "--limit")
			index = next
		} else if (arg.startsWith("--limit=")) {
			filters.limit = parsePositiveInteger(arg.slice("--limit=".length), "--limit")
			index++
		} else if (arg.startsWith("-")) {
			throw new CliError(`unsupported sessions option: ${arg}`, 2)
		} else {
			break
		}
	}
	return { all, filters, full, index }
}

function sessionsCatIsScoped(config) {
	return config.all || config.filters.state !== undefined || config.filters.since !== undefined || config.filters.limit !== undefined
}

function parseTranscriptSelector(value) {
	const match = String(value ?? "").match(/^([1-9][0-9]*)(?::([1-9][0-9]*))?$/)
	if (!match) throw new CliError("transcript selector must be a positive entry number or inclusive range such as 40:45", 2)
	const from = Number(match[1])
	const to = Number(match[2] ?? match[1])
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
		throw new CliError("transcript selector must be a valid ascending range", 2)
	}
	return { from, to }
}

function parseCatOptions(args, index, label) {
	let full = false
	let entries
	while (index < args.length) {
		const arg = args[index]
		if (arg === "-h" || arg === "--help") return { help: true, index }
		if (arg === "--full") {
			full = true
			index++
			continue
		}
		if (arg.startsWith("-")) throw new CliError(`unsupported ${label} option: ${arg}`, 2)
		if (entries) throw new CliError(`${label} accepts at most one entry selector`, 2)
		entries = parseTranscriptSelector(arg)
		index++
	}
	return { full, entries, index }
}

export function parseArgs(args) {
	if (args.length === 0) throw new CliError("missing command", 2)
	if (args[0] === "-h" || args[0] === "--help") return { help: true }
	if (args[0] === "--version") return { version: true }
	if (args[0] === "project") {
		const command = args[1] ?? "get"
		if (command === "-h" || command === "--help") return { help: true }
		if (command === "get") {
			if (args.length > 2) throw new CliError("project get does not take arguments", 2)
			return { namespace: "project", operation: "get" }
		}
		if (command === "set") {
			if (args.length < 3) throw new CliError("project set requires <name>", 2)
			return { namespace: "project", operation: "set", name: args.slice(2).join(" ") }
		}
		throw new CliError(`unknown project command: ${command || ""}`.trim(), 2)
	}
	if (args[0] === "preview") {
		if (args[1] === "-h" || args[1] === "--help") return { help: true, helpTopic: "preview" }
		if (args.length > 1) throw new CliError("cerex preview does not take arguments", 2)
		return { namespace: "preview", operation: "list" }
	}
	if (args[0] === "sessions") {
		const command = args[1] === "cat" ? "cat" : "list"
		const optionStart = command === "cat" ? 2 : 1
		const parsed = parseSessionsOptions(args, optionStart)
		if (args[parsed.index] === "-h" || args[parsed.index] === "--help") {
			return { help: true, ...(command === "cat" ? { helpTopic: "transcript" } : {}) }
		}
		if (parsed.index < args.length) throw new CliError(`unexpected sessions argument: ${args[parsed.index]}`, 2)
		const config = { namespace: "sessions", operation: command, filters: parsed.filters, all: parsed.all, ...(parsed.full ? { full: true } : {}) }
		if (command === "list" && config.all) throw new CliError("--all is only supported with sessions cat", 2)
		if (command === "list" && config.full) throw new CliError("--full is only supported with transcript cat", 2)
		if (command === "cat" && !sessionsCatIsScoped(config)) throw new CliError("sessions cat requires --all, --state, --since, or --limit", 2)
		return config
	}
	if (args[0] !== "session") throw new CliError(`unknown command: ${args[0]}`, 2)
	const sessionOptions = parseSessionOptions(args, 1)
	const command = args[sessionOptions.index]
	if (command === "-h" || command === "--help") return { help: true }
	if (command === "get") {
		if (args.length !== sessionOptions.index + 1) throw new CliError("session get does not take arguments; use --id to target another session", 2)
		return { namespace: "session", operation: "get", target: sessionOptions.target }
	}
	if (command === "set") {
		if (args.length < sessionOptions.index + 3) throw new CliError("session set requires <property> <value>", 2)
		return { namespace: "session", operation: "set", target: sessionOptions.target, patch: parseSetPatch(args.slice(sessionOptions.index + 1)) }
	}
	if (command === "lifecycle") {
		if (sessionOptions.target !== undefined) throw new CliError("session lifecycle cannot target another session", 2)
		if (args.length !== sessionOptions.index + 2) throw new CliError("session lifecycle requires <needs-input|ready-for-review>", 2)
		return { namespace: "session", operation: "lifecycle", target: sessionOptions.target, state: normalizeLifecycleState(args[sessionOptions.index + 1]) }
	}
	if (command === "cat") {
		const parsed = parseCatOptions(args, sessionOptions.index + 1, "session cat")
		if (parsed.help) return { help: true, helpTopic: "transcript" }
		return {
			namespace: "session",
			operation: "cat",
			target: sessionOptions.target,
			...(parsed.entries ? { entries: parsed.entries } : {}),
			...(parsed.full ? { full: true } : {}),
		}
	}
	throw new CliError(`unknown session command: ${command || ""}`.trim(), 2)
}

function responseError(response) {
	const bodyError = response?.body && typeof response.body.error === "string" ? response.body.error : undefined
	return bodyError || response?.text || "Cerex bridge request failed"
}

function changedPropertyNames(write) {
	return Object.keys(write?.changed ?? {})
}

function unchangedPropertyNames(write) {
	return Object.keys(write?.unchanged ?? {})
}

function formatSetResult(body = {}) {
	const write = body.write
	if (!write || typeof write !== "object") return "Session properties updated.\n"
	const changed = changedPropertyNames(write)
	const unchanged = unchangedPropertyNames(write)
	const lines = [write.noChange || changed.length === 0 ? "No session properties changed." : "Session properties updated."]
	if (unchanged.length > 0) {
		const prefix = changed.length === 0
			? "Warning: this cerex session set command was unnecessary because all supplied fields were unchanged"
			: "Warning: unchanged fields were included and should be omitted next time"
		lines.push(`${prefix}: ${unchanged.join(", ")}.`)
	}
	return `${lines.join("\n")}\n`
}

function formatLifecycleResult(body = {}) {
	const write = body.write
	if (!write || typeof write !== "object") return "Session lifecycle updated.\n"
	return write.noChange ? "No session lifecycle changed.\n" : "Session lifecycle updated.\n"
}

function formatProjectSource(source) {
	if (source === "project-json") return "project metadata"
	if (source === "path") return "project directory"
	return source ?? "unknown"
}

function formatProjectResult(body = {}, operation = "get") {
	const project = body.project ?? {}
	const lines = []
	if (operation === "set") lines.push(body.changed === false ? "No project metadata changed." : "Project metadata updated.")
	lines.push(`Project: ${project.label ?? "?"}`)
	lines.push(`Source: ${formatProjectSource(project.source)}`)
	if (project.missingProjectMetadata) lines.push("Metadata missing: yes")
	return `${lines.join("\n")}\n`
}

function formatPreviewListResult(body = {}) {
	const previews = Array.isArray(body.previews) ? body.previews : []
	if (previews.length === 0) return "No previews configured.\n"
	return `${previews.map((preview) => [
		preview.name ?? "?",
		preview.scope ?? "?",
		preview.publicUrl ?? "(no public URL)",
		preview.source?.path ?? "",
		preview.logPath ?? "",
	].join("\t")).join("\n")}\n`
}

function sessionIdsFromCollectionText(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line ? line.split("\t", 1)[0] : "")
		.filter((id) => id !== "")
}

async function writeStream(stream, text) {
	if (!text) return
	if (stream.write(text)) return
	await new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.removeListener("drain", onDrain)
			stream.removeListener("error", onError)
		}
		const onDrain = () => {
			cleanup()
			resolve(undefined)
		}
		const onError = (err) => {
			cleanup()
			reject(err)
		}
		stream.once("drain", onDrain)
		stream.once("error", onError)
	})
}

async function writeStdout(text) {
	return writeStream(process.stdout, text)
}

async function writeStderr(text) {
	return writeStream(process.stderr, text)
}

async function bridgeRequest(env, body, options = {}) {
	if (!env[INTERNAL_API_BASE_URL_ENV] || !env[INTERNAL_API_TOKEN_ENV]) {
		throw new CliError("cerex bridge commands must be run from a Cerex tool session")
	}
	const response = await postInternalEvent(env[INTERNAL_API_BASE_URL_ENV], env[INTERNAL_API_TOKEN_ENV], SESSION_BRIDGE_ROUTE, body, { timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS })
	if (!response.ok) throw new CliError(responseError(response), response.status >= 400 && response.status < 500 ? 2 : 1)
	return response.body ?? {}
}

export function requestTimeoutMsForConfig(config) {
	if (config.namespace === "sessions" && config.operation === "cat") return TRANSCRIPT_REQUEST_TIMEOUT_MS
	if (config.namespace === "session" && config.operation === "cat") return TRANSCRIPT_REQUEST_TIMEOUT_MS
	return REQUEST_TIMEOUT_MS
}

export async function runAgentCommand(config, options = {}) {
	const env = applyProductEnvAliases({ ...(options.env ?? process.env) })
	if (config.namespace === "sessions") {
		const sessionId = sessionIdFromEnv(env)
		const listBody = await bridgeRequest(env, {
			version: 1,
			operation: "sessions.list",
			sessionId,
			filters: config.filters,
			all: config.all,
		}, { timeoutMs: config.operation === "cat" ? REQUEST_TIMEOUT_MS : requestTimeoutMsForConfig(config) })
		if (config.operation === "list") {
			await writeStdout(listBody.text ?? "")
			return listBody
		}
		const ids = sessionIdsFromCollectionText(listBody.text)
		for (const id of ids) {
			const body = await bridgeRequest(env, {
				version: 1,
				operation: "session.cat",
				sessionId: id,
				...(config.full ? { full: true } : {}),
			}, { timeoutMs: TRANSCRIPT_REQUEST_TIMEOUT_MS })
			await writeStdout(body.text ?? "")
		}
		return { ok: true, sessions: ids.length }
	}
	if (config.namespace === "project") {
		const sessionId = sessionIdFromEnv(env)
		const body = await bridgeRequest(env, {
			version: 1,
			operation: config.operation === "set" ? "project.set" : "project.get",
			sessionId,
			...(config.operation === "set" ? { name: config.name, toolCallId: readProductEnv(env, "TOOL_CALL_ID") || undefined } : {}),
		})
		await writeStdout(formatProjectResult(body, config.operation))
		return body
	}
	if (config.namespace === "preview") {
		const sessionId = sessionIdFromEnv(env)
		const body = await bridgeRequest(env, {
			version: 1,
			operation: "preview.list",
			sessionId,
		})
		await writeStdout(formatPreviewListResult(body))
		await writeStderr(previewAccessInstructions())
		return body
	}
	const sessionId = targetSessionId(config.target, env)
	if (config.operation === "get") {
		const body = await bridgeRequest(env, { version: 1, operation: "session.get", sessionId })
		await writeStdout(`${JSON.stringify(body.session ?? body, null, "\t")}\n`)
		return body
	}
	if (config.operation === "set") {
		const body = await bridgeRequest(env, {
			version: 1,
			operation: "session.set",
			sessionId,
			patch: config.patch,
			toolCallId: readProductEnv(env, "TOOL_CALL_ID") || undefined,
		})
		await writeStdout(formatSetResult(body))
		return body
	}
	if (config.operation === "lifecycle") {
		const body = await bridgeRequest(env, {
			version: 1,
			operation: "session.lifecycle",
			sessionId,
			state: config.state,
			toolCallId: readProductEnv(env, "TOOL_CALL_ID") || undefined,
		})
		await writeStdout(formatLifecycleResult(body))
		return body
	}
	if (config.operation === "cat") {
		const body = await bridgeRequest(env, {
			version: 1,
			operation: "session.cat",
			sessionId,
			...(config.entries ? { entries: config.entries } : {}),
			...(config.full ? { full: true } : {}),
		}, { timeoutMs: requestTimeoutMsForConfig(config) })
		await writeStdout(body.text ?? "")
		return body
	}
	throw new CliError("unsupported command", 2)
}

export async function main(argv = process.argv.slice(2), options = {}) {
	try {
		const config = parseArgs(argv)
		if (config.version) {
			await writeStdout(`${VERSION}\n`)
			return 0
		}
		if (config.help) {
			await writeStdout(helpForConfig(config))
			return 0
		}
		await runAgentCommand(config, options)
		return 0
	} catch (err) {
		process.stderr.write(`${err?.message ?? String(err)}\n`)
		return err?.exitCode ?? 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main()
}
