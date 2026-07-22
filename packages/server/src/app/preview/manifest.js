import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const PREVIEW_DIRECTORY_NAME = "previews"
export const PREVIEW_FILE_SUFFIX = ".preview.js"
export const PROJECT_PINANO_DIRNAME = ".pinano"
export const PROJECT_PREVIEW_LOG_DIRNAME = "preview-logs"
export const DEFAULT_PREVIEW_HOST = "127.0.0.1"
export const DEFAULT_PREVIEW_HEALTH_PATH = "/"
export const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 10 * 60 * 1000
export const PREVIEW_AUTHORIZATION_HEADER = "X-Pinano-Preview-Authorization"
export const PREVIEW_LOG_DIRNAME = "previews"
export const PREVIEW_CONTROL_PATH_PREFIX = "/.pinano/preview"
export const PREVIEW_STATUS_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/status`
export const PREVIEW_LOG_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/log`
export const PREVIEW_LOG_PAGE_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/logs`
export const PREVIEW_INJECT_SCRIPT_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/link.js`
export const PREVIEW_FRAME_BRIDGE_SCRIPT_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/frame-bridge.js`
export const PREVIEW_RESTART_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/restart`
export const STATIC_PREVIEW_NAME = "static"
export const PREVIEW_ROOT_KIND_SESSION = "session"
export const PREVIEW_ROOT_KIND_PROJECT = "project"
export const PREVIEW_ROOT_KIND_STATIC = "static"
export const PREVIEW_ROOT_KIND_SOURCE = "source"

const PREVIEW_PUBLIC_HOST_LABEL = "run"
const DEFAULT_PREVIEW_ROUTING_SLUG = "local"
const MAX_PREVIEW_COMMAND_LENGTH = 8192
const PREVIEW_SCOPE_HASH_LENGTH = 16
const MAX_PREVIEW_ROUTING_SLUG_LENGTH = 16
const MAX_PREVIEW_SCOPE_LABEL_LENGTH = PREVIEW_SCOPE_HASH_LENGTH + 2 + MAX_PREVIEW_ROUTING_SLUG_LENGTH
const MAX_PREVIEW_NAME_LENGTH = 63 - 2 - MAX_PREVIEW_SCOPE_LABEL_LENGTH
const PREVIEW_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const PREVIEW_ROUTING_SLUG_RE = PREVIEW_NAME_RE
const MAX_PREVIEW_DESCRIPTION_LENGTH = 512
const PREVIEW_MODULE_TAG = "pinano-preview-module"

const PREVIEW_MODULE_LOADER_SOURCE = [
	"import { readFile } from \"node:fs/promises\"",
	"import { fileURLToPath } from \"node:url\"",
	`const tag = ${JSON.stringify(PREVIEW_MODULE_TAG)}`,
	"const tagged = (url) => { try { return new URL(url).searchParams.has(tag) } catch { return false } }",
	"const relative = (specifier) => specifier.startsWith(\"./\") || specifier.startsWith(\"../\") || specifier.startsWith(\"/\") || specifier.startsWith(\"file:\")",
	"export async function resolve(specifier, context, nextResolve) {",
	"	const result = await nextResolve(specifier, context)",
	"	if (tagged(context.parentURL) && relative(specifier) && result.url.startsWith(\"file:\") && fileURLToPath(result.url).endsWith(\".js\")) {",
	"		const url = new URL(result.url)",
	"		url.searchParams.set(tag, \"1\")",
	"		return { ...result, url: url.href }",
	"	}",
	"	return result",
	"}",
	"export async function load(url, context, nextLoad) {",
	"	if (tagged(url) || (url.startsWith(\"file:\") && fileURLToPath(url).endsWith(\".preview.js\"))) return { format: \"module\", source: await readFile(fileURLToPath(url), \"utf8\"), shortCircuit: true }",
	"	return nextLoad(url, context)",
	"}",
].join("\n")
const PREVIEW_MODULE_LOADER_URL = `data:text/javascript,${encodeURIComponent(PREVIEW_MODULE_LOADER_SOURCE)}`
const PREVIEW_MODULE_REGISTER_SOURCE = [
	"import { register } from \"node:module\"",
	`register(${JSON.stringify(PREVIEW_MODULE_LOADER_URL)}, import.meta.url)`,
].join("\n")
const PREVIEW_MODULE_REGISTER_URL = `data:text/javascript,${encodeURIComponent(PREVIEW_MODULE_REGISTER_SOURCE)}`

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function cleanPreviewName(name, context = "preview name") {
	const value = String(name ?? "").trim()
	if (!value) throw new Error(`${context} is required`)
	if (value.length > MAX_PREVIEW_NAME_LENGTH || !PREVIEW_NAME_RE.test(value)) {
		throw new Error(`${context} must be a lowercase DNS label up to ${MAX_PREVIEW_NAME_LENGTH} characters using letters, numbers, and hyphens`)
	}
	return value
}

