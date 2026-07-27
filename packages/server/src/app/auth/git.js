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

/**
 * @param {{ host: string, path: string }} scope
 * @returns {Promise<{ username: string, token: string, host: string, path: string } | undefined>}
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
	}
}

/**
 * @param {{ host: string, path: string }} scope
 * @param {string} token
 * @param {{ username?: string }} [options]
 */
export async function saveGitTokenCredential(scope, token, options = {}) {
	const cleanToken = typeof token === "string" ? token.trim() : ""
	if (!cleanToken) throw new Error("Git access token is required")
	const now = Date.now()
	const key = gitCredentialScopeKey(scope)
	const username = options.username || gitTokenUsernameForHost(scope.host)
	await updateCredential(GIT_AUTH_CREDENTIAL_PROVIDER, (current) => {
		const previous = current?.kind === "git" ? current : undefined
		const previousEntry = previous?.entries?.[key]
		return {
			kind: "git",
			entries: {
				...(previous?.entries ?? {}),
				[key]: {
					kind: "token",
					host: lower(scope.host),
					path: scope.path,
					username,
					token: cleanToken,
					createdAt: previousEntry?.createdAt ?? now,
					updatedAt: now,
				},
			},
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		}
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
