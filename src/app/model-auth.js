import { refreshCodex } from "../ai-apis/codex/oauth.js"
import { getCredential, resolveApiKey, updateCredential } from "./auth.js"

/**
 * Return a fresh Codex OAuth credential, refreshing and persisting it when the
 * access token is close to expiry.
 *
 * @returns {Promise<import("./auth.js").CodexCredential>}
 */
export async function getFreshCodexCredential() {
	let cred = await getCredential("openai-codex")
	if (!cred || cred.kind !== "codex") throw new Error("No ChatGPT subscription credentials. Open credentials settings first.")
	if (cred.expiresAt && cred.expiresAt - Date.now() < 60_000) {
		const fresh = await refreshCodex(cred.refresh)
		cred = await updateCredential("openai-codex", () => ({
			kind: "codex",
			access: fresh.access,
			refresh: fresh.refresh,
			idToken: /** @type {any} */ (fresh).idToken,
			accountId: fresh.accountId,
			expiresAt: fresh.expires,
			createdAt: Date.now(),
		}))
	}
	return /** @type {import("./auth.js").CodexCredential} */ (cred)
}

/**
 * Resolve app-level auth into stream options for the current model. The lower
 * ai-apis layer only knows how to route a model once an access token/API key is
 * supplied; this helper owns credential storage and refresh.
 *
 * @param {import("../agent-core/types.js").Model} model
 * @param {any} [options]
 * @returns {Promise<any>}
 */
export async function resolveModelStreamOptions(model, options = {}) {
	if (model.provider === "openai-codex") {
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
	const apiKey = (await resolveApiKey(model.provider)) ?? options.apiKey
	return {
		...options,
		apiKey,
		auth: {
			...(options.auth ?? {}),
			provider: model.provider ?? options.auth?.provider,
			credentialId: model.provider ?? options.auth?.credentialId,
		},
	}
}
