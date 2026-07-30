import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getCredential, updateCredential } from "./credentials.js"

export const GIT_AUTH_CREDENTIAL_PROVIDER = "git"
export const GIT_AUTH_REQUIRED_CODE = "gitAuthRequired"

const GITHUB_HOSTS = new Set(["github.com"])
const GITLAB_HOSTS = new Set(["gitlab.com"])

/** @param {string} value */
const lower = (value) => String(value || "").toLowerCase()

/** @param {string} host */
export function gitProviderForHost(host) {
	const clean = lower(host)
	if (GITHUB_HOSTS.has(clean) || clean.endsWith(".github.com")) return "github"
	if (GITLAB_HOSTS.has(clean) || clean.endsWith(".gitlab.com")) return "gitlab"
	return "git"
}

function gitStoreWithoutLegacyAgentAccess(store) {
	const { githubAgentAccess: _legacyAgentAccess, ...rest } = store ?? {}
	return rest
}

/** Whether a repository host can use the github.com CLI proxy. */
export function isGithubCredentialHost(host) {
	return lower(host) === "github.com"
}

/** @param {string} host */
export function gitTokenUsernameForHost(host) {
	const provider = gitProviderForHost(host)
	if (provider === "github") return "x-access-token"
	if (provider === "gitlab") return "oauth2"
	return "git"
}

/**
 * @param {{ host: string, path: string }} scope
 */
export function gitCredentialScopeKey(scope) {
	return `${lower(scope.host)}/${scope.path}`
}

/** @param {string} value */
export function normalizeGitRemoteRepo(value) {
	const raw = typeof value === "string" ? value.trim() : ""
	if (!raw) return ""
	const stripRepoSuffix = (path) => path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")
	const scp = !raw.includes("://") ? raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/) : null
	if (scp) {
		const path = stripRepoSuffix(scp[2])
		return path ? `${scp[1]}/${path}` : ""
	}
	try {
		const url = new URL(raw)
		if (url.protocol === "file:") return ""
		const path = stripRepoSuffix(url.pathname)
		return url.host && path ? `${url.host}/${path}` : ""
	} catch {}
	const hostPath = raw.match(/^([A-Za-z0-9.-]+\.[A-Za-z0-9.-]+)\/(.+)$/)
	if (hostPath) {
		const path = stripRepoSuffix(hostPath[2])
		return path ? `${hostPath[1]}/${path}` : ""
	}
	return ""
}

/** @param {string} value */
export function gitCredentialScopeFromRemote(value) {
	const normalized = normalizeGitRemoteRepo(value)
	const [host = "", ...pathParts] = normalized.split("/").filter(Boolean)
	const path = pathParts.join("/")
	return host && path ? { host: lower(host), path, normalized } : undefined
}

function gitEntriesWithExplicitAgentAccess(store) {
	const legacyGithubAccess = store?.githubAgentAccess === true
	return Object.fromEntries(Object.entries(store?.entries ?? {}).map(([key, entry]) => [
		key,
		entry?.kind === "token" && isGithubCredentialHost(entry.host)
			? { ...entry, agentAccess: entry.agentAccess === true || (entry.agentAccess === undefined && legacyGithubAccess) }
			: entry,
	]))
}

