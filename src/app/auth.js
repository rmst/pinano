// Multi-provider auth storage.
//
// One file per provider under $configRoot/auth/<provider>.json. Each file is
// a small JSON document — shape is provider-defined but the registry below
// captures the common ones we use.
//
// We deliberately keep the surface tiny: API-key credentials plus Codex
// (ChatGPT subscription) OAuth. Adding a provider is a matter of adding a new
// credential type to the union below when API keys are not enough.

import { rmSync } from "node:fs"
import { chmod, mkdir, open, readFile, rm, stat, writeFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { configuredProviderApiKey } from "./service-config.js"
import { authDir, authFilePath } from "./paths.js"

const LOCK_TTL_MS = 30_000

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
	await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
	await chmodBestEffort(path, 0o600)
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

/** @typedef {ApiKeyCredential | CodexCredential} Credential */

/** @type {Set<string> | undefined} */
let exitCleanup

function ensureExitCleanup() {
	if (exitCleanup) return exitCleanup
	exitCleanup = new Set()
	process.on("exit", () => {
		for (const lockPath of exitCleanup) {
			try {
				rmSync(lockPath, { force: true })
			} catch {}
		}
	})
	return exitCleanup
}

/** @param {string} lockPath */
async function acquireLock(lockPath) {
	const set = ensureExitCleanup()
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = await open(lockPath, "wx")
			await fd.close()
			set.add(lockPath)
			return
		} catch (/** @type {any} */ err) {
			if (err.code !== "EEXIST") throw err
			try {
				const s = await stat(lockPath)
				if (Date.now() - s.mtimeMs > LOCK_TTL_MS) {
					await rm(lockPath, { force: true })
					continue
				}
			} catch {}
			throw new Error(`Auth file is locked: ${lockPath}`)
		}
	}
}

/** @param {string} lockPath */
async function releaseLock(lockPath) {
	ensureExitCleanup().delete(lockPath)
	await rm(lockPath, { force: true })
}

/**
 * @template {Credential} [T=Credential]
 * @param {string} provider
 * @returns {Promise<T | undefined>}
 */
export async function getCredential(provider) {
	try {
		const text = await readFile(authFilePath(provider), "utf-8")
		return /** @type {T} */ (JSON.parse(text))
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

/**
 * @param {string} provider
 * @param {Credential} value
 * @returns {Promise<void>}
 */
export async function setCredential(provider, value) {
	const path = resolve(authFilePath(provider))
	const lockPath = `${path}.lock`
	await ensureCredentialDir(path)
	await acquireLock(lockPath)
	try {
		await writeCredentialFile(path, value)
	} finally {
		await releaseLock(lockPath)
	}
}

/**
 * @template {Credential} T
 * @param {string} provider
 * @param {(current: T | undefined) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function updateCredential(provider, fn) {
	const path = resolve(authFilePath(provider))
	const lockPath = `${path}.lock`
	await ensureCredentialDir(path)
	await acquireLock(lockPath)
	try {
		/** @type {T | undefined} */
		let current
		try {
			current = /** @type {T} */ (JSON.parse(await readFile(path, "utf-8")))
		} catch (/** @type {any} */ err) {
			if (err.code !== "ENOENT") throw err
		}
		const next = await fn(current)
		await writeCredentialFile(path, next)
		return next
	} finally {
		await releaseLock(lockPath)
	}
}

/**
 * @param {string} provider
 * @returns {Promise<void>}
 */
export async function deleteCredential(provider) {
	await rm(authFilePath(provider), { force: true })
}

/** @returns {Promise<string[]>} */
export async function listProviders() {
	try {
		const entries = await readdir(authDir())
		return entries
			.filter((n) => n.endsWith(".json") && !n.endsWith(".lock"))
			.map((n) => n.replace(/\.json$/, ""))
			.sort()
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return []
		throw err
	}
}

/**
 * Resolve an API key for `provider`. Falls back to providers.<provider>.apiKey
 * in config/service.json when no credential is on disk. Returns undefined if
 * neither is available.
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
 * Returns true once at least one usable credential is configured in Pinano's
 * credential store or service config. Environment variables intentionally do
 * not count here: onboarding should still offer to import them into Pinano.
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
