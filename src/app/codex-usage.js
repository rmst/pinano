import { getFreshCodexCredential } from "./model-auth.js"
import { resolveModel } from "./models.js"

const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api"

/** @typedef {{ used_percent?: number, limit_window_seconds?: number, reset_after_seconds?: number, reset_at?: number }} UsageWindow */
/** @typedef {{ allowed?: boolean, limit_reached?: boolean, primary_window?: UsageWindow | null, secondary_window?: UsageWindow | null }} UsageLimit */
/** @typedef {{ plan_type?: string, rate_limit?: UsageLimit | null, credits?: { has_credits?: boolean, unlimited?: boolean, balance?: string | null } | null, additional_rate_limits?: Array<{ limit_name?: string, metered_feature?: string, rate_limit?: UsageLimit | null }> | null, rate_limit_reached_type?: { type?: string } | null }} CodexUsagePayload */
/** @typedef {"normal" | "warn" | "error"} UsageTone */

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

/** @param {string} token */
function decodeJwtPayload(token) {
	try {
		const part = token.split(".")[1]
		if (!part) return null
		const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
		return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"))
	} catch {
		return null
	}
}

/** @param {string} access */
function accountIdFromAccess(access) {
	const payload = decodeJwtPayload(access)
	const auth = payload?.["https://api.openai.com/auth"]
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined
}

export { getFreshCodexCredential } from "./model-auth.js"

/** @param {import("./settings.js").Settings | undefined} settings */
export function codexUsageBaseUrlFromSettings(settings) {
	if (!settings?.defaultModel) return undefined
	const model = resolveModel(settings.defaultModel, { providers: settings.providers })
	return model.provider === "openai-codex" ? model.baseUrl : undefined
}

/** @param {any} model @param {import("./settings.js").Settings | undefined} settings */
export function codexUsageBaseUrlForModel(model, settings) {
	return model?.provider === "openai-codex" && typeof model.baseUrl === "string" ? model.baseUrl : codexUsageBaseUrlFromSettings(settings)
}

/**
 * @param {{ baseUrl?: string, access?: string, accountId?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<CodexUsagePayload>}
 */
export async function fetchCodexUsage(options = {}) {
	const access = options.access ?? (await getFreshCodexCredential()).access
	const accountId = options.accountId ?? accountIdFromAccess(access)
	const { usageUrl } = codexUsageUrl(options.baseUrl)
	const headers = {
		Authorization: `Bearer ${access}`,
		"User-Agent": "codex-cli",
	}
	if (accountId) headers["ChatGPT-Account-Id"] = accountId
	const fetchFn = options.fetchFn ?? fetch
	const response = await fetchFn(usageUrl, { method: "GET", headers })
	const text = await response.text().catch(() => "")
	if (!response.ok) throw new Error(`usage request failed: HTTP ${response.status}${text ? ` ${text}` : ""}`)
	try {
		return JSON.parse(text)
	} catch (err) {
		throw new Error(`usage request returned invalid JSON: ${err instanceof Error ? err.message : err}`)
	}
}

const HOUR_SECONDS = 60 * 60
const DAY_SECONDS = 24 * HOUR_SECONDS
const WEEK_SECONDS = 7 * DAY_SECONDS
const MONTH_SECONDS = 30 * DAY_SECONDS
const YEAR_SECONDS = 365 * DAY_SECONDS

/** @param {number | undefined} seconds */
function formatWindow(seconds) {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.round(minutes / 60)
	return `${hours}h`
}

/** @param {number} value @param {number} target @param {number} [tolerance] */
function secondsNear(value, target, tolerance = 60) {
	return Math.abs(value - target) <= tolerance
}

