import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import { cleanupLegacyProjectStateDirectory, ensureProjectStateDirectoryIgnored, initializeProjectPreviewDirectoryIgnore, LEGACY_PROJECT_STATE_DIRNAME, PROJECT_STATE_DIRNAME } from "../project/labels.js"
import { projectDocumentsDirectory } from "../project/documents.js"

export const PREVIEW_DIRECTORY_NAME = "previews"
export const PREVIEW_FILE_SUFFIX = ".preview.json"
export const PREVIEW_LOG_DIRECTORY_NAME = "logs"
export const DEFAULT_PREVIEW_HOST = "127.0.0.1"
export const DEFAULT_PREVIEW_HEALTH_PATH = "/"
export const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_PREVIEW_STARTUP_TIMEOUT_MS = 30 * 1000
export const PREVIEW_AUTHORIZATION_HEADER = "X-Cerex-Preview-Authorization"
export const LEGACY_PREVIEW_AUTHORIZATION_HEADER = "X-Pinano-Preview-Authorization"
export const PREVIEW_CONTROL_PATH_PREFIX = "/.cerex/preview"
export const LEGACY_PREVIEW_CONTROL_PATH_PREFIX = "/.pinano/preview"
export const PREVIEW_STATUS_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/status`
export const PREVIEW_LOG_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/log`
export const PREVIEW_LOG_PAGE_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/logs`
export const PREVIEW_INJECT_SCRIPT_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/link.js`
export const PREVIEW_FRAME_BRIDGE_SCRIPT_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/frame-bridge.js`
export const PREVIEW_OPEN_DOCUMENT_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/open-document`
export const PREVIEW_RESTART_PATH = `${PREVIEW_CONTROL_PATH_PREFIX}/restart`
export const STATIC_PREVIEW_NAME = "docs"
export const PREVIEW_ROOT_KIND_SESSION = "session"
export const PREVIEW_ROOT_KIND_PROJECT = "project"
export const PREVIEW_ROOT_KIND_STATIC = "static"
export const PREVIEW_ROOT_KIND_SOURCE = "source"

const PREVIEW_PUBLIC_HOST_LABEL = "run"
const DEFAULT_PREVIEW_ROUTING_SLUG = "local"
const PREVIEW_SCOPE_HASH_LENGTH = 16
const MAX_PREVIEW_ROUTING_SLUG_LENGTH = 16
const MAX_PREVIEW_SCOPE_LABEL_LENGTH = PREVIEW_SCOPE_HASH_LENGTH + 2 + MAX_PREVIEW_ROUTING_SLUG_LENGTH
const MAX_PREVIEW_NAME_LENGTH = 63 - 2 - MAX_PREVIEW_SCOPE_LABEL_LENGTH
const PREVIEW_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const PREVIEW_ROUTING_SLUG_RE = PREVIEW_NAME_RE
const MAX_PREVIEW_DESCRIPTION_LENGTH = 512
const MAX_PREVIEW_COMMAND_LENGTH = 32 * 1024
const ROUTE_PARAMETER_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const projectPreviewMigrations = new Map()

