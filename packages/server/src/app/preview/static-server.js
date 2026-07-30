import { createReadStream } from "node:fs"
import { constants as fsConstants } from "node:fs"
import { access, readFile, realpath, stat } from "node:fs/promises"
import { dirname, extname, join, relative, resolve, sep } from "node:path"

import { projectFileForRoot, projectRoute, routeToArg } from "../navigation/routes.js"
import { PROJECT_DOCUMENT_INDEX_FILENAMES } from "../project/documents.js"
import { renderMarkdownDocument } from "../../markdown/document.js"
import { injectPreviewFrameBridge } from "./shell.js"
import { annotateHtmlSource } from "./source-anchors.js"

const STATIC_PREVIEW_CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"media-src 'self' data: blob:",
	"connect-src 'self'",
	"worker-src 'none'",
	"frame-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"manifest-src 'none'",
].join("; ")

const mimeTypes = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
	".wasm": "application/wasm",
}

function text(body, status = 200, headers = {}) {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	})
}

function createStreamBody(stream) {
	return new ReadableStream({
		start(controller) {
			stream.on("data", (chunk) => controller.enqueue(chunk))
			stream.on("end", () => controller.close())
			stream.on("error", (err) => controller.error(err))
		},
		cancel() {
			stream.destroy()
		},
	})
}

function isWithinRoot(rootPath, candidatePath) {
	const root = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`
	return candidatePath === rootPath || candidatePath.startsWith(root)
}

function decodeRequestPath(pathname) {
	const segments = []
	for (const raw of pathname.split("/")) {
		if (!raw) continue
		let segment
		try {
			segment = decodeURIComponent(raw)
		} catch {
			throw Object.assign(new Error("Invalid path encoding"), { status: 400 })
		}
		if (segment === ".") continue
		if (segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
			throw Object.assign(new Error("Path not allowed"), { status: 403 })
		}
		segments.push(segment)
	}
	return segments.join("/")
}

function fileEtag(info, variant = "") {
	const suffix = variant ? `-${variant}` : ""
	return `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}${suffix}"`
}

function etagMatches(value, etag) {
	if (!value) return false
	const normalize = (item) => item.trim().replace(/^W\//, "")
	const target = normalize(etag)
	return value.split(",").some((item) => normalize(item) === target || item.trim() === "*")
}

function modifiedSinceMatches(value, mtime) {
	if (!value) return false
	const since = Date.parse(value)
	if (Number.isNaN(since)) return false
	return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000)
}

function staticPreviewHeaders(filePath, info, response = {}) {
	return {
		"content-type": response.contentType ?? mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
		"content-length": String(response.contentLength ?? info.size),
		"etag": fileEtag(info, response.variant),
		"last-modified": info.mtime.toUTCString(),
		"cache-control": "no-cache",
		"content-security-policy": STATIC_PREVIEW_CSP,
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"permissions-policy": "geolocation=(), microphone=(), camera=()",
		"cross-origin-resource-policy": "same-site",
	}
}

function isStaticDocumentPage(filePath) {
	return /^\.(?:html?|md)$/i.test(extname(filePath))
}

function shouldInjectStaticPreviewBridge(filePath, options) {
	return Boolean(options.bridgeScriptPath && options.openDocumentPath) && isStaticDocumentPage(filePath)
}

async function resolveStaticPreviewPaths(target) {
	if (target.definition?.source?.kind !== "static-directory"
		|| resolve(target.definition.source.path) !== resolve(target.rootPath)) {
		throw Object.assign(new Error("Static preview scope is not configured"), { status: 404 })
	}
	let projectPath
	let rootPath
	try {
		projectPath = resolve(await realpath(target.projectDir))
		rootPath = resolve(await realpath(target.rootPath))
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Static preview directory not found"), { status: 404 })
		throw err
	}
	if (rootPath !== resolve(target.rootPath)) throw Object.assign(new Error("Static preview directory may not be a symbolic link"), { status: 403 })
	if (!isWithinRoot(projectPath, rootPath) || rootPath === projectPath) throw Object.assign(new Error("Static preview directory must be inside the project"), { status: 403 })
	if (!(await stat(rootPath)).isDirectory()) throw Object.assign(new Error("Static preview path is not a directory"), { status: 404 })
	return { projectPath, rootPath }
}