/** @returns {Promise<Array<{ key: string, kind: "token", host: string, path: string, username: string, token: string, agentAccess: boolean, createdAt: number, updatedAt: number }>>} */
export async function listGitTokenCredentials() {
	const store = await getCredential(GIT_AUTH_CREDENTIAL_PROVIDER)
	if (store?.kind !== "git" || !store.entries || typeof store.entries !== "object") return []
	return Object.entries(gitEntriesWithExplicitAgentAccess(store))
		.filter(([, entry]) => entry?.kind === "token" && entry.token)
		.map(([key, entry]) => ({ ...entry, agentAccess: entry.agentAccess === true, key }))
		.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * Return credentials that may authenticate a repository, preferring the credential saved for that exact repository. Tokens are capabilities in their own right, so a same-host token may cover repositories beyond the one where it was first entered.
 * @param {{ host: string, path: string }} scope
 */
export async function gitTokenCredentialCandidates(scope) {
	const exactKey = gitCredentialScopeKey(scope)
	const host = lower(scope.host)
	const entries = (await listGitTokenCredentials()).filter((entry) => lower(entry.host) === host)
	return entries.sort((a, b) => Number(b.key === exactKey) - Number(a.key === exactKey))
}

/**
 * @param {{ host: string, path: string }} scope
 * @returns {Promise<{ username: string, token: string, host: string, path: string, createdAt: number, updatedAt: number } | undefined>}
 */
export async function getGitTokenCredential(scope) {
	const store = await getCredential(GIT_AUTH_CREDENTIAL_PROVIDER)
	if (store?.kind !== "git" || !store.entries || typeof store.entries !== "object") return undefined
	const entry = store.entries[gitCredentialScopeKey(scope)]
	if (entry?.kind !== "token" || !entry.token) return undefined
	return {
		username: entry.username || gitTokenUsernameForHost(scope.host),
		token: entry.token,
		host: entry.host || lower(scope.host),
		path: entry.path || scope.path,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	}
}

/**
 * @param {{ host: string, path: string }} scope
 * @param {string} token
 * @param {{ username?: string, agentAccess?: boolean }} [options]
 */
export async function saveGitTokenCredential(scope, token, options = {}) {
	const cleanToken = typeof token === "string" ? token.trim() : ""
	if (!cleanToken) throw new Error("Git access token is required")
	const now = Date.now()
	const key = gitCredentialScopeKey(scope)
	const username = options.username || gitTokenUsernameForHost(scope.host)
	await updateCredential(GIT_AUTH_CREDENTIAL_PROVIDER, (current) => {
		const previous = current?.kind === "git" ? current : undefined
		const entries = gitEntriesWithExplicitAgentAccess(previous)
		const previousEntry = entries[key]
		const agentAccess = typeof options.agentAccess === "boolean" ? options.agentAccess : previousEntry?.agentAccess === true
		return {
			...gitStoreWithoutLegacyAgentAccess(previous),
			kind: "git",
			entries: {
				...entries,
				[key]: {
					kind: "token",
					host: lower(scope.host),
					path: scope.path,
					username,
					token: cleanToken,
					...(isGithubCredentialHost(scope.host) ? { agentAccess } : {}),
					createdAt: previousEntry?.createdAt ?? now,
					updatedAt: now,
				},
			},
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		}
	}, { waitMs: 5000 })
}

/** @param {{ host: string, path: string }} scope @param {boolean} allowed */
export async function setGitTokenCredentialAgentAccess(scope, allowed) {
	if (!isGithubCredentialHost(scope.host)) throw new Error("Agent access is only supported for GitHub credentials")
	const key = gitCredentialScopeKey(scope)
	await updateCredential(GIT_AUTH_CREDENTIAL_PROVIDER, (current) => {
		if (current?.kind !== "git" || current.entries?.[key]?.kind !== "token") {
			throw Object.assign(new Error("GitHub credential not found"), { status: 404 })
		}
		const entries = gitEntriesWithExplicitAgentAccess(current)
		return {
			...gitStoreWithoutLegacyAgentAccess(current),
			kind: "git",
			entries: {
				...entries,
				[key]: { ...entries[key], agentAccess: allowed },
			},
			createdAt: current.createdAt,
			updatedAt: Date.now(),
		}
	}, { waitMs: 5000 })
}

/** @param {{ host: string, path: string }} scope */
export async function deleteGitTokenCredential(scope) {
	const key = gitCredentialScopeKey(scope)
	await updateCredential(GIT_AUTH_CREDENTIAL_PROVIDER, (current) => {
		if (current?.kind !== "git" || current.entries?.[key]?.kind !== "token") {
			throw Object.assign(new Error("Git credential not found"), { status: 404 })
		}
		const entries = gitEntriesWithExplicitAgentAccess(current)
		delete entries[key]
		return { ...gitStoreWithoutLegacyAgentAccess(current), kind: "git", entries, updatedAt: Date.now() }
	}, { waitMs: 5000 })
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

/**
 * @template T
 * @param {{ username: string, token: string }} credential
 * @param {(env: Record<string, string>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withGitAskPassCredential(credential, fn) {
	const dir = await mkdtemp(join(tmpdir(), "git-auth-"))
	const tokenFile = join(dir, "token")
	const askpassFile = join(dir, "askpass.sh")
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 })
		await writeFile(tokenFile, credential.token, { mode: 0o600 })
		await writeFile(askpassFile, [
			"#!/bin/sh",
			"case \"$1\" in",
			"*Username*) printf '%s\\n' \"${CEREX_GIT_USERNAME:-git}\" ;;",
			"*Password*) token=$(cat \"$CEREX_GIT_TOKEN_FILE\") || exit 1; printf '%s\\n' \"$token\" ;;",
			"*) printf '\\n' ;;",
			"esac",
			"",
		].join("\n"), { mode: 0o700 })
		await Promise.all([
			chmodBestEffort(dir, 0o700),
			chmodBestEffort(tokenFile, 0o600),
			chmodBestEffort(askpassFile, 0o700),
		])
		return await fn({
			GIT_ASKPASS: askpassFile,
			SSH_ASKPASS: askpassFile,
			CEREX_GIT_USERNAME: credential.username,
			CEREX_GIT_TOKEN_FILE: tokenFile,
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/**
 * @param {string | undefined} text
 * @param {string[]} [secrets]
 */
export function redactGitSecrets(text, secrets = []) {
	let result = String(text ?? "")
	result = result.replace(/\b(https?:\/\/)([^@\s/]+)@/gi, "$1<redacted>@")
	for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("<redacted>")
	return result
}