function isProperPathWithin(rootPath, candidatePath) {
	const path = relative(rootPath, candidatePath)
	return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function cleanRelativePath(value, context, options = {}) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty project-relative path`)
	const path = value.trim()
	if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) throw new Error(`${context} must be a project-relative path`)
	const parts = path.split("/").filter((part) => part && part !== ".")
	if (parts.length === 0) {
		if (options.allowRoot === true) return "."
		throw new Error(`${context} must resolve below its base directory`)
	}
	if (parts.some((part) => part === "..")) throw new Error(`${context} must stay within its base directory`)
	return parts.join("/")
}

function projectRelativePath(projectDir, value, context) {
	const path = cleanRelativePath(value, context)
	const resolvedPath = resolve(projectDir, path)
	if (!isProperPathWithin(resolve(projectDir), resolvedPath)) throw new Error(`${context} must stay within the project directory`)
	return { path, resolvedPath }
}

function cleanUrlPath(value, context, defaultValue = "/") {
	if (value === undefined) return defaultValue
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\0") || value.includes("?") || value.includes("#")) {
		throw new Error(`${context} must be an absolute URL path without a query or fragment`)
	}
	return value
}

function staticPreviewEntryPath(value, context) {
	if (value === undefined) return undefined
	const { path } = projectRelativePath("/preview-root", value, `${context} entry`)
	return `/${path.split("/").map(encodeURIComponent).join("/")}`
}

function cleanDescription(value, context) {
	if (value === undefined) return undefined
	if (typeof value !== "string") throw new Error(`${context} description must be a string`)
	const text = value.trim()
	if (!text || text.includes("\0")) return undefined
	return text.length > MAX_PREVIEW_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_PREVIEW_DESCRIPTION_LENGTH - 3)}...` : text
}

function assertOnlyProperties(value, supported, context) {
	const unknown = Object.keys(value).filter((key) => !supported.has(key))
	if (unknown.length > 0) throw new Error(`${context} has unsupported ${unknown.length === 1 ? "property" : "properties"}: ${unknown.join(", ")}`)
}

function cleanCommand(value, context) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${context} command must be a non-empty string`)
	const command = value.trim()
	if (command.length > MAX_PREVIEW_COMMAND_LENGTH) throw new Error(`${context} command is too long`)
	return command
}

function routeParameters(path, context) {
	const names = []
	const parts = path === "/" ? [] : path.slice(1).split("/")
	for (const [index, part] of parts.entries()) {
		if (!part.startsWith(":") && !part.startsWith("*")) continue
		const name = part.slice(1)
		if (!ROUTE_PARAMETER_RE.test(name)) throw new Error(`${context} has an invalid route parameter: ${part}`)
		if (names.includes(name)) throw new Error(`${context} repeats route parameter ${name}`)
		if (part.startsWith("*") && index !== parts.length - 1) throw new Error(`${context} wildcard parameter ${part} must be the final segment`)
		names.push(name)
	}
	return names
}

function cleanRouteSourceMapping(mapping, projectDir, context) {
	if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error(`${context} must be an object`)
	assertOnlyProperties(mapping, new Set(["route", "source"]), context)
	const routePath = cleanUrlPath(mapping.route, `${context} route`)
	const route = routePath === "/" ? routePath : routePath.replace(/\/+$/, "")
	const names = routeParameters(route, context)
	const source = projectRelativePath(projectDir, mapping.source, `${context} source`).path
	const placeholders = [...source.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])
	if (source.replace(/\{[^{}]+\}/g, "").includes("{") || source.replace(/\{[^{}]+\}/g, "").includes("}")) throw new Error(`${context} source has an invalid placeholder`)
	if (source.split("/").some((part) => [...part.matchAll(/\{[^{}]+\}/g)].length > 1)) {
		throw new Error(`${context} source must not contain multiple route parameters in one path segment`)
	}
	for (const placeholder of placeholders) {
		if (!names.includes(placeholder)) throw new Error(`${context} source uses unknown route parameter ${placeholder}`)
	}
	for (const name of names) {
		const occurrences = placeholders.filter((candidate) => candidate === name).length
		if (occurrences !== 1) throw new Error(`${context} source must contain route parameter {${name}} exactly once`)
	}
	return { route, source }
}

function cleanRouteSourceMap(value, projectDir, context) {
	if (value === undefined) return undefined
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} routeSourceMap must be a non-empty array`)
	const mappings = value.map((mapping, index) => cleanRouteSourceMapping(mapping, projectDir, `${context} routeSourceMap[${index}]`))
	const duplicateRoute = mappings.find((mapping, index) => mappings.findIndex((candidate) => candidate.route === mapping.route) !== index)
	if (duplicateRoute) throw new Error(`${context} routeSourceMap repeats route ${duplicateRoute.route}`)
	const duplicateSource = mappings.find((mapping, index) => mappings.findIndex((candidate) => candidate.source === mapping.source) !== index)
	if (duplicateSource) throw new Error(`${context} routeSourceMap repeats source ${duplicateSource.source}`)
	return mappings
}

