import { isAbsolute, join, resolve } from "node:path"

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** @param {unknown} value */
function isPlainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

/**
 * @param {Record<string, unknown>} object
 * @param {string[]} allowed
 * @param {string} description
 */
function assertOnlyKeys(object, allowed, description) {
	const unexpected = Object.keys(object).filter((key) => !allowed.includes(key))
	if (unexpected.length > 0) throw new Error(`${description} has unknown field: ${unexpected[0]}`)
}

/** @param {unknown} provider */
export function validateCredentialProvider(provider) {
	if (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider)) {
		throw new Error(`Invalid credential provider: ${String(provider)}`)
	}
	return provider
}

/**
 * @typedef {object} CredentialStoreRoute
 * @property {string} directory
 * @property {boolean} managed
 */

/**
 * Maps each credential provider to exactly one file store. Providers without
 * an explicit route stay in the current Cerex home's private auth directory.
 */
export class CredentialStoreRouter {
	/**
	 * @param {() => string} defaultDirectory
	 * @param {Map<string, CredentialStoreRoute>} [routes]
	 */
	constructor(defaultDirectory, routes = new Map()) {
		if (typeof defaultDirectory !== "function") throw new Error("Credential store default directory must be a function")
		this.defaultDirectory = defaultDirectory
		this.routes = new Map(routes)
	}

	/** @param {string} provider */
	route(provider) {
		const name = validateCredentialProvider(provider)
		return this.routes.get(name) ?? {
			directory: resolve(this.defaultDirectory()),
			managed: false,
		}
	}

	/** @param {string} provider */
	filePath(provider) {
		return join(this.route(provider).directory, `${provider}.json`)
	}

	/** @param {string} provider */
	isManaged(provider) {
		return this.route(provider).managed
	}

	configuredRoutes() {
		return [...this.routes.entries()].map(([provider, route]) => ({ provider, ...route }))
	}
}

/**
 * @param {() => string} defaultDirectory
 * @param {unknown} config
 */
export function credentialStoreRouterFromConfig(defaultDirectory, config = {}) {
	if (!isPlainObject(config)) throw new Error("Credential stores configuration must be an object")
	const root = /** @type {Record<string, unknown>} */ (config)
	assertOnlyKeys(root, ["providers"], "Credential stores configuration")
	const providers = root.providers ?? {}
	if (!isPlainObject(providers)) throw new Error("Credential stores providers must be an object")

	/** @type {Map<string, CredentialStoreRoute>} */
	const routes = new Map()
	for (const [provider, rawRoute] of Object.entries(/** @type {Record<string, unknown>} */ (providers))) {
		validateCredentialProvider(provider)
		if (!isPlainObject(rawRoute)) throw new Error(`Credential store route for ${provider} must be an object`)
		const route = /** @type {Record<string, unknown>} */ (rawRoute)
		assertOnlyKeys(route, ["directory", "managed"], `Credential store route for ${provider}`)
		if (typeof route.directory !== "string" || !isAbsolute(route.directory)) {
			throw new Error(`Credential store directory for ${provider} must be an absolute path`)
		}
		if (route.managed !== undefined && typeof route.managed !== "boolean") {
			throw new Error(`Credential store managed flag for ${provider} must be a boolean`)
		}
		routes.set(provider, {
			directory: resolve(route.directory),
			managed: route.managed === true,
		})
	}

	return new CredentialStoreRouter(defaultDirectory, routes)
}
