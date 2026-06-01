/**
 * Pinano frontend routes.
 *
 * Routes use the same canonical path shape as Pinano Web so terminal reexec,
 * `pinano open <route>`, and browser URLs describe the same page.
 */

/**
 * @typedef {{ type: "overview" }} OverviewRoute
 * @typedef {{ type: "session", id: string }} SessionRoute
 * @typedef {{ type: "settings-credentials" }} SettingsCredentialsRoute
 * @typedef {OverviewRoute | SessionRoute | SettingsCredentialsRoute} PinanoRoute
 */

/** @type {OverviewRoute} */
export const overviewRoute = { type: "overview" }

/** @type {SettingsCredentialsRoute} */
export const settingsCredentialsRoute = { type: "settings-credentials" }

/**
 * @param {string} id
 * @returns {SessionRoute}
 */
export function sessionRoute(id) {
	return { type: "session", id }
}

/**
 * @param {PinanoRoute} route
 * @returns {string}
 */
export function routeToArg(route) {
	if (route.type === "overview") return "/"
	if (route.type === "session") return `/chat/${encodeURIComponent(route.id)}`
	if (route.type === "settings-credentials") return "/settings/credentials"
	throw new Error(`Unknown Pinano route: ${JSON.stringify(route)}`)
}

/**
 * @param {PinanoRoute} route
 * @returns {string[]}
 */
export function routeToCliArgs(route) {
	return ["open", routeToArg(route)]
}

/**
 * @param {string} value
 * @returns {PinanoRoute | null}
 */
function parseUrlRoute(value) {
	if (!value.startsWith("/")) return null
	let url
	try {
		url = new URL(value, "http://pinano.local")
	} catch {
		return null
	}
	if (url.pathname === "/") return overviewRoute
	if (url.pathname === "/settings/credentials") return settingsCredentialsRoute
	const chatMatch = url.pathname.match(/^\/chat\/([^/]+)$/)
	if (chatMatch) return sessionRoute(decodeURIComponent(chatMatch[1]))
	return null
}

/**
 * @param {string | undefined} arg
 * @returns {PinanoRoute}
 */
export function parseRouteArg(arg) {
	if (!arg) throw new Error("open requires a route: /, /chat/<id>, or /settings/credentials")
	const urlRoute = parseUrlRoute(arg)
	if (urlRoute) return urlRoute
	throw new Error(`Unknown route "${arg}". Use /, /chat/<id>, or /settings/credentials.`)
}
