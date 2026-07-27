import { recordSubscriptionUsageSnapshot } from "../../ai-apis/model-io-log.js"
import { getCredential } from "../auth/credentials.js"
import { codexUsageBaseUrlFromSettings, codexUsageUrl, fetchCodexUsage } from "./codex.js"
import { getFreshCodexCredential } from "../model/auth.js"

export const CODEX_USAGE_POLL_INTERVAL_MS = 10 * 60 * 1000

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 * 	getSettings?: () => any | Promise<any>,
 * 	getFreshCredential?: typeof getFreshCodexCredential,
 * 	fetchUsage?: typeof fetchCodexUsage,
 * 	recordSnapshot?: typeof recordSubscriptionUsageSnapshot,
 * 	baseUrl?: string,
 * 	sampledAt?: string,
 * 	signal?: AbortSignal,
 * }} [options]
 */
export async function pollCodexUsageOnce(options = {}) {
	const stored = await getCredential("openai-codex")
	if (stored?.kind !== "codex") return { ok: false, skipped: true, reason: "not_configured" }

	const recordSnapshot = options.recordSnapshot ?? recordSubscriptionUsageSnapshot
	const sampledAt = options.sampledAt ?? new Date().toISOString()
	let fresh = stored
	let { baseUrl, usageUrl } = codexUsageUrl(options.baseUrl)

	try {
		if (options.baseUrl === undefined) {
			const settings = await options.getSettings?.()
			const resolved = codexUsageUrl(codexUsageBaseUrlFromSettings(settings))
			baseUrl = resolved.baseUrl
			usageUrl = resolved.usageUrl
		}
		fresh = await (options.getFreshCredential ?? getFreshCodexCredential)()
		const payload = await (options.fetchUsage ?? fetchCodexUsage)({
			baseUrl,
			access: fresh.access,
			accountId: fresh.accountId ?? stored.accountId,
			signal: options.signal,
		})
		if (options.signal?.aborted) return { ok: false, skipped: true, reason: "aborted" }
		const id = recordSnapshot({
			sampledAt,
			provider: "openai-codex",
			credentialId: "openai-codex",
			accountId: fresh.accountId ?? stored.accountId,
			baseUrl,
			usageUrl,
			status: "ok",
			payload,
		})
		return { ok: true, id, payload }
	} catch (error) {
		if (options.signal?.aborted) return { ok: false, skipped: true, reason: "aborted" }
		const message = errorMessage(error)
		const id = recordSnapshot({
			sampledAt,
			provider: "openai-codex",
			credentialId: "openai-codex",
			accountId: fresh?.accountId ?? stored.accountId,
			baseUrl,
			usageUrl,
			status: "error",
			error: message,
		})
		return { ok: false, id, error: message }
	}
}

/**
 * @param {{
 * 	getSettings?: () => any | Promise<any>,
 * 	getFreshCredential?: typeof getFreshCodexCredential,
 * 	intervalMs?: number,
 * 	initialDelayMs?: number,
 * 	fetchUsage?: typeof fetchCodexUsage,
 * 	recordSnapshot?: typeof recordSubscriptionUsageSnapshot,
 * 	baseUrl?: string,
 * }} [options]
 */
export function startCodexUsagePoller(options = {}) {
	const intervalMs = Math.max(1, options.intervalMs ?? CODEX_USAGE_POLL_INTERVAL_MS)
	let timer
	let closed = false
	let controller
	let running

	const clearTimer = () => {
		if (!timer) return
		clearTimeout(timer)
		timer = undefined
	}
	const schedule = (delayMs) => {
		clearTimer()
		if (closed) return
		timer = setTimeout(() => {
			timer = undefined
			void run()
		}, Math.max(0, delayMs))
		timer.unref?.()
	}
	const run = () => {
		if (closed) return Promise.resolve({ ok: false, skipped: true, reason: "closed" })
		if (running) return running
		controller = new AbortController()
		running = pollCodexUsageOnce({ ...options, signal: controller.signal })
			.catch((error) => {
				if (!closed && process.env.CEREX_TEST !== "1") console.error(`codex usage poll failed: ${errorMessage(error)}`)
				return { ok: false, error: errorMessage(error) }
			})
			.finally(() => {
				controller = undefined
				running = undefined
				if (!closed) schedule(intervalMs)
			})
		return running
	}

	schedule(options.initialDelayMs ?? 0)
	return {
		poll: run,
		close() {
			closed = true
			clearTimer()
			controller?.abort()
		},
	}
}
