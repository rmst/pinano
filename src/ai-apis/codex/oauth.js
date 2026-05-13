// OAuth 2.0 Authorization Code + PKCE flow against ChatGPT (Codex client).
//
// This is the same flow the ChatGPT desktop / Codex CLI uses. It hits
// the public ChatGPT auth endpoints with a *known* client_id leaked from
// the desktop app — undocumented, no SLA, OpenAI may rotate at any time.
//
// Two phases:
//   1. loginCodex(): start a localhost HTTP server, give caller the
//      authorize URL, wait for the redirect, exchange the code for tokens.
//   2. refreshCodex(refresh_token): swap a refresh token for a fresh
//      access/refresh pair when the access token nears expiry.
//
// Endpoints are overridable via configureOAuthEndpoints() so tests can
// point them at a mock server.

import { createServer } from "node:http"
import { generatePKCE } from "./pkce.js"
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js"

const DEFAULTS = {
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	authorizeUrl: "https://auth.openai.com/oauth/authorize",
	tokenUrl: "https://auth.openai.com/oauth/token",
	redirectUri: "http://localhost:1455/auth/callback",
	scope: "openid profile email offline_access",
	callbackHost: "127.0.0.1",
	callbackPort: 1455,
	callbackPath: "/auth/callback",
	originator: "pi",
}

const config = { ...DEFAULTS }

const JWT_CLAIM_PATH = "https://api.openai.com/auth"

/**
 * Override OAuth endpoints. Mainly for tests; call with no args (or omit
 * keys) to keep defaults.
 */
export function configureOAuthEndpoints(overrides = {}) {
	Object.assign(config, overrides)
}

export function resetOAuthEndpoints() {
	for (const k of Object.keys(config)) delete config[k]
	Object.assign(config, DEFAULTS)
}

function randomState() {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function decodeJwt(token) {
	try {
		const parts = token.split(".")
		if (parts.length !== 3) return null
		// base64url -> base64
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/")
		const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
		return JSON.parse(atob(padded + padding))
	} catch {
		return null
	}
}

function getAccountId(accessToken) {
	const payload = decodeJwt(accessToken)
	const auth = payload?.[JWT_CLAIM_PATH]
	const id = auth?.chatgpt_account_id
	return typeof id === "string" && id.length > 0 ? id : null
}

function parseAuthorizationInput(input) {
	const value = input.trim()
	if (!value) return {}
	try {
		const url = new URL(value)
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		}
	} catch {}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2)
		return { code, state }
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value)
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined }
	}
	return { code: value }
}

async function exchangeAuthorizationCode(code, verifier) {
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: config.clientId,
			code,
			code_verifier: verifier,
			redirect_uri: config.redirectUri,
		}),
	})
	if (!response.ok) {
		const text = await response.text().catch(() => "")
		throw new Error(`Token exchange failed: ${response.status} ${text}`)
	}
	const json = await response.json()
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error(`Token response missing fields: ${JSON.stringify(json)}`)
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	}
}

async function exchangeRefreshToken(refreshToken) {
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: config.clientId,
		}),
	})
	if (!response.ok) {
		const text = await response.text().catch(() => "")
		throw new Error(`Token refresh failed: ${response.status} ${text}`)
	}
	const json = await response.json()
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error(`Refresh response missing fields: ${JSON.stringify(json)}`)
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	}
}

/**
 * Build the authorize URL the user must visit. Returns the URL plus the
 * verifier and state so the caller can complete the exchange after the
 * redirect.
 */
export async function buildAuthorizationUrl({ originator } = {}) {
	const { verifier, challenge } = await generatePKCE()
	const state = randomState()
	const url = new URL(config.authorizeUrl)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("client_id", config.clientId)
	url.searchParams.set("redirect_uri", config.redirectUri)
	url.searchParams.set("scope", config.scope)
	url.searchParams.set("code_challenge", challenge)
	url.searchParams.set("code_challenge_method", "S256")
	url.searchParams.set("state", state)
	url.searchParams.set("id_token_add_organizations", "true")
	url.searchParams.set("codex_cli_simplified_flow", "true")
	url.searchParams.set("originator", originator ?? config.originator)
	return { url: url.toString(), verifier, state }
}