function cleanHealthPath(value, context) {
	if (value === undefined || value === null || value === "") return DEFAULT_PREVIEW_HEALTH_PATH
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
		throw new Error(`${context} healthPath must be an absolute path`)
	}
	return value
}

function cleanDescription(value) {
	if (typeof value !== "string") return undefined
	const text = value.trim()
	if (!text || text.includes("\0")) return undefined
	return text.length > MAX_PREVIEW_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_PREVIEW_DESCRIPTION_LENGTH - 3)}...` : text
}

function skipLineComment(text, index) {
	const end = text.indexOf("\n", index + 2)
	return end < 0 ? text.length : end + 1
}

function skipBlockComment(text, index) {
	const end = text.indexOf("*/", index + 2)
	return end < 0 ? text.length : end + 2
}

function skipQuotedString(text, index, quote) {
	for (let i = index + 1; i < text.length; i++) {
		const char = text[i]
		if (char === "\\") {
			i++
			continue
		}
		if (char === quote) return i + 1
	}
	return text.length
}

function skipWhitespaceAndComments(text, index) {
	let i = index
	for (;;) {
		while (i < text.length && /\s/.test(text[i])) i++
		if (text.startsWith("//", i)) {
			i = skipLineComment(text, i)
			continue
		}
		if (text.startsWith("/*", i)) {
			i = skipBlockComment(text, i)
			continue
		}
		return i
	}
}

function isIdentifierPart(char) {
	return /[A-Za-z0-9_$]/.test(char ?? "")
}

function keywordAt(text, index, keyword) {
	return text.startsWith(keyword, index) && !isIdentifierPart(text[index - 1]) && !isIdentifierPart(text[index + keyword.length])
}

function exportDefaultEnd(text) {
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (char === "'" || char === "\"" || char === "`") {
			i = skipQuotedString(text, i, char) - 1
			continue
		}
		if (text.startsWith("//", i)) {
			i = skipLineComment(text, i) - 1
			continue
		}
		if (text.startsWith("/*", i)) {
			i = skipBlockComment(text, i) - 1
			continue
		}
		if (!keywordAt(text, i, "export")) continue
		const defaultIndex = skipWhitespaceAndComments(text, i + "export".length)
		if (keywordAt(text, defaultIndex, "default")) return defaultIndex + "default".length
	}
	return undefined
}

function exportDefaultObjectBody(text) {
	const defaultEnd = exportDefaultEnd(text)
	if (defaultEnd === undefined) return ""
	let i = skipWhitespaceAndComments(text, defaultEnd)
	if (text[i] !== "{") return ""
	const start = i + 1
	let depth = 1
	for (i = start; i < text.length; i++) {
		const char = text[i]
		if (char === "'" || char === "\"" || char === "`") {
			i = skipQuotedString(text, i, char) - 1
			continue
		}
		if (text.startsWith("//", i)) {
			i = skipLineComment(text, i) - 1
			continue
		}
		if (text.startsWith("/*", i)) {
			i = skipBlockComment(text, i) - 1
			continue
		}
		if (char === "{") depth++
		else if (char === "}") {
			depth--
			if (depth === 0) return text.slice(start, i)
		}
	}
	return ""
}