/** @param {UsageWindow | null | undefined} window @param {string} [fallback] */
export function usageWindowLabel(window, fallback = "usage") {
	const seconds = window?.limit_window_seconds
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback
	if (secondsNear(seconds, WEEK_SECONDS, HOUR_SECONDS)) return "weekly"
	if (secondsNear(seconds, DAY_SECONDS, 60)) return "daily"
	if (secondsNear(seconds, MONTH_SECONDS, DAY_SECONDS)) return "monthly"
	if (secondsNear(seconds, YEAR_SECONDS, DAY_SECONDS)) return "annual"
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h`
	const days = Math.round(hours / 24)
	return `${days}d`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** @param {Date} date */
function localDayIndex(date) {
	return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY)
}

/** @param {number} value */
function pad2(value) {
	return String(value).padStart(2, "0")
}

/** @param {Date} date */
function formatClock(date) {
	const hours = date.getHours()
	const hour12 = hours % 12 || 12
	return `${pad2(hour12)}:${pad2(date.getMinutes())} ${hours < 12 ? "AM" : "PM"}`
}

/** @param {Date} date */
function formatCompactClock(date) {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * @param {Date} date
 * @param {Date} now
 */
function formatDate(date, now) {
	const datePart = `${MONTHS[date.getMonth()]} ${date.getDate()}`
	return date.getFullYear() === now.getFullYear() ? datePart : `${datePart}, ${date.getFullYear()}`
}

/**
 * @param {number | undefined} unixSeconds
 * @param {Date} [now]
 */
function formatReset(unixSeconds, now = new Date()) {
	if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return undefined
	const date = new Date(unixSeconds * 1000)
	const dayDiff = localDayIndex(date) - localDayIndex(now)
	const time = formatClock(date)
	if (dayDiff === 0) return time
	if (dayDiff === 1) return `tomorrow ${time}`
	return `${formatDate(date, now)} ${time}`
}

/**
 * @param {number | undefined} unixSeconds
 * @param {Date} [now]
 */
export function formatUsageReset(unixSeconds, now = new Date()) {
	if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return undefined
	const date = new Date(unixSeconds * 1000)
	const dayDiff = localDayIndex(date) - localDayIndex(now)
	const time = formatCompactClock(date)
	if (dayDiff === 0) return time
	if (dayDiff === 1) return `tomorrow ${time}`
	return `${formatDate(date, now)} ${time}`
}

/**
 * @param {string} label
 * @param {UsageWindow | null | undefined} window
 * @param {Date} [now]
 */
function formatWindowLine(label, window, now) {
	if (!window) return undefined
	const used = typeof window.used_percent === "number" ? `${Math.round(window.used_percent)}% used` : "usage unknown"
	const span = formatWindow(window.limit_window_seconds)
	const reset = formatReset(window.reset_at, now)
	return `  ${label}: ${used}${span ? ` over ${span}` : ""}${reset ? `, resets ${reset}` : ""}`
}

/**
 * @param {string} label
 * @param {UsageLimit | null | undefined} limit
 * @param {Date} [now]
 */
function formatLimit(label, limit, now) {
	const lines = []
	lines.push(`${label}${limit?.limit_reached ? " (limit reached)" : ""}`)
	const primary = formatWindowLine("primary", limit?.primary_window, now)
	const secondary = formatWindowLine("secondary", limit?.secondary_window, now)
	if (primary) lines.push(primary)
	if (secondary) lines.push(secondary)
	if (!primary && !secondary) lines.push("  no window data")
	return lines
}

/** @param {UsageWindow | null | undefined} window */
function usageUsedPercent(window) {
	const used = window?.used_percent
	if (typeof used !== "number" || !Number.isFinite(used)) return undefined
	return Math.max(0, Math.min(100, Math.round(used)))
}

/** @param {UsageWindow | null | undefined} window */
export function usageLeftPercent(window) {
	const used = usageUsedPercent(window)
	return used === undefined ? undefined : Math.max(0, 100 - used)
}

/** @param {UsageLimit | null | undefined} limit */
function codexUsageWindows(limit) {
	const windows = []
	if (limit?.primary_window) windows.push({ kind: "primary", label: usageWindowLabel(limit.primary_window, "primary"), window: limit.primary_window })
	if (limit?.secondary_window) windows.push({ kind: "secondary", label: usageWindowLabel(limit.secondary_window, "secondary"), window: limit.secondary_window })
	return windows
}

/**
 * @param {CodexUsagePayload} payload
 * @param {{ now?: Date }} [options]
 */
function codexUsageWindowDetails(payload, options = {}) {
	const now = options.now ?? new Date()
	return codexUsageWindows(payload.rate_limit)
		.map((entry) => {
			const left = usageLeftPercent(entry.window)
			if (left === undefined) return undefined
			return {
				kind: entry.kind,
				label: entry.label,
				left,
				reset: formatUsageReset(entry.window.reset_at, now),
				resetAt: entry.window.reset_at,
				resetInSeconds: usageResetSeconds(entry.window, now),
			}
		})
		.filter(Boolean)
}

/** @param {UsageWindow | null | undefined} window @param {Date} now */
function usageResetSeconds(window, now) {
	const resetAfter = window?.reset_after_seconds
	if (typeof resetAfter === "number" && Number.isFinite(resetAfter) && resetAfter >= 0) return resetAfter
	const resetAt = window?.reset_at
	if (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0) return Math.max(0, resetAt - now.getTime() / 1000)
	return undefined
}

/** @param {number | undefined} seconds */
function formatUsageResetDistance(seconds) {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined
	if (seconds <= 0) return "now"
	if (seconds >= DAY_SECONDS) return `${Math.ceil(seconds / DAY_SECONDS)}d`
	return `${Math.max(1, Math.ceil(seconds / HOUR_SECONDS))}h`
}

/** @param {{ label: string, left: number, reset?: string }} detail */
function formatUsagePart(detail) {
	return `${detail.label} ${detail.left}% left${detail.reset ? `, resets ${detail.reset}` : ""}`
}

/** @param {{ left: number, reset?: string }} detail */
function formatUsageRemainder(detail) {
	return `${detail.left}% left${detail.reset ? `, resets ${detail.reset}` : ""}`
}

/** @param {{ label: string, left: number, reset?: string }} detail */
function formatCodexLimitLine(detail) {
	return `Codex ${detail.label} limit: ${formatUsageRemainder(detail)}.`
}

/**
 * @param {CodexUsagePayload} payload
 * @param {{ now?: Date }} [options]
 */
export function formatCodexUsageSummary(payload, options = {}) {
	const parts = codexUsageWindowDetails(payload, options).map(formatUsagePart)
	return parts.length === 0 ? "" : `Codex: ${parts.join(" · ")}`
}

/** @param {{ left: number, resetInSeconds?: number }} detail */
function formatCompactUsagePart(detail) {
	const reset = formatUsageResetDistance(detail.resetInSeconds)
	return `${detail.left}% left${reset ? ` (${reset})` : ""}`
}

/**
 * @param {CodexUsagePayload} payload
 * @param {{ now?: Date }} [options]
 */
export function formatCodexUsageInlineSummary(payload, options = {}) {
	const parts = codexUsageWindowDetails(payload, options).map(formatCompactUsagePart)
	return parts.length === 0 ? "" : `Usage: ${parts.join(" · ")}`
}

/** @param {CodexUsagePayload} payload */
export function codexUsageStatusTone(payload) {
	if (payload.rate_limit?.limit_reached) return "error"
	const lefts = codexUsageWindowDetails(payload).map((detail) => detail.left)
	if (lefts.length === 0) return "normal"
	const minLeft = Math.min(...lefts)
	if (minLeft <= 10) return "error"
	if (minLeft <= 20) return "warn"
	return "normal"
}

/**
 * @param {CodexUsagePayload} payload
 * @param {{ now?: Date, thresholdPercent?: number }} [options]
 * @returns {{ text: string, tone: UsageTone }}
 */
export function formatCodexUsageLowStatus(payload, options = {}) {
	const thresholdPercent = options.thresholdPercent ?? 20
	const details = codexUsageWindowDetails(payload, options).filter((detail) => detail.left <= thresholdPercent)
	if (details.length === 0) return { text: "", tone: "normal" }
	const tone = payload.rate_limit?.limit_reached || details.some((detail) => detail.left <= 10) ? "error" : "warn"
	const text = details.length === 1
		? formatCodexLimitLine(details[0])
		: `Codex limits: ${details.map(formatUsagePart).join(" · ")}.`
	return { text, tone }
}

const CODEX_USAGE_THRESHOLDS = [
	{ usedPercent: 90, maxLeftPercent: 10, tone: "error" },
	{ usedPercent: 80, maxLeftPercent: 20, tone: "warn" },
]

/** @param {{ kind: string, label: string, resetAt?: number }} detail @param {number} usedPercent */
function usageWarningKey(detail, usedPercent) {
	return [detail.kind, detail.label, detail.resetAt ?? "", usedPercent].join(":")
}

/**
 * @param {CodexUsagePayload} payload
 * @param {Set<string>} seen
 * @param {{ now?: Date }} [options]
 * @returns {Array<{ text: string, tone: UsageTone, key: string }>}
 */
export function codexUsageThresholdMessages(payload, seen, options = {}) {
	const messages = []
	for (const detail of codexUsageWindowDetails(payload, options)) {
		const crossed = CODEX_USAGE_THRESHOLDS.filter((threshold) => detail.left <= threshold.maxLeftPercent)
		if (crossed.length === 0) continue
		const threshold = crossed[0]
		const key = usageWarningKey(detail, threshold.usedPercent)
		if (seen.has(key)) continue
		for (const crossedThreshold of crossed) seen.add(usageWarningKey(detail, crossedThreshold.usedPercent))
		messages.push({ text: formatCodexLimitLine(detail), tone: threshold.tone, key })
	}
	return messages
}

/**
 * @param {CodexUsagePayload} payload
 * @param {{ now?: Date }} [options]
 */
export function formatCodexUsage(payload, options = {}) {
	const lines = []
	lines.push("--- ChatGPT/Codex usage")
	if (payload.plan_type) lines.push(`plan: ${payload.plan_type}`)
	if (payload.rate_limit_reached_type?.type) lines.push(`status: ${payload.rate_limit_reached_type.type}`)
	lines.push(...formatLimit("codex", payload.rate_limit, options.now))
	for (const item of payload.additional_rate_limits ?? []) {
		lines.push(...formatLimit(item.limit_name ?? item.metered_feature ?? "additional", item.rate_limit, options.now))
	}
	if (payload.credits) {
		const balance = payload.credits.balance ? `, balance ${payload.credits.balance}` : ""
		lines.push(`credits: ${payload.credits.unlimited ? "unlimited" : payload.credits.has_credits ? "available" : "none"}${balance}`)
	}
	lines.push("details: https://chatgpt.com/codex/settings/usage")
	return lines
}
