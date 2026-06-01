const BEARER_AUTH = /^\s*Bearer\s+(.+?)\s*$/i

export function bearerTokenFromHeader(value) {
	if (typeof value !== "string") return ""
	return value.match(BEARER_AUTH)?.[1] || ""
}

export function requestTokenFromParts(url, authorization) {
	const bearer = bearerTokenFromHeader(authorization)
	if (bearer) return bearer
	try {
		return new URL(url).searchParams.get("token") || ""
	} catch {
		return ""
	}
}

export function sameOriginRequestParts(url, origin) {
	if (!origin) return true
	try {
		return new URL(origin).origin === new URL(url).origin
	} catch {
		return false
	}
}

export function authenticateRequestParts({ url, authorization, origin }, token, options = {}) {
	if (token && requestTokenFromParts(url, authorization) !== token) return { ok: false, status: 401, error: "Unauthorized" }
	if (options.checkOrigin && !sameOriginRequestParts(url, origin)) return { ok: false, status: 403, error: "Forbidden origin" }
	return { ok: true }
}

export function authenticateRequest(req, token, options = {}) {
	return authenticateRequestParts({
		url: req.url,
		authorization: req.headers.get("authorization"),
		origin: req.headers.get("origin"),
	}, token, options)
}