function parseJsStringLiteral(text, index) {
	const quote = text[index]
	if (quote !== "'" && quote !== "\"" && quote !== "`") return undefined
	let value = ""
	for (let i = index + 1; i < text.length; i++) {
		const char = text[i]
		if (char === quote) return { value, end: i + 1 }
		if (char === "\\") {
			const next = text[++i]
			if (next === undefined) return undefined
			if (next === "n") value += "\n"
			else if (next === "r") value += "\r"
			else if (next === "t") value += "\t"
			else value += next
			continue
		}
		if (quote === "`" && char === "$" && text[i + 1] === "{") return undefined
		value += char
	}
	return undefined
}

function parsePropertyName(text, index) {
	const i = skipWhitespaceAndComments(text, index)
	const char = text[i]
	if (char === "'" || char === "\"" || char === "`") {
		const parsed = parseJsStringLiteral(text, i)
		return parsed ? { name: parsed.value, end: parsed.end } : undefined
	}
	if (!/[A-Za-z_$]/.test(char ?? "")) return undefined
	let end = i + 1
	while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++
	return { name: text.slice(i, end), end }
}

function skipObjectPropertyValue(text, index) {
	let depth = 0
	for (let i = skipWhitespaceAndComments(text, index); i < text.length; i++) {
		const char = text[i]
		if (char === "'" || char === "\"" || char === "`") {
			i = skipQuotedString(text, i, char) - 1
			continue
		}
		if (text.startsWith("//", i)) {
			i = skipLineComment(text, i) - 1
			continue
		}
		if (text.startsWith("/*", i)) {
			i = skipBlockComment(text, i) - 1
			continue
		}
		if (char === "(" || char === "[" || char === "{") depth++
		else if (depth > 0 && (char === ")" || char === "]" || char === "}")) depth--
		else if (depth === 0 && char === ",") return i
	}
	return text.length
}

function objectStringProperty(body, name) {
	let i = 0
	while (i < body.length) {
		i = skipWhitespaceAndComments(body, i)
		if (body[i] === ",") {
			i++
			continue
		}
		const property = parsePropertyName(body, i)
		if (!property) {
			i = skipObjectPropertyValue(body, i)
			continue
		}
		i = skipWhitespaceAndComments(body, property.end)
		if (body[i] !== ":") {
			i = skipObjectPropertyValue(body, i)
			continue
		}
		i = skipWhitespaceAndComments(body, i + 1)
		const value = parseJsStringLiteral(body, i)
		if (property.name === name && value) return value.value
		i = skipObjectPropertyValue(body, value?.end ?? i)
	}
	return undefined
}

export function parsePreviewModuleMetadata(text) {
	const body = exportDefaultObjectBody(String(text ?? ""))
	if (!body) return {}
	const description = cleanDescription(objectStringProperty(body, "description"))
	let healthPath = DEFAULT_PREVIEW_HEALTH_PATH
	try {
		healthPath = cleanHealthPath(objectStringProperty(body, "healthPath"), "preview metadata")
	} catch {}
	return {
		...(description ? { description } : {}),
		healthPath,
	}
}

