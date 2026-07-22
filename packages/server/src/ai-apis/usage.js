// Normalized model-call usage helpers.
//
// Provider transports keep `Usage` backwards-compatible (`input`, `output`,
// `cacheRead`, `cacheWrite`, `totalTokens`, `cost`) while preserving richer
// provider data needed for future accounting (`reasoningOutput`,
// `providerTotalTokens`, `raw`).

/** @param {unknown} value */
function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** @param {unknown} value */
function optionalFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** @param {unknown} value */
function cloneJson(value) {
	if (value === undefined) return undefined
	try {
		return JSON.parse(JSON.stringify(value))
	} catch {
		return undefined
	}
}

/**
 * @param {object} [model]
 * @returns {import("./types.js").Cost}
 */
export function emptyCost(model) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		currency: "USD",
		pricingVersion: model?.costVersion,
	}
}

/**
 * @param {object} [model]
 * @returns {import("./types.js").Usage}
 */
export function emptyUsage(model) {
	return {
		input: 0,
		output: 0,
		reasoningOutput: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		providerTotalTokens: 0,
		cost: emptyCost(model),
	}
}

function normalizedServiceTier(value) {
	if (value === "priority" || value === "fast") return "priority"
	if (value === "flex") return "flex"
	return "standard"
}

function totalInputTokens(usage) {
	const rawInput = finiteNumber(usage.raw?.input_tokens ?? usage.raw?.prompt_tokens)
	return rawInput > 0 ? rawInput : usage.input + usage.cacheRead + usage.cacheWrite
}

function costForUsage(model, usage, pricingContext = {}) {
	const pricing = model.pricing
	if (!pricing?.serviceTiers) return model.cost ?? {}
	const serviceTier = normalizedServiceTier(pricingContext.serviceTier)
	const tierPricing = pricing.serviceTiers[serviceTier] ?? pricing.serviceTiers.standard
	if (!tierPricing) return model.cost ?? {}
	const longContextThreshold = finiteNumber(tierPricing.longContextThresholdInputTokens ?? pricing.longContextThresholdInputTokens)
	const useLongContext = longContextThreshold > 0 && totalInputTokens(usage) > longContextThreshold
	if (useLongContext) {
		return tierPricing.long ?? pricing.serviceTiers.standard?.long ?? tierPricing.short ?? pricing.serviceTiers.standard?.short ?? model.cost ?? {}
	}
	return tierPricing.short ?? model.cost ?? {}
}

/**
 * @param {object} model
 * @param {import("./types.js").Usage} usage
 * @param {{ serviceTier?: string }} [pricingContext]
 */
export function calculateCost(model, usage, pricingContext = {}) {
	const cost = costForUsage(model, usage, pricingContext)
	if (!usage.cost) usage.cost = emptyCost(model)
	usage.cost.input = ((cost.input ?? 0) / 1_000_000) * usage.input
	usage.cost.output = ((cost.output ?? 0) / 1_000_000) * usage.output
	usage.cost.cacheRead = ((cost.cacheRead ?? 0) / 1_000_000) * usage.cacheRead
	usage.cost.cacheWrite = ((cost.cacheWrite ?? 0) / 1_000_000) * usage.cacheWrite
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
	if (!usage.cost.currency) usage.cost.currency = "USD"
	if (model.costVersion !== undefined) usage.cost.pricingVersion = model.costVersion
	return usage
}

/**
 * Normalize OpenAI Chat Completions `usage` payloads.
 *
 * `output` remains provider/billing output tokens for backwards compatibility;
 * `reasoningOutput` is a subset when the provider reports it.
 *
 * @param {any} rawUsage
 * @param {object} model
 * @param {{ serviceTier?: string }} [pricingContext]
 * @returns {import("./types.js").Usage}
 */
export function normalizeChatUsage(rawUsage, model, pricingContext = {}) {
	const promptTokens = finiteNumber(rawUsage?.prompt_tokens)
	const promptDetails = rawUsage?.prompt_tokens_details ?? {}
	const completionDetails = rawUsage?.completion_tokens_details ?? rawUsage?.output_tokens_details ?? {}
	const reportedCached = finiteNumber(promptDetails.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens)
	const cacheWrite = finiteNumber(promptDetails.cache_write_tokens ?? promptDetails.cache_creation_tokens)
	// Some providers double-count: cached_tokens = prior hits + current writes. Subtract.
	const cacheRead = cacheWrite > 0 ? Math.max(0, reportedCached - cacheWrite) : reportedCached
	const input = Math.max(0, promptTokens - cacheRead - cacheWrite)
	const output = finiteNumber(rawUsage?.completion_tokens)
	const reasoningOutput = finiteNumber(completionDetails.reasoning_tokens)
	const fallbackTotal = input + output + cacheRead + cacheWrite
	const providerTotalTokens = optionalFiniteNumber(rawUsage?.total_tokens) ?? fallbackTotal
	return calculateCost(model, {
		input,
		output,
		reasoningOutput,
		cacheRead,
		cacheWrite,
		totalTokens: providerTotalTokens,
		providerTotalTokens,
		raw: cloneJson(rawUsage),
		cost: emptyCost(model),
	}, pricingContext)
}

/**
 * Normalize OpenAI Responses / Codex `response.usage` payloads.
 *
 * `output` remains provider/billing output tokens for backwards compatibility;
 * `reasoningOutput` is a subset when the provider reports it.
 *
 * @param {any} rawUsage
 * @param {object} model
 * @param {{ serviceTier?: string }} [pricingContext]
 * @returns {import("./types.js").Usage}
 */
export function normalizeResponsesUsage(rawUsage, model, pricingContext = {}) {
	const inputTokens = finiteNumber(rawUsage?.input_tokens)
	const outputTokens = finiteNumber(rawUsage?.output_tokens)
	const inputDetails = rawUsage?.input_tokens_details ?? {}
	const outputDetails = rawUsage?.output_tokens_details ?? {}
	const cacheRead = finiteNumber(inputDetails.cached_tokens)
	const cacheWrite = finiteNumber(inputDetails.cache_write_tokens ?? inputDetails.cache_creation_tokens)
	const input = Math.max(0, inputTokens - cacheRead - cacheWrite)
	const reasoningOutput = finiteNumber(outputDetails.reasoning_tokens)
	const fallbackTotal = input + outputTokens + cacheRead + cacheWrite
	const providerTotalTokens = optionalFiniteNumber(rawUsage?.total_tokens) ?? fallbackTotal
	return calculateCost(model, {
		input,
		output: outputTokens,
		reasoningOutput,
		cacheRead,
		cacheWrite,
		totalTokens: providerTotalTokens,
		providerTotalTokens,
		raw: cloneJson(rawUsage),
		cost: emptyCost(model),
	}, pricingContext)
}

/**
 * @param {object} model
 * @param {any} options
 * @param {Record<string, any>} [extra]
 */
export function buildAssistantAuth(model, options, extra = {}) {
	const auth = {
		...(options?.auth ?? {}),
		provider: model.provider ?? options?.auth?.provider,
		...extra,
	}
	for (const [key, value] of Object.entries(auth)) {
		if (value === undefined || value === null || value === "") delete auth[key]
	}
	return Object.keys(auth).length > 0 ? auth : undefined
}