function cleanProcessTarget(target, context) {
	assertOnlyProperties(target, new Set(["kind", "command", "cwd", "entry", "health"]), `${context} target`)
	return {
		command: cleanCommand(target.command, `${context} target`),
		cwd: target.cwd === undefined ? "." : cleanRelativePath(target.cwd, `${context} target cwd`, { allowRoot: true }),
		entryPath: cleanUrlPath(target.entry, `${context} target entry`),
		healthPath: cleanUrlPath(target.health, `${context} target health`, DEFAULT_PREVIEW_HEALTH_PATH),
	}
}

function cleanStaticTarget(target, projectDir, context) {
	assertOnlyProperties(target, new Set(["kind", "root", "entry"]), `${context} target`)
	const rootPath = projectRelativePath(projectDir, target.root, `${context} target root`).resolvedPath
	if (rootPath === projectDocumentsDirectory(projectDir)) throw new Error(`${context} target root is reserved for the built-in docs preview`)
	const statePath = resolve(dirname(projectPreviewDirectory(projectDir)))
	if (rootPath === statePath || isProperPathWithin(statePath, rootPath)) throw new Error(`${context} target root must not expose the project state directory`)
	return {
		rootPath,
		entryPath: staticPreviewEntryPath(target.entry, `${context} target`),
	}
}

export function cleanPreviewName(name, context = "preview name") {
	const value = String(name ?? "").trim()
	if (!value) throw new Error(`${context} is required`)
	if (value.length > MAX_PREVIEW_NAME_LENGTH || !PREVIEW_NAME_RE.test(value)) {
		throw new Error(`${context} must be a lowercase DNS label up to ${MAX_PREVIEW_NAME_LENGTH} characters using letters, numbers, and hyphens`)
	}
	return value
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
	const stem = filename.endsWith(PREVIEW_FILE_SUFFIX) ? filename.slice(0, -PREVIEW_FILE_SUFFIX.length) : filename
	const hash = sourcePreviewScopeId(path).slice(0, 8)
	const maxBaseLength = Math.max(1, MAX_PREVIEW_NAME_LENGTH - hash.length - 1)
	const base = previewNamePart(stem).slice(0, maxBaseLength).replace(/-+$/g, "") || "preview"
	return cleanPreviewName(`${base}-${hash}`, "preview source name")
}