function previewModuleRunnerCommand(path) {
	const script = [
		"const signalExitCode = (signal) => signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1",
		"const requiredEnv = (name) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }",
		"const runShellExec = async (command) => {",
		"	const { spawn } = await import('node:child_process')",
		"	const child = spawn('/bin/sh', ['-lc', command], { stdio: 'inherit', env: process.env })",
		"	const forward = (signal) => { if (!child.killed) child.kill(signal) }",
		"	process.once('SIGINT', () => forward('SIGINT'))",
		"	process.once('SIGTERM', () => forward('SIGTERM'))",
		"	await new Promise((resolve, reject) => {",
		"		child.once('error', reject)",
		"		child.once('exit', (code, signal) => { process.exitCode = signal ? signalExitCode(signal) : code ?? 0; resolve() })",
		"	})",
		"}",
		"const runFunctionExec = async (exec) => {",
		"	const controller = new AbortController()",
		"	const abort = () => controller.abort()",
		"	process.once('SIGINT', abort)",
		"	process.once('SIGTERM', abort)",
		"	await exec({",
		"		host: requiredEnv('PINANO_HOST'),",
		"		port: Number(requiredEnv('PINANO_PORT')),",
		"		publicUrl: process.env.PINANO_PUBLIC_URL || '',",
		"		logPath: process.env.PINANO_PREVIEW_LOG || '',",
		"		signal: controller.signal,",
		"		env: process.env,",
		"	})",
		"}",
		"const { pathToFileURL } = await import('node:url')",
		"const url = new URL(pathToFileURL(process.argv[1]).href)",
		`url.searchParams.set(${JSON.stringify(PREVIEW_MODULE_TAG)}, '1')`,
		"const module = await import(url.href)",
		"const exec = module.default?.exec",
		"if (typeof exec === 'string') {",
		"	const command = exec.trim()",
		"	if (!command) throw new Error('preview module exec string must not be empty')",
		"	await runShellExec(command)",
		"} else if (typeof exec === 'function') {",
		"	await runFunctionExec(exec)",
		"} else {",
		"	throw new Error('preview module default export must include exec as a shell command string or function')",
		"}",
	].join("\n")
	const command = `exec node --import ${shellQuote(PREVIEW_MODULE_REGISTER_URL)} --input-type=module --eval ${shellQuote(script)} ${shellQuote(path)}`
	if (command.length > MAX_PREVIEW_COMMAND_LENGTH) throw new Error(`preview command is too long: ${path}`)
	return command
}

function sourceFileMetadata(path, info) {
	return { path, size: info.size, mtimeMs: Math.floor(info.mtimeMs) }
}

function previewNameFromFilename(filename) {
	if (!filename.endsWith(PREVIEW_FILE_SUFFIX)) return undefined
	const name = filename.slice(0, -PREVIEW_FILE_SUFFIX.length)
	if (!PREVIEW_NAME_RE.test(name) || name.length > MAX_PREVIEW_NAME_LENGTH) return undefined
	return cleanPreviewName(name)
}

function previewNamePart(value) {
	const cleaned = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return cleaned || "preview"
}

export function sourcePreviewScopeId(path) {
	return previewRootScopeId(PREVIEW_ROOT_KIND_SOURCE, path)
}

export function sourcePreviewName(path) {
	const filename = basename(path)
	const stem = filename.endsWith(PREVIEW_FILE_SUFFIX)
		? filename.slice(0, -PREVIEW_FILE_SUFFIX.length)
		: filename
	const hash = sourcePreviewScopeId(path).slice(0, 8)
	const maxBaseLength = Math.max(1, MAX_PREVIEW_NAME_LENGTH - hash.length - 1)
	const base = previewNamePart(stem).slice(0, maxBaseLength).replace(/-+$/g, "") || "preview"
	return cleanPreviewName(`${base}-${hash}`, "preview source name")
}

export async function previewFileDefinitionFromPath(path, options = {}) {
	const resolvedPath = resolve(path)
	if (!basename(resolvedPath).endsWith(PREVIEW_FILE_SUFFIX)) throw new Error(`preview source file must end with ${PREVIEW_FILE_SUFFIX}`)
	const info = await stat(resolvedPath)
	if (!info.isFile()) throw new Error(`preview source is not a file: ${resolvedPath}`)
	const text = await readFile(resolvedPath, "utf-8").catch(() => "")
	const metadata = parsePreviewModuleMetadata(text)
	const name = cleanPreviewName(options.name ?? sourcePreviewName(resolvedPath))
	return {
		name,
		command: previewModuleRunnerCommand(resolvedPath),
		description: metadata.description,
		healthPath: metadata.healthPath ?? DEFAULT_PREVIEW_HEALTH_PATH,
		source: { kind: "preview-js", ...sourceFileMetadata(resolvedPath, info) },
	}
}

async function previewFileEntryDefinition(previewsDir, entry) {
	if (!entry.isFile()) return undefined
	const name = previewNameFromFilename(entry.name)
	if (!name) return undefined
	const path = join(previewsDir, entry.name)
	try {
		return await previewFileDefinitionFromPath(path, { name })
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
		throw err
	}
}

