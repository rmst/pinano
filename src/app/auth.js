// Multi-provider auth storage.
//
// One file per provider under $configRoot/auth/<provider>.json. Each file is
// a small JSON document — shape is provider-defined but the registry below
// captures the common ones we use.
//
// We deliberately keep the surface tiny — we only support the OpenAI ecosystem
// for now (api key + Codex OAuth). Adding a provider is a matter of adding a
// new credential type to the union below.

import { rmSync } from "node:fs"
import { mkdir, open, readFile, rm, stat, writeFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { authDir, authFilePath } from "./paths.js"

const LOCK_TTL_MS = 30_000

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
	await mkdir(dirname(path), { recursive: true })
	await acquireLock(lockPath)
	try {
		await writeFile(path, JSON.stringify(value, null, 2))
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
	await mkdir(dirname(path), { recursive: true })
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
		await writeFile(path, JSON.stringify(next, null, 2))
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
 * Per-provider env-var fallbacks when no credential is on disk.
 * Keep this small — only what we actually use.
 * @type {Record<string, string>}
 */
const ENV_FALLBACK = {
	openai: "OPENAI_API_KEY",
	llamacpp: "LLAMACPP_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
}

/**
 * Resolve an API key for `provider`. Falls back to the relevant env var when
 * no credential is on disk. Returns undefined if neither is available.
 *
 * @param {string} provider
 * @returns {Promise<string | undefined>}
 */
export async function resolveApiKey(provider) {
	const stored = await getCredential(provider)
	if (stored?.kind === "apiKey" && stored.apiKey) return stored.apiKey
	if (stored?.kind === "codex" && stored.access) return stored.access
	const envVar = ENV_FALLBACK[provider]
	if (envVar) return process.env[envVar]
	return undefined
}
