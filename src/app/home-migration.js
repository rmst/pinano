import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const WEB_TOKEN_MIN_LENGTH = 16
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"]

/** @param {string} path */
function pathExists(path) {
	try {
		lstatSync(path)
		return true
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return false
		throw err
	}
}

/** @param {string} path */
function isDirectory(path) {
	try {
		return lstatSync(path).isDirectory()
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return false
		throw err
	}
}

/** @param {string} path @param {number} [mode] */
function ensureDir(path, mode) {
	mkdirSync(path, { recursive: true, ...(mode === undefined ? {} : { mode }) })
}

/** @param {unknown} value */
function plainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {}
}

/** @param {Record<string, any>} value */
function hasKeys(value) {
	return Object.keys(value).length > 0
}

/** @param {string} path */
function readJsonObjectMaybe(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"))
		return plainObject(parsed)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

/** @param {string} path @param {Record<string, any>} value */
function writeJsonFile(path, value) {
	ensureDir(dirname(path))
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
		renameSync(tmp, path)
	} catch (err) {
		rmSync(tmp, { force: true })
		throw err
	}
}

/** @param {string} ref */
function splitModelRef(ref) {
	const match = ref.match(/^([^/]+)\/(.+)$/)
	return match ? { provider: match[1], id: match[2] } : { id: ref }
}

/** @param {string} ref */
function legacyDefaultModelRef(ref) {
	const parsed = splitModelRef(ref)
	if (parsed.provider) return `${parsed.provider}/${parsed.id}`
	const codexMatch = parsed.id.match(/^(.+)-codex$/)
	if (codexMatch) return `openai-codex/${codexMatch[1]}`
	return `openai/${parsed.id}`
}

/** @param {any[]} base @param {any[]} override */
function mergeModelArrays(base = [], override = []) {
	const byId = new Map()
	for (const model of [...base, ...override]) {
		if (!model?.id) continue
		byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model })
	}
	return [...byId.values()]
}

/** @param {unknown} base @param {unknown} override */
function mergeProviderSetting(base, override) {
	const merged = { ...plainObject(base), ...plainObject(override) }
	if (plainObject(base).headers || plainObject(override).headers) merged.headers = { ...plainObject(plainObject(base).headers), ...plainObject(plainObject(override).headers) }
	if (plainObject(base).compat || plainObject(override).compat) merged.compat = { ...plainObject(plainObject(base).compat), ...plainObject(plainObject(override).compat) }
	if (Array.isArray(plainObject(base).models) || Array.isArray(plainObject(override).models)) merged.models = mergeModelArrays(plainObject(base).models, plainObject(override).models)
	return merged
}

/** @param {unknown} base @param {unknown} override */
function mergeProviders(base, override) {
	const merged = {}
	for (const [provider, config] of Object.entries(plainObject(base))) merged[provider] = mergeProviderSetting(undefined, config)
	for (const [provider, config] of Object.entries(plainObject(override))) merged[provider] = mergeProviderSetting(merged[provider], config)
	return merged
}

/** @param {unknown} base @param {unknown} override */
function mergeServiceSettings(base, override) {
	const merged = { ...plainObject(base), ...plainObject(override) }
	if (plainObject(base).web || plainObject(override).web) merged.web = { ...plainObject(plainObject(base).web), ...plainObject(plainObject(override).web) }
	if (plainObject(base).diagnostics || plainObject(override).diagnostics) merged.diagnostics = { ...plainObject(plainObject(base).diagnostics), ...plainObject(plainObject(override).diagnostics) }
	return merged
}

/** @param {unknown} base @param {unknown} override */
function mergeToolSandboxSettings(base, override) {
	return { ...plainObject(base), ...plainObject(override) }
}

/** @param {Record<string, any>} base @param {Record<string, any>} override */
function mergeSettingsObjects(base, override) {
	const merged = { ...base, ...override }
	if (base.providers || override.providers) merged.providers = mergeProviders(base.providers, override.providers)
	if (base.service || override.service) merged.service = mergeServiceSettings(base.service, override.service)
	if (base.toolSandbox || override.toolSandbox) merged.toolSandbox = mergeToolSandboxSettings(base.toolSandbox, override.toolSandbox)
	return merged
}

/** @param {Record<string, any>} models */
function providersFromLegacyModels(models) {
	const providers = {}
	for (const [ref, value] of Object.entries(models)) {
		const config = plainObject(value)
		if (!hasKeys(config)) continue
		const parsed = splitModelRef(ref)
		const provider = typeof config.provider === "string" && config.provider ? config.provider : parsed.provider ?? "openai"
		const id = typeof config.id === "string" && config.id ? config.id : parsed.id
		const { provider: _provider, ...rest } = config
		providers[provider] = mergeProviderSetting(providers[provider], { models: [{ id, ...rest }] })
	}
	return providers
}

/** @param {Record<string, any>} raw */
function normalizeSettingsShape(raw) {
	const out = { ...raw }
	if (typeof out.model === "string" && out.model.trim() && typeof out.defaultModel !== "string") out.defaultModel = legacyDefaultModelRef(out.model.trim())
	delete out.model
	const legacyProviders = hasKeys(plainObject(out.models)) ? providersFromLegacyModels(plainObject(out.models)) : undefined
	delete out.models
	if (legacyProviders) out.providers = mergeProviders(legacyProviders, out.providers)
	return out
}