export async function readPreviewDirectory(previewsDir) {
	let entries
	try {
		entries = await readdir(previewsDir, { withFileTypes: true })
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { path: previewsDir, manifest: { previews: {} } }
		throw err
	}
	const previews = {}
	for (const entry of entries) {
		const definition = await previewFileEntryDefinition(previewsDir, entry)
		if (definition) previews[definition.name] = definition
	}
	return { path: previewsDir, manifest: { previews } }
}

export async function readSessionPreviewDefinitions(sessionDir) {
	const { manifest: directory } = await readPreviewDirectory(sessionPreviewDirectory(sessionDir))
	return directory
}

export function sessionPreviewDirectory(sessionDir) {
	return join(sessionDir, PREVIEW_DIRECTORY_NAME)
}

export function projectPreviewDirectory(projectDir) {
	return join(projectDir, PROJECT_PINANO_DIRNAME, PREVIEW_DIRECTORY_NAME)
}

export function projectPreviewLogPath(projectDir, name) {
	return join(projectDir, PROJECT_PINANO_DIRNAME, PROJECT_PREVIEW_LOG_DIRNAME, `${cleanPreviewName(name)}.log`)
}

export async function readProjectPreviewDefinitions(projectDir) {
	const { manifest } = await readPreviewDirectory(projectPreviewDirectory(projectDir))
	return manifest
}

export function previewDefinitionKey(definition) {
	return JSON.stringify({
		command: definition.command,
		healthPath: definition.healthPath,
		source: definition.source,
	})
}

function fileUri(path, params = {}) {
	const url = pathToFileURL(resolve(path))
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value))
	}
	return url.href
}

function cleanPreviewRootUri(rootUri) {
	if (typeof rootUri !== "string" || !rootUri.trim()) throw new Error("preview root URI is required")
	let url
	try {
		url = new URL(rootUri)
	} catch (err) {
		throw Object.assign(new Error("preview root URI must be a valid file URL"), { cause: err })
	}
	if (url.protocol !== "file:") throw new Error("preview root URI must use the file: scheme")
	return url.href
}

export function previewScopeHash(rootUri) {
	const source = cleanPreviewRootUri(rootUri)
	return createHash("sha256")
		.update("pinano-preview-root-v1\0")
		.update(source)
		.digest("hex")
		.slice(0, PREVIEW_SCOPE_HASH_LENGTH)
}

export function previewRootSourceUri(kind, rootPath) {
	const rootKind = String(kind ?? "").trim()
	if (!rootKind) throw new Error("preview root kind is required")
	return fileUri(rootPath, { previewRoot: rootKind })
}

export function previewRootScopeId(kind, rootPath) {
	return previewScopeHash(previewRootSourceUri(kind, rootPath))
}

export function sessionPreviewScopeId(sessionDir) {
	return previewRootScopeId(PREVIEW_ROOT_KIND_SESSION, sessionPreviewDirectory(sessionDir))
}

export function projectPreviewScopeId(projectDir) {
	return previewRootScopeId(PREVIEW_ROOT_KIND_PROJECT, projectPreviewDirectory(projectDir))
}

export function staticPreviewScopeId(rootPath) {
	return previewRootScopeId(PREVIEW_ROOT_KIND_STATIC, rootPath)
}

export function staticPreviewDefinition(rootPath) {
	return {
		name: STATIC_PREVIEW_NAME,
		source: { kind: "static-directory", path: resolve(rootPath) },
	}
}

export function staticPreviewPublicUrl({ publicUrl, rootPath, scopeId, routingSlug, path = "/" }) {
	return previewPublicUrl({
		publicUrl,
		name: STATIC_PREVIEW_NAME,
		scopeId: scopeId ?? staticPreviewScopeId(rootPath),
		routingSlug,
		path,
	})
}

function cleanPreviewScopeId(scopeId) {
	const value = String(scopeId ?? "").trim().toLowerCase()
	if (!/^[a-z0-9]{16}$/.test(value)) throw new Error("preview scope id must be a 16-character lowercase hash")
	return value
}

export function cleanPreviewRoutingSlug(slug = DEFAULT_PREVIEW_ROUTING_SLUG) {
	const value = String(slug ?? "").trim().toLowerCase()
	if (!value || value.length > MAX_PREVIEW_ROUTING_SLUG_LENGTH || !PREVIEW_ROUTING_SLUG_RE.test(value)) {
		throw new Error(`preview routing slug must be a lowercase DNS label up to ${MAX_PREVIEW_ROUTING_SLUG_LENGTH} characters using letters, numbers, and hyphens`)
	}
	return value
}