async function resolveStaticPreviewFile(rootPath, pathname) {
	const rootRealPath = await realpath(rootPath)
	const relativePath = decodeRequestPath(pathname)
	const candidatePath = resolve(rootRealPath, relativePath)
	if (!isWithinRoot(rootRealPath, candidatePath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })

	let resolvedPath
	try {
		resolvedPath = await realpath(candidatePath)
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Not found"), { status: 404 })
		throw err
	}
	if (!isWithinRoot(rootRealPath, resolvedPath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })

	let info = await stat(resolvedPath)
	if (info.isDirectory()) {
		if (!pathname.endsWith("/")) throw Object.assign(new Error("Directory redirect"), { status: 308, location: `${pathname}/` })
		let indexPath
		for (const name of PROJECT_DOCUMENT_INDEX_FILENAMES) {
			try {
				const candidateIndexPath = await realpath(join(resolvedPath, name))
				if (!isWithinRoot(rootRealPath, candidateIndexPath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })
				if ((await stat(candidateIndexPath)).isFile()) {
					indexPath = candidateIndexPath
					break
				}
			} catch (err) {
				if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err
			}
		}
		if (!indexPath) throw Object.assign(new Error("Directory listing is disabled"), { status: 403 })
		resolvedPath = indexPath
		if (!isWithinRoot(rootRealPath, resolvedPath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })
		info = await stat(resolvedPath)
	}

	if (!info.isFile()) throw Object.assign(new Error("Not found"), { status: 404 })
	await access(resolvedPath, fsConstants.R_OK)
	return { path: resolvedPath, info }
}

async function staticDocumentResponse(file, options) {
	const ext = extname(file.path).toLowerCase()
	if (ext !== ".md" && !/^\.html?$/.test(ext)) return undefined

	const source = await readFile(file.path, "utf-8")
	let body
	let variant
	let contentType
	if (ext === ".md") {
		body = renderMarkdownDocument(source, file.path)
		variant = "markdown-document-v2"
		contentType = "text/html; charset=utf-8"
	} else {
		body = source
		variant = "html-document-v2"
		contentType = "text/html; charset=utf-8"
	}

	if (shouldInjectStaticPreviewBridge(file.path, options)) {
		if (/^\.html?$/.test(ext)) body = annotateHtmlSource(body)
		const documentPath = relative(options.rootPath, file.path).split(sep).join("/")
		body = injectPreviewFrameBridge(body, {
			scriptUrl: options.bridgeScriptPath,
			documentLinks: true,
			openPath: options.openDocumentPath,
			documentPath,
		})
	}
	return {
		body,
		headers: staticPreviewHeaders(file.path, file.info, {
			contentLength: new TextEncoder().encode(body).byteLength,
			contentType,
			variant,
		}),
		transformed: true,
	}
}

export function encodeStaticPreviewPath(relativePath) {
	const normalized = String(relativePath || "").split(/[\\/]+/).filter(Boolean)
	return `/${normalized.map(encodeURIComponent).join("/")}`
}

function decodeDocumentLinkPath(pathname) {
	const segments = []
	for (const raw of pathname.split("/")) {
		if (!raw) continue
		let segment
		try {
			segment = decodeURIComponent(raw)
		} catch {
			throw Object.assign(new Error("Invalid link path encoding"), { status: 400 })
		}
		if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
			throw Object.assign(new Error("Link path not allowed"), { status: 403 })
		}
		if (segment !== ".") segments.push(segment)
	}
	return segments.join("/")
}

function documentLinkParts(href) {
	if (typeof href !== "string" || href.includes("\0") || href.includes("\\")) {
		throw Object.assign(new Error("Invalid document link"), { status: 400 })
	}
	if (href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
		throw Object.assign(new Error("Document link must be local"), { status: 400 })
	}
	const queryIndex = href.indexOf("?")
	const hashIndex = href.indexOf("#")
	const suffixIndexes = [queryIndex, hashIndex].filter((index) => index >= 0)
	const pathEnd = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : href.length
	const path = href.slice(0, pathEnd)
	const parsed = new URL(href, "http://preview.invalid/")
	return { path, search: parsed.search, hash: parsed.hash }
}

function previewDocumentUrl(target, rootPath, candidatePath, link) {
	let pathname = encodeStaticPreviewPath(relative(rootPath, candidatePath))
	if ((link.path.endsWith("/") || /(?:^|\/)\.{1,2}$/.test(link.path)) && !pathname.endsWith("/")) pathname += "/"
	const url = new URL(pathname, target.publicUrl)
	url.search = link.search
	url.hash = link.hash
	return url.href
}

function workspaceRoute(projectPath, targetPath, info) {
	const route = info.isDirectory()
		? projectRoute(projectPath, { pane: "files" })
		: projectRoute(projectPath, {
			pane: "workbench",
			file: projectFileForRoot(projectPath, targetPath),
		})
	return routeToArg(route)
}

