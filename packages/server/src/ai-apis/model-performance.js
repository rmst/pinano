// Request-local model API performance measurement.
//
// This module never persists individual requests. It keeps only monotonic timestamps and low-cardinality dimensions until a request finishes, then sends a content-free sample to the configured in-memory aggregate recorder.

const RESPONSE_CONTENT_DELTA_TYPES = new Set([
	"response.output_text.delta",
	"response.refusal.delta",
	"response.reasoning_summary_text.delta",
	"response.function_call_arguments.delta",
	"response.custom_tool_call_input.delta",
])

const RESPONSE_CONTENT_DONE_FIELDS = Object.freeze({
	"response.output_text.done": "text",
	"response.refusal.done": "refusal",
	"response.reasoning_summary_text.done": "text",
	"response.function_call_arguments.done": "arguments",
	"response.custom_tool_call_input.done": "input",
})

let recorder

/** @param {unknown} value */
function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

/** @param {unknown} value */
function dimension(value, fallback = "unspecified") {
	return typeof value === "string" && value.length > 0 ? value : fallback
}

/** @param {any} event */
export function streamEventHasModelContent(event) {
	const parsed = event?.parsed
	if (!parsed || typeof parsed !== "object") return false

	if (RESPONSE_CONTENT_DELTA_TYPES.has(parsed.type)) {
		return typeof parsed.delta === "string" && parsed.delta.length > 0
	}
	const doneField = RESPONSE_CONTENT_DONE_FIELDS[parsed.type]
	if (doneField && typeof parsed[doneField] === "string" && parsed[doneField].length > 0) return true
	if (parsed.type === "response.output_item.added") {
		const item = parsed.item
		if ((item?.type === "function_call" || item?.type === "custom_tool_call") && typeof item.name === "string" && item.name.length > 0) return true
	}

	if (!Array.isArray(parsed.choices)) return false
	for (const choice of parsed.choices) {
		const delta = choice?.delta
		if (!delta || typeof delta !== "object") continue
		for (const key of ["content", "reasoning_content", "reasoning", "reasoning_text"]) {
			if (typeof delta[key] === "string" && delta[key].length > 0) return true
		}
		if (!Array.isArray(delta.tool_calls)) continue
		for (const toolCall of delta.tool_calls) {
			if (typeof toolCall?.function?.name === "string" && toolCall.function.name.length > 0) return true
			if (typeof toolCall?.function?.arguments === "string" && toolCall.function.arguments.length > 0) return true
		}
	}
	return false
}

/**
 * @param {((sample: any) => void) | undefined} value
 */
export function setModelPerformanceRecorder(value) {
	recorder = typeof value === "function" ? value : undefined
}

export function isModelPerformanceRecording() {
	return typeof recorder === "function"
}

/**
 * @param {object} params
 * @param {any} params.model
 * @param {string} params.transport
 * @param {any} [params.options]
 */
export function beginModelPerformance({ model, transport, options }) {
	if (!recorder) return null
	return {
		recorder,
		startedAtMonotonicMs: performance.now(),
		provider: dimension(model?.provider),
		model: dimension(model?.id),
		transport: dimension(transport),
		reasoningEffort: dimension(options?.reasoningEffort),
		serviceTier: dimension(options?.serviceTier, "default"),
		attemptCount: 0,
		responseHeadersAtMonotonicMs: undefined,
		firstStreamEventAtMonotonicMs: undefined,
		firstContentAtMonotonicMs: undefined,
		finished: false,
	}
}

/** @param {any} measurement */
export function recordModelAttemptStarted(measurement) {
	if (!measurement || measurement.finished) return
	measurement.attemptCount += 1
}

/** @param {any} measurement */
export function recordModelResponseHeaders(measurement) {
	if (!measurement || measurement.finished || measurement.responseHeadersAtMonotonicMs !== undefined) return
	measurement.responseHeadersAtMonotonicMs = performance.now()
}

/**
 * @param {any} measurement
 * @param {any} event
 */
export function recordModelStreamEvent(measurement, event) {
	if (!measurement || measurement.finished) return
	if (measurement.firstStreamEventAtMonotonicMs !== undefined && measurement.firstContentAtMonotonicMs !== undefined) return
	const now = performance.now()
	if (measurement.firstStreamEventAtMonotonicMs === undefined) measurement.firstStreamEventAtMonotonicMs = now
	if (measurement.firstContentAtMonotonicMs === undefined && streamEventHasModelContent(event)) {
		measurement.firstContentAtMonotonicMs = now
	}
}

/**
 * @param {any} measurement
 * @param {object} result
 * @param {string} [result.status]
 * @param {any} [result.finalMessage]
 */
export function finishModelPerformance(measurement, { status, finalMessage } = {}) {
	if (!measurement || measurement.finished) return
	measurement.finished = true
	const finishedAtMonotonicMs = performance.now()
	const usage = finalMessage?.usage
	const inputTokens = finiteNonNegative(usage?.input)
		+ finiteNonNegative(usage?.cacheRead)
		+ finiteNonNegative(usage?.cacheWrite)
	const outputTokens = finiteNonNegative(usage?.output)
	const reasoningOutputTokens = finiteNonNegative(usage?.reasoningOutput)
	const visibleOutputTokens = Math.max(0, outputTokens - reasoningOutputTokens)
	const generationDurationMs = measurement.firstContentAtMonotonicMs === undefined
		? undefined
		: Math.max(0, finishedAtMonotonicMs - measurement.firstContentAtMonotonicMs)
	const outputTokensPerSecond = visibleOutputTokens > 0 && generationDurationMs > 0
		? visibleOutputTokens / (generationDurationMs / 1000)
		: undefined
	const elapsed = (observedAt) => observedAt === undefined
		? undefined
		: Math.max(0, observedAt - measurement.startedAtMonotonicMs)

	try {
		measurement.recorder({
			finishedAtMs: Date.now(),
			provider: measurement.provider,
			model: measurement.model,
			transport: measurement.transport,
			reasoningEffort: measurement.reasoningEffort,
			serviceTier: measurement.serviceTier,
			status: dimension(status, "completed"),
			attemptCount: measurement.attemptCount,
			usageReported: Boolean(usage && (usage.raw !== undefined || inputTokens > 0 || outputTokens > 0)),
			inputTokens,
			cacheReadTokens: finiteNonNegative(usage?.cacheRead),
			cacheWriteTokens: finiteNonNegative(usage?.cacheWrite),
			outputTokens,
			reasoningOutputTokens,
			requestLatencyMs: Math.max(0, finishedAtMonotonicMs - measurement.startedAtMonotonicMs),
			responseHeadersLatencyMs: elapsed(measurement.responseHeadersAtMonotonicMs),
			firstStreamEventLatencyMs: elapsed(measurement.firstStreamEventAtMonotonicMs),
			firstContentLatencyMs: elapsed(measurement.firstContentAtMonotonicMs),
			generationDurationMs,
			outputTokensPerSecond,
		})
	} catch {
		// Observability must never affect a model call.
	}
}