export async function previewFileDefinitionFromPath(path, options = {}) {
	const resolvedPath = resolve(path)
	if (!basename(resolvedPath).endsWith(PREVIEW_FILE_SUFFIX)) throw new Error(`preview definition must end with ${PREVIEW_FILE_SUFFIX}`)
	const info = await stat(resolvedPath)
	if (!info.isFile()) throw new Error(`preview definition is not a file: ${resolvedPath}`)
	const projectDir = resolve(options.projectDir ?? options.baseDir ?? dirname(resolvedPath))
	if (!isProperPathWithin(projectDir, resolvedPath)) throw new Error("preview definition must be within its project or session directory")
	let config
	try {
		config = JSON.parse(await readFile(resolvedPath, "utf-8"))
	} catch (err) {
		throw Object.assign(new Error(`Invalid preview definition ${resolvedPath}: ${err?.message ?? err}`), { cause: err })
	}
	const name = cleanPreviewName(options.name ?? sourcePreviewName(resolvedPath))
	if (name === STATIC_PREVIEW_NAME) throw new Error(`${basename(resolvedPath)} uses the reserved built-in preview name ${STATIC_PREVIEW_NAME}`)
	const context = `preview ${name}`
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${context} must be a JSON object`)
	assertOnlyProperties(config, new Set(["description", "target", "routeSourceMap"]), context)
	if (!config.target || typeof config.target !== "object" || Array.isArray(config.target)) throw new Error(`${context} target must be an object`)
	if (config.target.kind !== "process" && config.target.kind !== "static") throw new Error(`${context} target.kind must be process or static`)
	const description = cleanDescription(config.description, context)
	if (config.target.kind === "static") {
		if (config.routeSourceMap !== undefined) throw new Error(`${context} routeSourceMap is implicit for a static target`)
		const target = cleanStaticTarget(config.target, projectDir, context)
		return staticPreviewDefinition(target.rootPath, {
			name,
			description,
			entryPath: target.entryPath,
			configPath: resolvedPath,
			projectDir,
		})
	}
	const target = cleanProcessTarget(config.target, context)
	return {
		name,
		kind: "process",
		...target,
		...(description ? { description } : {}),
		configPath: resolvedPath,
		projectDir,
		...(config.routeSourceMap !== undefined ? { routeSourceMap: cleanRouteSourceMap(config.routeSourceMap, projectDir, context) } : {}),
		source: {
			kind: "preview-json",
			path: resolvedPath,
			configPath: resolvedPath,
			size: info.size,
			mtimeMs: Math.floor(info.mtimeMs),
		},
	}
}

export async function staticPreviewFileDefinitionFromPath(path, options = {}) {
	const definition = await previewFileDefinitionFromPath(path, options)
	if (definition.kind !== "static") throw new Error(`preview ${definition.name} does not have a static target`)
	return definition
}

async function previewFileEntryDefinition(previewsDir, entry, options) {
	if (!entry.isFile()) return undefined
	const name = previewNameFromFilename(entry.name)
	if (!name) return undefined
	try {
		return await previewFileDefinitionFromPath(join(previewsDir, entry.name), { ...options, name })
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
		throw err
	}
}

export async function readPreviewDirectory(previewsDir, options = {}) {
	let entries
	try {
		entries = await readdir(previewsDir, { withFileTypes: true })
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { path: previewsDir, manifest: { previews: {} } }
		throw err
	}
	const previews = {}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const definition = await previewFileEntryDefinition(previewsDir, entry, options)
		if (!definition) continue
		if (previews[definition.name]) throw new Error(`Duplicate preview name: ${definition.name}`)
		previews[definition.name] = definition
	}
	const staticRoots = new Map()
	for (const definition of Object.values(previews)) {
		if (definition.kind !== "static") continue
		const existing = staticRoots.get(definition.source.path)
		if (existing) throw new Error(`Static previews ${existing} and ${definition.name} use the same root`)
		staticRoots.set(definition.source.path, definition.name)
	}
	return { path: previewsDir, manifest: { previews } }
}

export async function readSessionPreviewDefinitions(sessionDir) {
	const { manifest } = await readPreviewDirectory(sessionPreviewDirectory(sessionDir), { baseDir: sessionDir })
	return manifest
}

export function sessionPreviewDirectory(sessionDir) {
	return join(sessionDir, PREVIEW_DIRECTORY_NAME)
}

export function projectPreviewDirectory(projectDir) {
	return join(projectDir, PROJECT_STATE_DIRNAME, PREVIEW_DIRECTORY_NAME)
}

function legacyProjectPreviewDirectory(projectDir) {
	return join(projectDir, LEGACY_PROJECT_STATE_DIRNAME, PREVIEW_DIRECTORY_NAME)
}

export function projectPreviewLogPath(projectDir, name) {
	return join(projectPreviewDirectory(projectDir), PREVIEW_LOG_DIRECTORY_NAME, `${cleanPreviewName(name)}.log`)
}

async function directoryExists(path) {
	try {
		const info = await stat(path)
		if (!info.isDirectory()) throw new Error(`Project preview path is not a directory: ${path}`)
		return true
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false
		throw err
	}
}

async function migrateLegacyProjectPreviewsOnce(projectDir) {
	const canonical = projectPreviewDirectory(projectDir)
	const legacy = legacyProjectPreviewDirectory(projectDir)
	const [canonicalExists, legacyExists] = await Promise.all([directoryExists(canonical), directoryExists(legacy)])
	if (!legacyExists) return false
	if (canonicalExists) throw new Error(`Project previews exist at both ${canonical} and legacy ${legacy}. Remove or reconcile one directory.`)
	await ensureProjectStateDirectoryIgnored(projectDir)
	await rename(legacy, canonical)
	await initializeProjectPreviewDirectoryIgnore(projectDir)
	await cleanupLegacyProjectStateDirectory(projectDir)
	return true
}

export async function migrateLegacyProjectPreviews(projectDir) {
	const root = resolve(projectDir)
	const pending = projectPreviewMigrations.get(root)
	if (pending) return pending
	const migration = migrateLegacyProjectPreviewsOnce(root)
	projectPreviewMigrations.set(root, migration)
	try {
		return await migration
	} finally {
		if (projectPreviewMigrations.get(root) === migration) projectPreviewMigrations.delete(root)
	}
}

export async function readProjectPreviewDefinitions(projectDir) {
	await migrateLegacyProjectPreviews(projectDir)
	const { manifest } = await readPreviewDirectory(projectPreviewDirectory(projectDir), { projectDir })
	return manifest
}

export async function ensureProjectPreviewDirectory(projectDir) {
	await migrateLegacyProjectPreviews(projectDir)
	await ensureProjectStateDirectoryIgnored(projectDir)
	const directory = projectPreviewDirectory(projectDir)
	let created = false
	try {
		await mkdir(directory)
		created = true
	} catch (err) {
		if (err?.code !== "EEXIST" || !(await stat(directory)).isDirectory()) throw err
	}
	if (created) await initializeProjectPreviewDirectoryIgnore(projectDir)
}

export function previewDefinitionKey(definition) {
	return JSON.stringify({
		command: definition.command,
		cwd: definition.cwd,
		healthPath: definition.healthPath,
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
		.update("cerex-preview-root-v1\0")
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

export function staticPreviewDefinition(rootPath, options = {}) {
	return {
		name: cleanPreviewName(options.name ?? STATIC_PREVIEW_NAME),
		kind: "static",
		...(options.description ? { description: options.description } : {}),
		...(options.entryPath ? { entryPath: options.entryPath } : {}),
		...(options.configPath ? { configPath: resolve(options.configPath) } : {}),
		...(options.projectDir ? { projectDir: resolve(options.projectDir) } : {}),
		source: {
			kind: "static-directory",
			path: resolve(rootPath),
			...(options.configPath ? { configPath: resolve(options.configPath) } : {}),
			...(options.documentPath ? { documentPath: resolve(options.documentPath) } : {}),
		},
	}
}

export function staticPreviewPublicUrl({ publicUrl, rootPath, scopeId, routingSlug, name = STATIC_PREVIEW_NAME, path = "/" }) {
	return previewPublicUrl({
		publicUrl,
		name,
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
	const scope = scopeId === undefined ? "PREVIEW_SCOPE" : cleanPreviewScopeId(scopeId)
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
	return join(sessionPreviewDirectory(sessionDir), PREVIEW_LOG_DIRECTORY_NAME, `${cleanPreviewName(name)}.log`)
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
	if (prefix.length > 63 || name.length > MAX_PREVIEW_NAME_LENGTH || !PREVIEW_NAME_RE.test(name) || !/^[a-z0-9]{16}$/.test(scopeId)) return undefined
	try {
		cleanPreviewRoutingSlug(routingSlug)
	} catch {
		return undefined
	}
	return { name, scopeId, routingSlug }
}
