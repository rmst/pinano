// Multi-provider auth storage.
//
// One file per provider. Providers use the current Cerex home's private auth
// directory unless deployment-owned configuration explicitly routes them to
// another store. Each file is a small JSON document — shape is provider-defined
// but the registry below captures the common ones we use.
//
// We deliberately keep the surface tiny: API-key credentials plus Codex
// (ChatGPT subscription) OAuth. Adding a provider is a matter of adding a new
// credential type to the union below when API keys are not enough.

import { readFileSync, rmSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

import { readProductEnv } from "../../../../protocol/src/product.js"
import { configuredProviderApiKey } from "../service/config.js"
import { authDir } from "../paths.js"
import { CredentialStoreRouter, credentialStoreRouterFromConfig } from "./credential-store-router.js"

const LOCK_TTL_MS = 30_000
const LOCK_RETRY_DELAY_MS = 50

/** @type {CredentialStoreRouter} */
let credentialStores = new CredentialStoreRouter(authDir)

/** @param {unknown} config */
export function configureCredentialStores(config = {}) {
	credentialStores = credentialStoreRouterFromConfig(authDir, config)
}

/** @param {Record<string, string | undefined>} [env] */
export function configureCredentialStoresFromEnvironment(env = process.env) {
	const configPath = readProductEnv(env, "CREDENTIAL_STORES_FILE")
	if (!configPath) {
		configureCredentialStores()
		return
	}
	if (!isAbsolute(configPath)) throw new Error("CEREX_CREDENTIAL_STORES_FILE must be an absolute path")
	let config
	try {
		config = JSON.parse(readFileSync(configPath, "utf-8"))
	} catch (err) {
		throw new Error(`Could not load credential stores configuration from ${configPath}`, { cause: err })
	}
	configureCredentialStores(config)
}

/** @param {string} provider */
export function credentialFilePath(provider) {
	return credentialStores.filePath(provider)
}

/** @param {string} provider */
export function credentialIsManaged(provider) {
	return credentialStores.isManaged(provider)
}

/** @param {string} provider */
function managedCredentialError(provider) {
	const error = /** @type {Error & { code: string }} */ (new Error(`Credential for ${provider} is managed by this Cerex deployment`))
	error.code = "CEREX_CREDENTIAL_MANAGED"
	return error
}

/**
 * @param {string} provider
 * @param {boolean} allowManaged
 */
function assertCredentialMutationAllowed(provider, allowManaged) {
	if (credentialIsManaged(provider) && !allowManaged) throw managedCredentialError(provider)
}

/**
 * @param {string} path
 * @param {number} mode
 */
async function chmodBestEffort(path, mode) {
	try {
		await chmod(path, mode)
	} catch {}
}

/** @param {string} path */
async function ensureCredentialDir(path) {
	const dir = dirname(path)
	await mkdir(dir, { recursive: true, mode: 0o700 })
	await chmodBestEffort(dir, 0o700)
}

/**
 * @param {string} path
 * @param {Credential} value
 */
async function writeCredentialFile(path, value) {
	const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`
	try {
		await writeFile(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 })
		await chmodBestEffort(tmpPath, 0o600)
		await rename(tmpPath, path)
		await chmodBestEffort(path, 0o600)
	} catch (err) {
		await rm(tmpPath, { force: true })
		throw err
	}
}

export const API_KEY_PROVIDER_INFOS = /** @type {const} */ ([
	{
		provider: "openai",
		label: "OpenAI",
		envVars: ["OPENAI_API_KEY"],
	},
	{
		provider: "moonshot",
		label: "Moonshot",
		envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
	},
	{
		provider: "deepseek",
		label: "DeepSeek",
		envVars: ["DEEPSEEK_API_KEY"],
	},
	{
		provider: "llamacpp",
		label: "Local OpenAI-compatible",
		envVars: ["LLAMACPP_API_KEY"],
	},
])

/** @typedef {(typeof API_KEY_PROVIDER_INFOS)[number]["provider"]} ApiKeyProvider */

/**
 * OpenAI cloud + OpenAI-compatible (llamacpp, etc.) — bare API key.
 * @typedef {object} ApiKeyCredential
 * @property {"apiKey"} kind
 * @property {string} apiKey
 * @property {number} createdAt
 */

/**
 * Codex (ChatGPT subscription) — OAuth tokens with refresh.
 * @typedef {object} CodexCredential
 * @property {"codex"} kind
 * @property {string} access
 * @property {string} refresh
 * @property {string} [idToken]
 * @property {string} [accountId]
 * @property {number} expiresAt
 * @property {number} createdAt
 */

/**
 * Git repository token credentials. The key is a normalized remote scope such
 * as `github.com/owner/repo`.
 * @typedef {object} GitTokenCredentialEntry
 * @property {"token"} kind
 * @property {string} host
 * @property {string} path
 * @property {string} username
 * @property {string} token
 * @property {boolean} [agentAccess]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * Git repository credentials.
 * @typedef {object} GitCredential
 * @property {"git"} kind
 * @property {Record<string, GitTokenCredentialEntry>} entries
 * @property {boolean} [githubAgentAccess] Legacy global GitHub-agent permission, migrated to per-entry `agentAccess` when the store is updated.
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @typedef {ApiKeyCredential | CodexCredential | GitCredential} Credential */

/** @type {Map<string, string> | undefined} */
let exitCleanup

function ensureExitCleanup() {
	if (exitCleanup) return exitCleanup
	exitCleanup = new Map()
	process.on("exit", () => {
		for (const [lockPath, token] of exitCleanup) {
			try {
				if (readFileSync(lockPath, "utf-8") === token) rmSync(lockPath, { force: true })
			} catch {}
		}
	})
	return exitCleanup
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lockToken() {
	return `${process.pid}:${Date.now()}:${Math.random()}`
}

/**
 * @param {string} lockPath
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<string>}
 */
async function acquireLock(lockPath, options = {}) {
	const set = ensureExitCleanup()
	const waitMs = Math.max(0, options.waitMs ?? 0)
	const staleMs = Math.max(0, options.staleMs ?? LOCK_TTL_MS)
	const deadline = Date.now() + waitMs
	for (;;) {
		try {
			const token = lockToken()
			const fd = await open(lockPath, "wx", 0o600)
			try {
				await fd.writeFile(token)
			} finally {
				await fd.close()
			}
			set.set(lockPath, token)
			return token
		} catch (/** @type {any} */ err) {
			if (err.code !== "EEXIST") throw err
			try {
				const s = await stat(lockPath)
				if (Date.now() - s.mtimeMs > staleMs) {
					await rm(lockPath, { force: true })
					continue
				}
			} catch (/** @type {any} */ statErr) {
				if (statErr.code === "ENOENT") continue
			}
			const remaining = deadline - Date.now()
			if (remaining <= 0) throw new Error(`Auth file is locked: ${lockPath}`)
			await sleep(Math.min(LOCK_RETRY_DELAY_MS, remaining))
		}
	}
}

/**
 * @param {string} lockPath
 * @param {string} token
 */
async function lockIsOwned(lockPath, token) {
	try {
		return await readFile(lockPath, "utf-8") === token
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return false
		throw err
	}
}

/**
 * @param {string} lockPath
 * @param {string} token
 */
async function assertLockOwned(lockPath, token) {
	if (await lockIsOwned(lockPath, token)) return
	throw new Error(`Auth file lock was lost: ${lockPath}`)
}

/**
 * @param {string} lockPath
 * @param {string} token
 */
async function releaseLock(lockPath, token) {
	ensureExitCleanup().delete(lockPath)
	if (await lockIsOwned(lockPath, token)) await rm(lockPath, { force: true })
}

/**
 * @template {Credential} [T=Credential]
 * @param {string} provider
 * @returns {Promise<T | undefined>}
 */
export async function getCredential(provider) {
	try {
		const text = await readFile(credentialFilePath(provider), "utf-8")
		return /** @type {T} */ (JSON.parse(text))
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

/**
 * @param {string} provider
 * @param {Credential} value
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function setCredential(provider, value, options = {}) {
	assertCredentialMutationAllowed(provider, false)
	const path = resolve(credentialFilePath(provider))
	const lockPath = `${path}.lock`
	await ensureCredentialDir(path)
	const token = await acquireLock(lockPath, options)
	try {
		await assertLockOwned(lockPath, token)
		await writeCredentialFile(path, value)
	} finally {
		await releaseLock(lockPath, token)
	}
}

/**
 * @template {Credential} T
 * @param {string} provider
 * @param {(current: T | undefined) => Promise<T> | T} fn
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @param {boolean} allowManaged
 * @returns {Promise<T>}
 */
async function updateCredentialValue(provider, fn, options, allowManaged) {
	assertCredentialMutationAllowed(provider, allowManaged)
	const path = resolve(credentialFilePath(provider))
	const lockPath = `${path}.lock`
	await ensureCredentialDir(path)
	const token = await acquireLock(lockPath, options)
	try {
		/** @type {T | undefined} */
		let current
		try {
			current = /** @type {T} */ (JSON.parse(await readFile(path, "utf-8")))
		} catch (/** @type {any} */ err) {
			if (err.code !== "ENOENT") throw err
		}
		const next = await fn(current)
		await assertLockOwned(lockPath, token)
		await writeCredentialFile(path, next)
		return next
	} finally {
		await releaseLock(lockPath, token)
	}
}

/**
 * @template {Credential} T
 * @param {string} provider
 * @param {(current: T | undefined) => Promise<T> | T} fn
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function updateCredential(provider, fn, options = {}) {
	return await updateCredentialValue(provider, fn, options, false)
}

/**
 * Update a credential as part of its runtime lifecycle. Unlike user-managed
 * changes, this permits token rotation in a deployment-managed store.
 *
 * @template {Credential} T
 * @param {string} provider
 * @param {(current: T | undefined) => Promise<T> | T} fn
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function refreshCredential(provider, fn, options = {}) {
	return await updateCredentialValue(provider, fn, options, true)
}

/**
 * @param {string} provider
 * @param {{ waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function deleteCredential(provider, options = {}) {
	assertCredentialMutationAllowed(provider, false)
	const path = resolve(credentialFilePath(provider))
	const lockPath = `${path}.lock`
	await ensureCredentialDir(path)
	const token = await acquireLock(lockPath, options)
	try {
		await assertLockOwned(lockPath, token)
		await rm(path, { force: true })
	} finally {
		await releaseLock(lockPath, token)
	}
}

/** @param {string} directory */
async function listProvidersInDirectory(directory) {
	try {
		const entries = await readdir(directory)
		return entries
			.filter((n) => n.endsWith(".json") && !n.endsWith(".lock"))
			.map((n) => n.replace(/\.json$/, ""))
			.filter((provider) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return []
		throw err
	}
}

/** @returns {Promise<string[]>} */
export async function listProviders() {
	const configuredRoutes = credentialStores.configuredRoutes()
	const configuredProviders = new Set(configuredRoutes.map((route) => route.provider))
	const providers = new Set((await listProvidersInDirectory(authDir())).filter((provider) => !configuredProviders.has(provider)))
	for (const route of configuredRoutes) {
		if (await getCredential(route.provider)) providers.add(route.provider)
	}
	return [...providers].sort()
}

/**
 * Resolve an API key for `provider`. Falls back to
 * settings.providers.<provider>.apiKey when no credential is on disk. Returns
 * undefined if neither is available.
 *
 * @param {string} provider
 * @returns {Promise<string | undefined>}
 */
export async function resolveApiKey(provider) {
	const stored = await getCredential(provider)
	if (stored?.kind === "apiKey" && stored.apiKey) return stored.apiKey
	if (stored?.kind === "codex" && stored.access) return stored.access
	return configuredProviderApiKey(provider)
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ provider: ApiKeyProvider, providerLabel: string, envVar: string, apiKey: string }[]}
 */
export function detectedEnvApiKeys(env = process.env) {
	const byProvider = new Map()
	for (const info of API_KEY_PROVIDER_INFOS) {
		const found = info.envVars
			.map((envVar) => ({ envVar, apiKey: env[envVar]?.trim() ?? "" }))
			.find((candidate) => candidate.apiKey.length > 0)
		if (found) byProvider.set(info.provider, {
			provider: info.provider,
			providerLabel: info.label,
			envVar: found.envVar,
			apiKey: found.apiKey,
		})
	}
	return [...byProvider.values()]
}

/**
 * Returns true once at least one usable credential is configured in Cerex's
 * credential store or merged settings. Environment variables intentionally do
 * not count here: onboarding should still offer to import them into Cerex.
 *
 * @returns {Promise<boolean>}
 */
export async function hasConfiguredProviderCredentials() {
	for (const provider of await listProviders()) {
		const cred = await getCredential(provider)
		if (cred?.kind === "apiKey" && cred.apiKey) return true
		if (cred?.kind === "codex" && (cred.refresh || cred.access)) return true
	}
	return API_KEY_PROVIDER_INFOS.some((info) => Boolean(configuredProviderApiKey(info.provider)))
}