export function previewRoutingSlugFromSettings(settings) {
	const value = settings?.service?.web?.previewRoutingSlug ?? settings?.service?.web?.routingSlug
	return cleanPreviewRoutingSlug(typeof value === "string" && value ? value : DEFAULT_PREVIEW_ROUTING_SLUG)
}

function previewHostLabel({ name, scopeId, routingSlug }) {
	const label = `${cleanPreviewName(name)}--${cleanPreviewScopeId(scopeId)}--${cleanPreviewRoutingSlug(routingSlug)}`
	if (label.length > 63) throw new Error("preview host label is too long")
	return label
}

export function previewPublicUrl({ publicUrl, name, scopeId, routingSlug, path = "/" }) {
	const base = new URL(publicUrl)
	const scope = cleanPreviewScopeId(scopeId)
	const previewHost = `${previewHostLabel({ name, scopeId: scope, routingSlug })}.${PREVIEW_PUBLIC_HOST_LABEL}.${base.hostname}`
	base.hostname = previewHost
	base.pathname = path
	base.search = ""
	base.hash = ""
	return base.href
}

export function previewPublicUrlPattern({ publicUrl, scopeId, routingSlug, name = "PREVIEW_NAME" }) {
	const base = new URL(publicUrl)
	const scope = scopeId === undefined
		? "PREVIEW_SCOPE"
		: cleanPreviewScopeId(scopeId)
	const route = routingSlug === "PREVIEW_ROUTING" ? routingSlug : cleanPreviewRoutingSlug(routingSlug)
	return `${base.protocol}//${name}--${scope}--${route}.${PREVIEW_PUBLIC_HOST_LABEL}.${base.host}/`
}

export function previewPublicUrlFromSettings(settings) {
	if (settings?.web !== true) return undefined
	const publicUrl = settings?.service?.web?.publicUrl
	return typeof publicUrl === "string" && publicUrl ? publicUrl : undefined
}

export function previewLogPath(sessionDir, name) {
	if (typeof sessionDir !== "string" || !sessionDir) return undefined
	return join(sessionDir, PREVIEW_LOG_DIRNAME, `${cleanPreviewName(name)}.log`)
}

export function previewBasePublicUrl(publicUrl) {
	const base = new URL(publicUrl)
	base.hostname = `${PREVIEW_PUBLIC_HOST_LABEL}.${base.hostname}`
	base.pathname = "/"
	base.search = ""
	base.hash = ""
	return base.href
}

export function matchPreviewHost(hostHeader, publicUrl) {
	if (!publicUrl || !hostHeader) return undefined
	let base
	try {
		base = new URL(publicUrl)
	} catch {
		return undefined
	}
	const host = String(hostHeader).split(":")[0]?.toLowerCase()
	const suffix = `.${PREVIEW_PUBLIC_HOST_LABEL}.${base.hostname.toLowerCase()}`
	if (!host || !host.endsWith(suffix)) return undefined
	const prefix = host.slice(0, -suffix.length)
	if (!prefix || prefix.includes(".")) return undefined
	const separator = prefix.lastIndexOf("--")
	if (separator <= 0) return undefined
	const routingSlug = prefix.slice(separator + 2)
	const scoped = prefix.slice(0, separator)
	const scopeSeparator = scoped.lastIndexOf("--")
	if (scopeSeparator <= 0) return undefined
	const name = scoped.slice(0, scopeSeparator)
	const scopeId = scoped.slice(scopeSeparator + 2)
	if (
		prefix.length > 63
		|| name.length > MAX_PREVIEW_NAME_LENGTH
		|| !PREVIEW_NAME_RE.test(name)
		|| !/^[a-z0-9]{16}$/.test(scopeId)
	) return undefined
	try {
		cleanPreviewRoutingSlug(routingSlug)
	} catch {
		return undefined
	}
	return {
		name,
		scopeId,
		routingSlug,
	}
}