/** @param {Record<string, any>} raw */
function settingsFromServiceConfig(raw) {
	const service = {}
	for (const key of ["worker", "modelIoLog", "modelIoLogDb", "token", "web", "diagnostics"]) {
		if (Object.hasOwn(raw, key)) service[key] = raw[key]
	}
	const providers = {}
	for (const [provider, value] of Object.entries(plainObject(raw.providers))) {
		providers[provider] = typeof value === "string" ? { apiKey: value } : plainObject(value)
	}
	return {
		...(hasKeys(service) ? { service } : {}),
		...(hasKeys(providers) ? { providers } : {}),
	}
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {Record<string, any>} [base]
 */
function migrateSettingsFile(src, dest, base = {}) {
	const sourceRaw = readJsonObjectMaybe(src)
	if (!sourceRaw && !hasKeys(base)) return
	const source = sourceRaw ? normalizeSettingsShape(sourceRaw) : {}
	const currentRaw = readJsonObjectMaybe(dest)
	const current = currentRaw ? normalizeSettingsShape(currentRaw) : {}
	writeJsonFile(dest, mergeSettingsObjects(mergeSettingsObjects(base, source), current))
	if (sourceRaw) rmSync(src, { force: true })
}

/** @param {string} src @param {string} dest */
function moveIfDestinationMissing(src, dest) {
	if (!pathExists(src)) return
	ensureDir(dirname(dest))
	if (!pathExists(dest)) renameSync(src, dest)
	else rmSync(src, { force: true })
}

/** @param {string} src @param {string} dest */
function migrateWebToken(src, dest) {
	if (!pathExists(src)) return
	const legacyToken = readFileSync(src, "utf-8").trim()
	const currentToken = pathExists(dest) ? readFileSync(dest, "utf-8").trim() : ""
	if (currentToken.length < WEB_TOKEN_MIN_LENGTH && legacyToken.length >= WEB_TOKEN_MIN_LENGTH) {
		ensureDir(dirname(dest))
		writeFileSync(dest, legacyToken, { mode: 0o600 })
	}
	rmSync(src, { force: true })
}

/** @param {string} dir */
function activeContextFile(dir) {
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(dir, name)
		if (pathExists(path)) return path
	}
	return undefined
}

/** @param {string} src @param {string} dest */
function appendContextFile(src, dest) {
	const source = readFileSync(src, "utf-8")
	const current = readFileSync(dest, "utf-8")
	if (source && !current.includes(source)) {
		const separator = current.endsWith("\n") ? "\n" : "\n\n"
		writeFileSync(dest, `${current}${separator}${source}${source.endsWith("\n") ? "" : "\n"}`)
	}
	rmSync(src, { force: true })
}

/** @param {string} home @param {string} configDir */
function migrateContextFiles(home, configDir) {
	const legacyActive = activeContextFile(configDir)
	if (legacyActive) {
		const topActive = activeContextFile(home)
		if (topActive) appendContextFile(legacyActive, topActive)
		else moveIfDestinationMissing(legacyActive, join(home, basename(legacyActive)))
	}
	for (const name of CONTEXT_FILE_NAMES) {
		moveIfDestinationMissing(join(configDir, name), join(home, name))
	}
}

/** @param {string} configDir @param {string} home */
function migrateAuthDir(configDir, home) {
	const legacyAuthDir = join(configDir, "auth")
	if (!isDirectory(legacyAuthDir)) return
	const targetAuthDir = join(home, "auth")
	for (const entry of readdirSync(legacyAuthDir, { withFileTypes: true })) {
		const src = join(legacyAuthDir, entry.name)
		if (entry.isFile() && entry.name.endsWith(".lock")) {
			rmSync(src, { force: true })
			continue
		}
		if (!entry.isFile() && !entry.isSymbolicLink()) continue
		if (!entry.name.endsWith(".json")) continue
		ensureDir(targetAuthDir, 0o700)
		moveIfDestinationMissing(src, join(targetAuthDir, entry.name))
	}
	try {
		if (readdirSync(legacyAuthDir).length === 0) rmSync(legacyAuthDir, { recursive: true })
	} catch (/** @type {any} */ err) {
		if (err.code !== "ENOENT") throw err
	}
}

/** @param {string} dir */
function removeEmptyDir(dir) {
	try {
		if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
	} catch (/** @type {any} */ err) {
		if (err.code !== "ENOENT") throw err
	}
}

/** @param {string} home */
export function migrateLegacyConfigDirSync(home) {
	const configDir = join(home, "config")
	if (!isDirectory(configDir)) return
	const servicePath = join(configDir, "service.json")
	const serviceRaw = readJsonObjectMaybe(servicePath)
	const serviceSettings = serviceRaw ? settingsFromServiceConfig(serviceRaw) : {}
	migrateSettingsFile(join(configDir, "settings.json"), join(home, "settings.json"), serviceSettings)
	if (serviceRaw) rmSync(servicePath, { force: true })
	migrateSettingsFile(join(configDir, "default-settings.json"), join(home, "default-settings.json"))
	moveIfDestinationMissing(join(configDir, "environments.json"), join(home, "environments.json"))
	migrateAuthDir(configDir, home)
	migrateWebToken(join(configDir, "web-token"), join(home, "data", "web-token"))
	migrateContextFiles(home, configDir)
	removeEmptyDir(configDir)
}
