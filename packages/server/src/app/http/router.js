// Small Fetch-style router for core HTTP services and optional frontends. It intentionally implements only ordered middleware, GET/POST/DELETE routes, named single-segment params, prefix middleware, and a catch-all route.

/**
 * @typedef {(context: HttpContext, next: () => Promise<void>) => Response | void | Promise<Response | void>} HttpMiddleware
 * @typedef {(context: HttpContext) => Response | void | Promise<Response | void>} HttpHandler
 * @typedef {{ method?: string, pattern: string, handler: HttpMiddleware | HttpHandler }} HttpLayer
 */

/**
 * @typedef {object} HttpContext
 * @property {{ raw: Request, method: string, url: string, path: string, signal: AbortSignal, header: (name: string) => string | null, query: (name: string) => string | undefined, json: () => Promise<any>, text: () => Promise<string>, param: (name: string) => string | undefined }} req
 * @property {Response} res
 * @property {(data: any, status?: number, headers?: HeadersInit) => Response} json
 * @property {(body: BodyInit | null | undefined, status?: number, headers?: HeadersInit) => Response} body
 * @property {(body: BodyInit | null | undefined, status?: number, headers?: HeadersInit) => Response} html
 */

function withContentType(headers, contentType) {
	const result = new Headers(headers)
	if (!result.has("content-type")) result.set("content-type", contentType)
	return result
}

function decodeParam(value) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function matchRoute(pattern, pathname) {
	if (pattern === "*") return {}

	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2)
		return pathname === prefix || pathname.startsWith(`${prefix}/`) ? {} : null
	}

	const patternParts = pattern.split("/").filter(Boolean)
	const pathParts = pathname.split("/").filter(Boolean)
	if (patternParts.length !== pathParts.length) return null

	const params = {}
	for (let i = 0; i < patternParts.length; i++) {
		const expected = patternParts[i]
		const actual = pathParts[i]
		if (expected.startsWith(":")) params[expected.slice(1)] = decodeParam(actual)
		else if (expected !== actual) return null
	}
	return params
}

function createContext(request, params) {
	const url = new URL(request.url)
	return {
		req: {
			raw: request,
			method: request.method,
			url: request.url,
			path: url.pathname,
			signal: request.signal,
			header: (name) => request.headers.get(name),
			query: (name) => url.searchParams.get(name) ?? undefined,
			json: () => request.json(),
			text: () => request.text(),
			param: (name) => params?.[name],
		},
		res: new Response("Not Found", { status: 404 }),
		json: (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
			status,
			headers: withContentType(headers, "application/json; charset=utf-8"),
		}),
		body: (body, status = 200, headers = {}) => new Response(body, { status, headers }),
		html: (body, status = 200, headers = {}) => new Response(body, {
			status,
			headers: withContentType(headers, "text/html; charset=utf-8"),
		}),
	}
}

/**
 * A deliberately small router for the Fetch API. It keeps route registration
 * explicit and ordered so auth and catch-all behavior are easy to audit.
 */
export class HttpRouter {
	/** @type {HttpLayer[]} */
	#layers = []

	use(pattern, handler) {
		this.#layers.push({ pattern, handler })
	}

	get(pattern, handler) {
		this.#layers.push({ method: "GET", pattern, handler })
	}

	post(pattern, handler) {
		this.#layers.push({ method: "POST", pattern, handler })
	}

	delete(pattern, handler) {
		this.#layers.push({ method: "DELETE", pattern, handler })
	}

	async fetch(request) {
		const { pathname } = new URL(request.url)
		const method = request.method === "HEAD" ? "GET" : request.method
		const matched = this.#layers
			.map((layer) => ({ layer, params: matchRoute(layer.pattern, pathname) }))
			.filter(({ layer, params }) => params && (!layer.method || layer.method === method))

		const routeParams = matched.find(({ layer }) => layer.method)?.params ?? {}
		const context = createContext(request, routeParams)
		let index = -1

		const next = async () => {
			index++
			const entry = matched[index]
			if (!entry) return
			const returned = await entry.layer.handler(context, next)
			if (returned instanceof Response) context.res = returned
		}

		await next()
		return context.res
	}
}
