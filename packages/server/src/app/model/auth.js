import { refreshCodex } from "../../ai-apis/codex/oauth.js"
import { getCredential, refreshCredential, resolveApiKey } from "../auth/credentials.js"

const CODEX_REFRESH_SKEW_MS = 60_000
const CODEX_REFRESH_LOCK_WAIT_MS = 30_000
const CODEX_REFRESH_LOCK_STALE_MS = 120_000

/**
 * @param {import("../auth/credentials.js").Credential | undefined} cred
 * @returns {import("../auth/credentials.js").CodexCredential}
 */
function requireCodexCredential(cred) {
	if (!cred || cred.kind !== "codex") throw new Error("No ChatGPT subscription credentials. Open credentials settings first.")
	return cred
}

/** @param {import("../auth/credentials.js").CodexCredential} cred */
function codexCredentialNeedsRefresh(cred) {
	return Boolean(cred.expiresAt && cred.expiresAt - Date.now() < CODEX_REFRESH_SKEW_MS)
}

/**
 * Return a fresh Codex OAuth credential, refreshing and persisting it when the
 * access token is close to expiry.
 *
 * @returns {Promise<import("../auth/credentials.js").CodexCredential>}
 */
export async function getFreshCodexCredential() {
	const cred = requireCodexCredential(await getCredential("openai-codex"))
	if (!codexCredentialNeedsRefresh(cred)) return cred
	return await refreshCredential("openai-codex", async (current) => {
		const locked = requireCodexCredential(current)
		if (!codexCredentialNeedsRefresh(locked)) return locked
		const fresh = await refreshCodex(locked.refresh)
		return {
			kind: "codex",
			access: fresh.access,
			refresh: fresh.refresh,
			idToken: /** @type {any} */ (fresh).idToken,
			accountId: fresh.accountId,
			expiresAt: fresh.expires,
			createdAt: Date.now(),
		}
	}, { waitMs: CODEX_REFRESH_LOCK_WAIT_MS, staleMs: CODEX_REFRESH_LOCK_STALE_MS })
}

/**
 * Resolve app-level auth into stream options for the current model. The lower
 * ai-apis layer only knows how to route a model once an access token/API key is
 * supplied; this helper owns credential storage and refresh.
 *
 * @param {import("../../agent-core/types.js").Model} model
 * @param {any} [options]
 * @returns {Promise<any>}
 */
export async function resolveModelStreamOptions(model, options = {}) {
	const provider = model.authProvider ?? model.provider
	if (provider === "openai-codex") {
		const cred = await getFreshCodexCredential()
		return {
			...options,
			apiKey: cred.access,
			auth: {
				...(options.auth ?? {}),
				provider: "openai-codex",
				credentialId: "openai-codex",
				accountId: cred.accountId,
			},
		}
	}
	const apiKey = (provider ? await resolveApiKey(provider) : undefined) ?? options.apiKey
	return {
		...options,
		apiKey,
		auth: {
			...(options.auth ?? {}),
			provider: provider ?? options.auth?.provider,
			credentialId: provider ?? options.auth?.credentialId,
		},
	}
}
