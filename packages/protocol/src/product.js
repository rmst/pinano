export const PRODUCT_NAME = "Cerex"
export const PRODUCT_SLUG = "cerex"
export const PRODUCT_COMMAND = "cerex"
export const PRODUCT_STATE_DIRECTORY = ".cerex"
export const PROJECT_DOCUMENTS_DIRECTORY_NAME = "docs"
export const PROJECT_DOCUMENTS_RELATIVE_PATH = `${PRODUCT_STATE_DIRECTORY}/${PROJECT_DOCUMENTS_DIRECTORY_NAME}`
export const PRODUCT_ENV_PREFIX = "CEREX_"

export const LEGACY_PRODUCT_NAME = "Pinano"
export const LEGACY_PRODUCT_SLUG = "pinano"
export const LEGACY_PRODUCT_COMMAND = "pinano"
export const LEGACY_PRODUCT_STATE_DIRECTORY = ".pinano"
export const LEGACY_PRODUCT_ENV_PREFIX = "PINANO_"

export function productEnvName(suffix) {
	return `${PRODUCT_ENV_PREFIX}${suffix}`
}

export function legacyProductEnvName(suffix) {
	return `${LEGACY_PRODUCT_ENV_PREFIX}${suffix}`
}

function pathIsProjectDocument(path) {
	const parts = []
	let escaped = false
	for (const part of String(path ?? "").replaceAll("\\", "/").split("/")) {
		if (!part || part === ".") continue
		if (part === "..") {
			if (parts.length > 0) parts.pop()
			else escaped = true
		}
		else parts.push(part)
	}
	return !escaped && parts.some((part, index) => part === PRODUCT_STATE_DIRECTORY && parts[index + 1] === PROJECT_DOCUMENTS_DIRECTORY_NAME)
}

export function pathIsProjectPageDocument(path) {
	return pathIsProjectDocument(path) && pathIsPageDocument(path)
}

export function pathIsPageDocument(path) {
	return /\.(?:html?|md)$/i.test(String(path ?? ""))
}

/** Normalize error codes received from older services without changing unrelated platform and library error codes. */
export function canonicalProductErrorCode(code) {
	if (typeof code !== "string" || !code.startsWith(LEGACY_PRODUCT_ENV_PREFIX)) return code
	return `${PRODUCT_ENV_PREFIX}${code.slice(LEGACY_PRODUCT_ENV_PREFIX.length)}`
}

/** @param {unknown} errorOrCode @param {string} expected */
export function productErrorCodeMatches(errorOrCode, expected) {
	const code = errorOrCode && typeof errorOrCode === "object" ? errorOrCode.code : errorOrCode
	return canonicalProductErrorCode(code) === canonicalProductErrorCode(expected)
}

export function readProductEnv(env, suffix) {
	return env?.[productEnvName(suffix)] ?? env?.[legacyProductEnvName(suffix)]
}

export function writeProductEnv(env, suffix, value, options = {}) {
	const next = { ...env, [productEnvName(suffix)]: value }
	if (options.legacy !== false) next[legacyProductEnvName(suffix)] = value
	return next
}

/** Populate missing aliases in-place at process boundaries. Canonical Cerex values always win when both names are present. */
export function applyProductEnvAliases(env) {
	if (!env || typeof env !== "object") return env
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith(LEGACY_PRODUCT_ENV_PREFIX)) continue
		const canonical = `${PRODUCT_ENV_PREFIX}${name.slice(LEGACY_PRODUCT_ENV_PREFIX.length)}`
		if (env[canonical] === undefined) env[canonical] = value
	}
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith(PRODUCT_ENV_PREFIX)) continue
		const legacy = `${LEGACY_PRODUCT_ENV_PREFIX}${name.slice(PRODUCT_ENV_PREFIX.length)}`
		env[legacy] = value
	}
	return env
}