function startCallbackServer(state) {
	let resolveCode
	let rejectCode
	const codePromise = new Promise((resolve, reject) => {
		resolveCode = resolve
		rejectCode = reject
	})

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`)
			if (url.pathname !== config.callbackPath) {
				res.statusCode = 404
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end(oauthErrorHtml("Callback route not found."))
				return
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end(oauthErrorHtml("State mismatch."))
				return
			}
			const code = url.searchParams.get("code")
			if (!code) {
				res.statusCode = 400
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end(oauthErrorHtml("Missing authorization code."))
				return
			}
			res.statusCode = 200
			res.setHeader("Content-Type", "text/html; charset=utf-8")
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."))
			resolveCode(code)
		} catch (err) {
			res.statusCode = 500
			res.setHeader("Content-Type", "text/html; charset=utf-8")
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."))
			rejectCode(err)
		}
	})

	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(config.callbackPort, config.callbackHost, () => {
			resolve({
				port: server.address().port,
				close: () => new Promise((r) => server.close(() => r())),
				waitForCode: () => codePromise,
				cancel: (reason) => rejectCode(new Error(reason ?? "cancelled")),
			})
		})
	})
}

/**
 * Run the full Codex login flow.
 *
 * Required callbacks:
 *   onAuth({ url }): fired with the URL the user must visit. The caller
 *     is responsible for opening it (e.g. with `open` shell command or
 *     just printing it).
 *
 * Optional:
 *   onPrompt({ message }): if the local callback server can't bind
 *     (port in use), we fall back to asking the user to paste the code
 *     or full redirect URL by hand.
 *   originator: identifier sent in the authorize URL. Default "pi".
 *   signal: AbortSignal — aborts the flow.
 *
 * Returns: { access, refresh, expires, accountId }
 */
export async function loginCodex({ onAuth, onPrompt, originator, signal } = {}) {
	if (typeof onAuth !== "function") throw new Error("loginCodex requires an onAuth callback")

	const { url, verifier, state } = await buildAuthorizationUrl({ originator })
	let server
	try {
		server = await startCallbackServer(state)
	} catch (err) {
		// Port unavailable — fall back to manual paste.
		if (typeof onPrompt !== "function") {
			throw new Error(
				`Could not bind local callback server (${err.message}). ` +
					`Pass onPrompt to fall back to manual code entry.`,
			)
		}
		onAuth({ url, instructions: "Open this URL, complete login, and paste the redirect URL or code below." })
		const input = await onPrompt({ message: "Paste the authorization code or full redirect URL:" })
		const parsed = parseAuthorizationInput(input)
		if (parsed.state && parsed.state !== state) throw new Error("State mismatch")
		if (!parsed.code) throw new Error("Missing authorization code")
		const tokens = await exchangeAuthorizationCode(parsed.code, verifier)
		const accountId = getAccountId(tokens.access)
		if (!accountId) throw new Error("Failed to extract accountId from token")
		return { ...tokens, accountId }
	}

	try {
		onAuth({ url, instructions: "A browser window should open. Complete login to finish." })

		const codePromise = server.waitForCode()
		const code = signal
			? await Promise.race([
					codePromise,
					new Promise((_, reject) => {
						if (signal.aborted) reject(new Error("Aborted"))
						signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
					}),
				])
			: await codePromise

		const tokens = await exchangeAuthorizationCode(code, verifier)
		const accountId = getAccountId(tokens.access)
		if (!accountId) throw new Error("Failed to extract accountId from token")
		return { ...tokens, accountId }
	} finally {
		if (server) await server.close()
	}
}

/**
 * Refresh an access token using a stored refresh token. Returns a fresh
 * credential set with the same shape as loginCodex().
 */
export async function refreshCodex(refreshToken) {
	const tokens = await exchangeRefreshToken(refreshToken)
	const accountId = getAccountId(tokens.access)
	if (!accountId) throw new Error("Failed to extract accountId from token")
	return { ...tokens, accountId }
}

// Internal exports for tests.
export const _internal = {
	parseAuthorizationInput,
	decodeJwt,
	getAccountId,
	exchangeAuthorizationCode,
	exchangeRefreshToken,
	startCallbackServer,
}
