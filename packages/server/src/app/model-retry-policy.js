const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

export const MODEL_RETRY_DEFAULT_POLICY = Object.freeze({
	baseDelayMs: SECOND_MS,
	maxDelayMs: 5 * MINUTE_MS,
	maxElapsedMs: 3 * HOUR_MS,
})

function finiteNumber(value) {
	const n = Number(value)
	return Number.isFinite(n) ? n : undefined
}

function nonNegativeInteger(value, fallback = 0) {
	const n = finiteNumber(value)
	return n === undefined ? fallback : Math.max(0, Math.floor(n))
}

function positiveInteger(value, fallback) {
	const n = finiteNumber(value)
	return n === undefined || n <= 0 ? fallback : Math.floor(n)
}

function normalizePolicy(policy = {}) {
	return {
		baseDelayMs: positiveInteger(policy.baseDelayMs, MODEL_RETRY_DEFAULT_POLICY.baseDelayMs),
		maxDelayMs: positiveInteger(policy.maxDelayMs, MODEL_RETRY_DEFAULT_POLICY.maxDelayMs),
		maxElapsedMs: positiveInteger(policy.maxElapsedMs, MODEL_RETRY_DEFAULT_POLICY.maxElapsedMs),
	}
}

export function modelRetryDelayMs(attempt, policy = {}) {
	const normalized = normalizePolicy(policy)
	const n = nonNegativeInteger(attempt)
	return Math.min(normalized.maxDelayMs, normalized.baseDelayMs * 2 ** n)
}

export function modelRetryMaxAttemptsForWindow(policy = {}) {
	const normalized = normalizePolicy(policy)
	let totalMs = 0
	let attempts = 0
	while (totalMs < normalized.maxElapsedMs && attempts < 10_000) {
		totalMs += modelRetryDelayMs(attempts, normalized)
		attempts += 1
	}
	return attempts
}

function retryStartedAtMs(retry, nowMs) {
	const startedAtMs = finiteNumber(retry?.startedAtMs)
	return startedAtMs === undefined ? nowMs : startedAtMs
}

function retryMaxElapsedMs(retry, policy) {
	return positiveInteger(retry?.maxElapsedMs, policy.maxElapsedMs)
}

function retryMaxAttempts(retry) {
	const value = finiteNumber(retry?.maxAttempts)
	return value === undefined ? undefined : Math.max(0, Math.floor(value))
}

function delayFromOptions(attempt, policy, delayForAttempt) {
	const delay = typeof delayForAttempt === "function" ? finiteNumber(delayForAttempt(attempt)) : undefined
	return delay === undefined || delay < 0 ? modelRetryDelayMs(attempt, policy) : Math.floor(delay)
}

export function createModelRetryPlan(retry = {}, options = {}) {
	const policy = normalizePolicy(options.policy)
	const nowMs = finiteNumber(options.nowMs) ?? Date.now()
	const attempt = nonNegativeInteger(retry.attempt)
	const startedAtMs = retryStartedAtMs(retry, nowMs)
	const maxElapsedMs = retryMaxElapsedMs(retry, policy)
	const maxAttempts = retryMaxAttempts(retry)
	const elapsedMs = Math.max(0, nowMs - startedAtMs)
	const remainingMs = Math.max(0, maxElapsedMs - elapsedMs)
	const deadlineAtMs = startedAtMs + maxElapsedMs
	const estimatedMaxAttempts = maxAttempts ?? modelRetryMaxAttemptsForWindow({ ...policy, maxElapsedMs })
	const base = {
		attempt,
		maxAttempts: estimatedMaxAttempts,
		configuredMaxAttempts: maxAttempts,
		startedAtMs,
		deadlineAtMs,
		elapsedMs,
		remainingMs,
		maxElapsedMs,
	}
	if (maxAttempts !== undefined && attempt >= maxAttempts) {
		return { ...base, shouldRetry: false, exhausted: true, reason: "attempt_limit" }
	}
	if (remainingMs <= 0) {
		return { ...base, shouldRetry: false, exhausted: true, reason: "time_limit" }
	}

	const delayMs = Math.min(delayFromOptions(attempt, policy, options.delayForAttempt), remainingMs)
	const nextRetry = {
		attempt: attempt + 1,
		startedAtMs,
		maxElapsedMs,
		...(maxAttempts !== undefined ? { maxAttempts } : {}),
	}
	return {
		...base,
		shouldRetry: true,
		exhausted: false,
		delayMs,
		nextAttempt: attempt + 1,
		nextRetry,
	}
}

export function formatModelRetryDuration(ms) {
	const n = Math.max(0, finiteNumber(ms) ?? 0)
	if (n < MINUTE_MS) return `${Math.max(1, Math.ceil(n / SECOND_MS))}s`
	if (n < HOUR_MS) return `${Math.ceil(n / MINUTE_MS)}m`
	return `${Math.ceil(n / HOUR_MS)}h`
}

export function modelRetryScheduledText(event) {
	const delay = formatModelRetryDuration(event?.delayMs)
	const attempt = nonNegativeInteger(event?.attempt, 1)
	const windowMs = event?.retryWindowMs ?? event?.maxElapsedMs
	if (windowMs !== undefined) {
		const window = formatModelRetryDuration(windowMs)
		return `Model request failed; retrying in ${delay} (attempt ${attempt}, up to ${window}).`
	}
	if (event?.maxAttempts !== undefined) return `Model request failed; retrying in ${delay} (${attempt}/${event.maxAttempts}).`
	return `Model request failed; retrying in ${delay} (attempt ${attempt}).`
}

export function modelRetryExhaustedText(event) {
	const windowMs = event?.retryWindowMs ?? event?.maxElapsedMs
	if (windowMs !== undefined) return `Model request failed; stopped retrying after ${formatModelRetryDuration(windowMs)}.`
	return `Model request failed after ${event?.maxAttempts ?? "several"} retries.`
}
