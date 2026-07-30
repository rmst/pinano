const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api"

/**
 * @param {string | undefined} baseUrl
 * @returns {{ baseUrl: string, usageUrl: string }}
 */
export function codexUsageUrl(baseUrl = DEFAULT_CODEX_BASE) {
	let normalized = baseUrl.replace(/\/+$/, "")
	if ((normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com")) && !normalized.includes("/backend-api")) {
		normalized = `${normalized}/backend-api`
	}
	const suffix = normalized.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage"
	return { baseUrl: normalized, usageUrl: `${normalized}${suffix}` }
}

/**
 * @param {{ baseUrl?: string, access: string, accountId?: string, fetchFn?: typeof fetch, signal?: AbortSignal }} options
 */
export async function requestCodexUsage(options) {
	const { usageUrl } = codexUsageUrl(options.baseUrl)
	const headers = {
		Authorization: `Bearer ${options.access}`,
		"User-Agent": "codex-cli",
	}
	if (options.accountId) headers["ChatGPT-Account-Id"] = options.accountId
	const fetchFn = options.fetchFn ?? fetch
	const response = await fetchFn(usageUrl, { method: "GET", headers, signal: options.signal })
	const text = await response.text().catch(() => "")
	if (!response.ok) throw new Error(`usage request failed: HTTP ${response.status}${text ? ` ${text}` : ""}`)
	try {
		return JSON.parse(text)
	} catch (err) {
		throw new Error(`usage request returned invalid JSON: ${err instanceof Error ? err.message : err}`)
	}
}
