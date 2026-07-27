import { routeToArg } from "./routes.js"

/** @typedef {import("./routes.js").AppRoute} AppRoute */

/**
 * @param {AppRoute} a
 * @param {AppRoute} b
 * @returns {boolean}
 */
export function routesEqual(a, b) {
	return routeToArg(a) === routeToArg(b)
}

export class RouteHistory {
	/** @param {AppRoute} initialRoute */
	constructor(initialRoute) {
		this.current = initialRoute
		this.backStack = []
		this.forwardStack = []
	}

	/** @param {AppRoute} route */
	navigate(route) {
		if (routesEqual(this.current, route)) {
			this.current = route
			return false
		}
		this.backStack.push(this.current)
		this.forwardStack = []
		this.current = route
		return true
	}

	/** @param {AppRoute} route */
	replace(route) {
		this.current = route
		return true
	}

	canGoBack() {
		return this.backStack.length > 0
	}

	canGoForward() {
		return this.forwardStack.length > 0
	}

	back() {
		const route = this.backStack.pop()
		if (!route) return undefined
		this.forwardStack.push(this.current)
		this.current = route
		return route
	}

	forward() {
		const route = this.forwardStack.pop()
		if (!route) return undefined
		this.backStack.push(this.current)
		this.current = route
		return route
	}
}