async function resolveDocumentLink(target, from, href) {
	const { projectPath, rootPath } = await resolveStaticPreviewPaths(target)
	if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) {
		throw Object.assign(new Error("Invalid source document path"), { status: 400 })
	}
	const sourceFile = await resolveStaticPreviewFile(rootPath, from)
	if (!isStaticDocumentPage(sourceFile.path)) throw Object.assign(new Error("Source document must be a page"), { status: 400 })
	const sourcePath = resolve(rootPath, decodeRequestPath(from))
	if (!isWithinRoot(rootPath, sourcePath)) throw Object.assign(new Error("Source document path not allowed"), { status: 403 })
	const link = documentLinkParts(href)
	if (!link.path) {
		const url = new URL(from, target.publicUrl)
		url.search = link.search
		url.hash = link.hash
		return { kind: "preview", url: url.href }
	}
	const basePath = from.endsWith("/") ? sourcePath : dirname(sourcePath)
	const decodedLinkPath = decodeDocumentLinkPath(link.path)
	const candidatePath = link.path.startsWith("/")
		? resolve(rootPath, relative("/", resolve("/", decodedLinkPath)))
		: resolve(basePath, decodedLinkPath)
	if (!isWithinRoot(projectPath, candidatePath)) throw Object.assign(new Error("Link target is outside the project"), { status: 403 })

	let resolvedPath
	try {
		resolvedPath = resolve(await realpath(candidatePath))
	} catch (err) {
		if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err
	}
	if (!resolvedPath && isWithinRoot(rootPath, candidatePath)) {
		return { kind: "preview", url: previewDocumentUrl(target, rootPath, candidatePath, link) }
	}
	if (!resolvedPath) throw Object.assign(new Error("Link target not found"), { status: 404 })
	if (!isWithinRoot(projectPath, resolvedPath)) throw Object.assign(new Error("Link target is outside the project"), { status: 403 })
	if (isWithinRoot(rootPath, resolvedPath)) {
		return { kind: "preview", url: previewDocumentUrl(target, rootPath, candidatePath, link) }
	}
	const info = await stat(resolvedPath)
	if (!info.isFile() && !info.isDirectory()) throw Object.assign(new Error("Link target is not a file or directory"), { status: 400 })
	return { kind: "workspace", url: workspaceRoute(projectPath, resolvedPath, info) }
}

export async function serveStaticPreviewDocumentLink(request, target, options = {}) {
	if (request.method !== "GET") return text("Method Not Allowed", 405, { allow: "GET" })
	const url = new URL(request.url)
	const result = await resolveDocumentLink(target, url.searchParams.get("from"), url.searchParams.get("href"))
	if (/\bapplication\/json\b/i.test(request.headers.get("accept") || "")) {
		return new Response(JSON.stringify(result), {
			headers: {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			},
		})
	}
	if (result.kind === "workspace" && !options.appPublicUrl) {
		throw Object.assign(new Error("Application public URL is required"), { status: 500 })
	}
	return new Response(null, {
		status: 302,
		headers: {
			location: result.kind === "workspace" ? new URL(result.url, options.appPublicUrl).href : result.url,
			"cache-control": "no-store",
		},
	})
}

export async function serveStaticPreviewRequest(request, target, options = {}) {
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method Not Allowed", 405, { allow: "GET, HEAD" })
	let file
	let rootPath
	try {
		const url = new URL(request.url)
		const paths = await resolveStaticPreviewPaths(target)
		rootPath = paths.rootPath
		file = await resolveStaticPreviewFile(paths.rootPath, url.pathname)
	} catch (err) {
		if (err?.location) {
			const url = new URL(request.url)
			return new Response(null, {
				status: err.status ?? 308,
				headers: {
					location: `${err.location}${url.search}`,
					"cache-control": "no-store",
				},
			})
		}
		const status = Number.isInteger(err?.status) ? err.status : err?.code === "EACCES" ? 403 : 500
		return text(err?.message ?? String(err), status)
	}

	let documentResponse
	try {
		documentResponse = await staticDocumentResponse(file, { ...options, rootPath })
	} catch (err) {
		const status = Number.isInteger(err?.status) ? err.status : 500
		return text(err?.message ?? String(err), status)
	}
	const headers = documentResponse?.headers ?? staticPreviewHeaders(file.path, file.info)
	if (
		etagMatches(request.headers.get("if-none-match"), headers.etag)
		|| (!documentResponse?.transformed && !request.headers.get("if-none-match") && modifiedSinceMatches(request.headers.get("if-modified-since"), file.info.mtime))
	) return new Response(null, { status: 304, headers })

	if (documentResponse) {
		if (request.method === "HEAD") return new Response(null, { headers })
		return new Response(documentResponse.body, { headers })
	}

	if (request.method === "HEAD") return new Response(null, { headers })
	return new Response(createStreamBody(createReadStream(file.path)), { headers })
}
