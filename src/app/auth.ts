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

import { authDir, authFilePath } from "./paths.ts"

const LOCK_TTL_MS = 30_000

/** OpenAI cloud + OpenAI-compatible (llamacpp, etc.) — bare API key. */
export interface ApiKeyCredential {
	kind: "apiKey"
	apiKey: string
	createdAt: number
}

/** Codex (ChatGPT subscription) — OAuth tokens with refresh. */
export interface CodexCredential {
	kind: "codex"
	access: string
	refresh: string
	idToken?: string
	accountId?: string
	expiresAt: number
	createdAt: number
}

export type Credential = ApiKeyCredential | CodexCredential

let exitCleanup: Set<string> | undefined

function ensureExitCleanup() {
	if (exitCleanup) return exitCleanup
	exitCleanup = new Set()
	process.on("exit", () => {
		for (const lockPath of exitCleanup!) {
			try {
				rmSync(lockPath, { force: true })
			} catch {}
		}
	})
	return exitCleanup
}

async function acquireLock(lockPath: string) {
	const set = ensureExitCleanup()
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = await open(lockPath, "wx")
			await fd.close()
			set.add(lockPath)
			return
		} catch (err: any) {
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

async function releaseLock(lockPath: string) {
	ensureExitCleanup().delete(lockPath)
	await rm(lockPath, { force: true })
}

export async function getCredential<T extends Credential = Credential>(provider: string): Promise<T | undefined> {
	try {
		const text = await readFile(authFilePath(provider), "utf-8")
		return JSON.parse(text) as T
	} catch (err: any) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

export async function setCredential(provider: string, value: Credential): Promise<void> {
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

export async function updateCredential<T extends Credential>(
	provider: string,
	fn: (current: T | undefined) => Promise<T> | T,
): Promise<T> {
	const path = resolve(authFilePath(provider))
	const lockPath = `${path}.lock`
	await mkdir(dirname(path), { recursive: true })
	await acquireLock(lockPath)
	try {
		let current: T | undefined
		try {
			current = JSON.parse(await readFile(path, "utf-8")) as T
		} catch (err: any) {
			if (err.code !== "ENOENT") throw err
		}
		const next = await fn(current)
		await writeFile(path, JSON.stringify(next, null, 2))
		return next
	} finally {
		await releaseLock(lockPath)
	}
}

export async function deleteCredential(provider: string): Promise<void> {
	await rm(authFilePath(provider), { force: true })
}

export async function listProviders(): Promise<string[]> {
	try {
		const entries = await readdir(authDir())
		return entries
			.filter((n) => n.endsWith(".json") && !n.endsWith(".lock"))
			.map((n) => n.replace(/\.json$/, ""))
			.sort()
	} catch (err: any) {
		if (err.code === "ENOENT") return []
		throw err
	}
}

/**
 * Per-provider env-var fallbacks when no credential is on disk.
 * Keep this small — only what we actually use.
 */
const ENV_FALLBACK: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	llamacpp: "LLAMACPP_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
}

/**
 * Resolve an API key for `provider`. Falls back to the relevant env var when
 * no credential is on disk. Returns undefined if neither is available.
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const stored = await getCredential(provider)
	if (stored?.kind === "apiKey" && stored.apiKey) return stored.apiKey
	if (stored?.kind === "codex" && stored.access) return stored.access
	const envVar = ENV_FALLBACK[provider]
	if (envVar) return process.env[envVar]
	return undefined
}
