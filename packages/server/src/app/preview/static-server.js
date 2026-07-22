import { createReadStream } from "node:fs"
import { constants as fsConstants } from "node:fs"
import { access, readFile, realpath, stat } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"

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
	"prefetch-src 'none'",
	"navigate-to 'self'",
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

function fileEtag(info) {
	return `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
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

function staticPreviewHeaders(filePath, info) {
	return {
		"content-type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
		"content-length": String(info.size),
		"etag": fileEtag(info),
		"last-modified": info.mtime.toUTCString(),
		"cache-control": "no-cache",
		"content-security-policy": STATIC_PREVIEW_CSP,
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"permissions-policy": "geolocation=(), microphone=(), camera=()",
		"cross-origin-resource-policy": "same-site",
	}
}

function escapeHtmlAttribute(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

function injectHtml(html, snippet) {
	const head = html.match(/<head(?:\s[^>]*)?>/i)
	if (head?.index !== undefined) {
		const insertAt = head.index + head[0].length
		return `${html.slice(0, insertAt)}${snippet}${html.slice(insertAt)}`
	}
	const body = html.match(/<\/body\s*>/i)
	if (body?.index !== undefined) return `${html.slice(0, body.index)}${snippet}${html.slice(body.index)}`
	const htmlEnd = html.match(/<\/html\s*>/i)
	if (htmlEnd?.index !== undefined) return `${html.slice(0, htmlEnd.index)}${snippet}${html.slice(htmlEnd.index)}`
	return `${html}${snippet}`
}

function staticPreviewBridgeSnippet(scriptPath) {
	return `<script src="${escapeHtmlAttribute(scriptPath)}" data-pinano-preview-frame-bridge></script>`
}

function shouldInjectStaticPreviewBridge(filePath, options) {
	return Boolean(options.bridgeScriptPath) && /^\.html?$/i.test(extname(filePath))
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
		const indexPath = join(resolvedPath, "index.html")
		try {
			resolvedPath = await realpath(indexPath)
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Directory listing is disabled"), { status: 403 })
			throw err
		}
		if (!isWithinRoot(rootRealPath, resolvedPath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })
		info = await stat(resolvedPath)
	}

	if (!info.isFile()) throw Object.assign(new Error("Not found"), { status: 404 })
	await access(resolvedPath, fsConstants.R_OK)
	return { path: resolvedPath, info }
}

export function encodeStaticPreviewPath(relativePath) {
	const normalized = String(relativePath || "").split(/[\\/]+/).filter(Boolean)
	return `/${normalized.map(encodeURIComponent).join("/")}`
}

export async function serveStaticPreviewRequest(request, target, options = {}) {
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method Not Allowed", 405, { allow: "GET, HEAD" })
	let file
	try {
		const url = new URL(request.url)
		file = await resolveStaticPreviewFile(target.rootPath, url.pathname)
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

	const headers = staticPreviewHeaders(file.path, file.info)
	if (
		etagMatches(request.headers.get("if-none-match"), headers.etag)
		|| (!request.headers.get("if-none-match") && modifiedSinceMatches(request.headers.get("if-modified-since"), file.info.mtime))
	) return new Response(null, { status: 304, headers })

	if (shouldInjectStaticPreviewBridge(file.path, options)) {
		const html = injectHtml(await readFile(file.path, "utf-8"), staticPreviewBridgeSnippet(options.bridgeScriptPath))
		headers["content-length"] = String(new TextEncoder().encode(html).byteLength)
		if (request.method === "HEAD") return new Response(null, { headers })
		return new Response(html, { headers })
	}

	if (request.method === "HEAD") return new Response(null, { headers })
	return new Response(createStreamBody(createReadStream(file.path)), { headers })
}
