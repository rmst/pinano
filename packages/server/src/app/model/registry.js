// Curated model registry. Cost / context / capability numbers come from
// pi-mono's `packages/ai/src/models.generated.ts` (commit 3d5cbe98) and are
// kept in sync manually for the providers we actually care about:
//
//   - OpenAI cloud (API key)        — gpt-5.6 / gpt-5.5 / gpt-5.4-mini
//   - Codex (ChatGPT subscription)  — gpt-5.6-sol / gpt-5.5 / gpt-5.4-mini via OAuth
//   - Local llama.cpp / OpenAI-compat
//   - Moonshot Kimi K2.x
//   - DeepSeek V4
//
// src/ai-apis speaks both /v1/chat/completions and /v1/responses. The
// reasoning gpt-5.x family is responses-only when combined with tools, so we
// flag those entries with `transport: "responses"`. Everything else (kimi,
// deepseek, llama.cpp) stays on chat completions, which is also what
// most OpenAI-compatible servers speak.

import { resolveApiKey } from "../auth/credentials.js"
import { CODEX_TOOL_PROFILE, DEFAULT_TOOL_PROFILE, GPT_5_4_MINI_INSTRUCTIONS_KEY, GPT_5_5_INSTRUCTIONS_KEY, GPT_5_6_SOL_INSTRUCTIONS_KEY } from "./instructions/index.js"

/** @typedef {"openai" | "openai-codex" | "llamacpp" | "moonshot" | "deepseek"} ModelProvider */

/**
 * @typedef {object} ModelEntry
 * @property {string} id
 * @property {string} displayName
 * @property {ModelProvider} provider
 * @property {ModelProvider} authProvider
 * @property {string} baseUrl
 * @property {string} [wireModel]
 * @property {string[]} [legacyIds]
 * @property {boolean} reasoning
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} cost
 * @property {import("../../ai-apis/types.js").ModelPricing} [pricing]
 * @property {("text" | "image")[]} [input]
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} [compat]
 * @property {{ remoteResponses?: boolean }} [compaction]
 * @property {"chat" | "responses"} [transport]
 * @property {"auto" | "sse" | "websocket"} [codexTransport]
 * @property {boolean} [supportsTextVerbosity]
 * @property {"low" | "medium" | "high"} [defaultTextVerbosity]
 * @property {boolean} [supportsParallelToolCalls]
 * @property {("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[]} [supportedReasoningLevels]
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} [defaultReasoningLevel]
 * @property {string} [baseInstructionsKey]
 * @property {string} [maintenanceModelRef]
 * @property {"default" | "codex"} [toolProfile]
 * @property {"code_mode_only"} [toolMode]
 * @property {boolean} [useResponsesLite]
 * @property {string[]} [serviceTiers]
 * @property {string[]} [tags]
 * @property {boolean} [_contextWindowExplicit]
 */

/**
 * Browser-safe model metadata used by model pickers.
 *
 * @typedef {object} ModelChoice
 * @property {string} value
 * @property {string} id
 * @property {string} displayName
 * @property {ModelProvider} provider
 * @property {ModelProvider} authProvider
 * @property {boolean} reasoning
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} cost
 */

const OPENAI_BASE = "https://api.openai.com/v1"
const CODEX_BASE = "https://chatgpt.com/backend-api"
const MOONSHOT_BASE = "https://api.moonshot.ai/v1"
const DEEPSEEK_BASE = "https://api.deepseek.com"
const TEXT_ONLY_INPUT = ["text"]
const VISION_INPUT = ["text", "image"]
const MODEL_METADATA_TIMEOUT_MS = 1000
const MODEL_METADATA_SUCCESS_CACHE_MS = 30_000
const MODEL_METADATA_FAILURE_CACHE_MS = 2_000
const modelMetadataFetchCache = new Map()

const KIMI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
}

const DEEPSEEK_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsPromptCacheKey: false,
}

const GPT_5_5_REASONING_LEVELS = ["low", "medium", "high", "xhigh"]
const GPT_5_6_SOL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"]
const GPT_5_6_CONTEXT_WINDOW = 272_000
const GPT_5_6_LONG_CONTEXT_INPUT_TOKENS = 272_000
const GPT_5_6_PRICING_VERSION = "openai-gpt-5.6-2026-07"

function cost(input, cacheRead, cacheWrite, output) {
	return { input, cacheRead, cacheWrite, output }
}

function scaledCost(scale, source) {
	return {
		input: source.input * scale,
		cacheRead: source.cacheRead * scale,
		cacheWrite: source.cacheWrite * scale,
		output: source.output * scale,
	}
}

function scaledGpt56Pricing(scale) {
	const standardShort = scaledCost(scale, cost(5, 0.5, 6.25, 30))
	return {
		cost: standardShort,
		costVersion: GPT_5_6_PRICING_VERSION,
		pricing: {
			longContextThresholdInputTokens: GPT_5_6_LONG_CONTEXT_INPUT_TOKENS,
			serviceTiers: {
				standard: {
					short: standardShort,
					long: scaledCost(scale, cost(10, 1, 12.5, 45)),
				},
				flex: {
					short: scaledCost(scale, cost(2.5, 0.25, 3.125, 15)),
					long: scaledCost(scale, cost(5, 0.5, 6.25, 22.5)),
				},
				priority: {
					short: scaledCost(scale, cost(10, 1, 12.5, 60)),
				},
			},
		},
	}
}

const GPT_5_5_MODEL = {
	reasoning: true,
	transport: "responses",
	toolProfile: CODEX_TOOL_PROFILE,
	contextWindow: 272_000,
	maxTokens: 128_000,
	supportsTextVerbosity: true,
	defaultTextVerbosity: "low",
	supportsParallelToolCalls: true,
	supportedReasoningLevels: GPT_5_5_REASONING_LEVELS,
	defaultReasoningLevel: "medium",
	baseInstructionsKey: GPT_5_5_INSTRUCTIONS_KEY,
}

const GPT_5_6_API_MODEL = {
	reasoning: true,
	transport: "responses",
	toolProfile: CODEX_TOOL_PROFILE,
	toolMode: "code_mode_only",
	contextWindow: GPT_5_6_CONTEXT_WINDOW,
	maxTokens: 128_000,
	supportsTextVerbosity: true,
	defaultTextVerbosity: "low",
	supportsParallelToolCalls: true,
	supportedReasoningLevels: GPT_5_6_SOL_REASONING_LEVELS,
	defaultReasoningLevel: "low",
	baseInstructionsKey: GPT_5_6_SOL_INSTRUCTIONS_KEY,
	serviceTiers: ["flex", "priority"],
}

const GPT_5_6_SOL_MODEL = {
	reasoning: true,
	transport: "responses",
	toolProfile: CODEX_TOOL_PROFILE,
	toolMode: "code_mode_only",
	contextWindow: GPT_5_6_CONTEXT_WINDOW,
	maxTokens: 128_000,
	supportsTextVerbosity: true,
	defaultTextVerbosity: "low",
	supportsParallelToolCalls: true,
	supportedReasoningLevels: GPT_5_6_SOL_REASONING_LEVELS,
	defaultReasoningLevel: "low",
	baseInstructionsKey: GPT_5_6_SOL_INSTRUCTIONS_KEY,
	useResponsesLite: true,
	serviceTiers: ["priority"],
}

/** @type {ModelEntry[]} */
export const MODEL_REGISTRY = [
	// ─── OpenAI cloud (API key) ──────────────────────────────────────────────
	{
		id: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		...GPT_5_6_API_MODEL,
		...scaledGpt56Pricing(1),
		input: VISION_INPUT,
		tags: ["frontier"],
	},
	{
		id: "gpt-5.6-terra",
		displayName: "GPT-5.6 Terra",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		...GPT_5_6_API_MODEL,
		...scaledGpt56Pricing(0.5),
		input: VISION_INPUT,
		tags: ["frontier"],
	},
	{
		id: "gpt-5.6-luna",
		displayName: "GPT-5.6 Luna",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		...GPT_5_6_API_MODEL,
		...scaledGpt56Pricing(0.2),
		input: VISION_INPUT,
		tags: ["frontier"],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		...GPT_5_5_MODEL,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		tags: ["frontier"],
	},
	{
		id: "gpt-5.5-pro",
		displayName: "GPT-5.5 Pro",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		toolProfile: CODEX_TOOL_PROFILE,
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
		tags: ["frontier", "pro"],
	},
	{
		id: "gpt-5.4-mini",
		displayName: "GPT-5.4 mini",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		toolProfile: CODEX_TOOL_PROFILE,
		contextWindow: 272_000,
		maxTokens: 128_000,
		baseInstructionsKey: GPT_5_4_MINI_INSTRUCTIONS_KEY,
		cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
	},
	{
		id: "gpt-5.4-nano",
		displayName: "GPT-5.4 nano",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		toolProfile: CODEX_TOOL_PROFILE,
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
	},
	// ─── Codex (ChatGPT subscription, OAuth) ────────────────────────────────
	{
		id: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		compaction: { remoteResponses: true },
		...GPT_5_6_SOL_MODEL,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription", "frontier"],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5 (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.5-codex"],
		compaction: { remoteResponses: true },
		...GPT_5_5_MODEL,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	{
		id: "gpt-5.4-mini",
		displayName: "GPT-5.4 mini (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		compaction: { remoteResponses: true },
		reasoning: true,
		toolProfile: CODEX_TOOL_PROFILE,
		contextWindow: 272_000,
		maxTokens: 128_000,
		baseInstructionsKey: GPT_5_4_MINI_INSTRUCTIONS_KEY,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	// ─── Local llama.cpp / OpenAI-compat ────────────────────────────────────
	{
		id: "local",
		displayName: "Local (llama.cpp / OpenAI-compatible)",
		provider: "llamacpp",
		authProvider: "llamacpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: false,
		contextWindow: 32_768,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			supportsPromptCacheKey: false,
		},
		tags: ["local"],
	},

	// ─── Moonshot Kimi K2.x ─────────────────────────────────────────────────
	{
		id: "kimi-k2.6",
		displayName: "Kimi K2.6",
		provider: "moonshot",
		authProvider: "moonshot",
		baseUrl: MOONSHOT_BASE,
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		compat: KIMI_COMPAT,
		tags: ["moonshot", "frontier"],
	},
	{
		id: "kimi-k2.5",
		displayName: "Kimi K2.5",
		provider: "moonshot",
		authProvider: "moonshot",
		baseUrl: MOONSHOT_BASE,
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
		compat: KIMI_COMPAT,
		tags: ["moonshot"],
	},
	{
		id: "kimi-k2-thinking",
		displayName: "Kimi K2 Thinking",
		provider: "moonshot",
		authProvider: "moonshot",
		baseUrl: MOONSHOT_BASE,
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
		compat: KIMI_COMPAT,
		tags: ["moonshot"],
	},

	// ─── DeepSeek V4 ────────────────────────────────────────────────────────
	{
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		provider: "deepseek",
		authProvider: "deepseek",
		baseUrl: DEEPSEEK_BASE,
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
		compat: DEEPSEEK_COMPAT,
		tags: ["deepseek", "reasoning"],
	},
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		provider: "deepseek",
		authProvider: "deepseek",
		baseUrl: DEEPSEEK_BASE,
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		compat: DEEPSEEK_COMPAT,
		tags: ["deepseek", "cheap"],
	},
]

const MODEL_PROVIDERS = new Set(["openai", "openai-codex", "llamacpp", "moonshot", "deepseek"])

/**
 * @param {string} ref
 * @returns {{ provider?: string, id: string }}
 */
export function parseModelRef(ref) {
	const match = ref.match(/^([^/]+)\/(.+)$/)
	if (!match) return { id: ref }
	return { provider: match[1], id: match[2] }
}

/**
 * @param {ModelEntry} entry
 * @returns {string}
 */
export function modelRef(entry) {
	return `${entry.provider}/${entry.id}`
}

/**
 * @param {ModelEntry} entry
 * @param {string} id
 * @param {ModelProvider} [provider]
 * @returns {boolean}
 */
export function modelEntryMatches(entry, id, provider) {
	const parsed = parseModelRef(id)
	const expectedProvider = validProvider(provider) ?? validProvider(parsed.provider)
	if (expectedProvider && entry.provider !== expectedProvider) return false
	return entry.id === parsed.id || (entry.legacyIds ?? []).includes(parsed.id)
}

/**
 * @param {ModelEntry} entry
 * @param {string} id
 * @returns {boolean}
 */
export function modelRefMatches(entry, id) {
	if (id === modelRef(entry)) return true
	const parsed = parseModelRef(id)
	if (validProvider(parsed.provider) && entry.provider !== parsed.provider) return false
	const canonical = parsed.provider ? undefined : findRegistryModelEntry(parsed.id)
	if (canonical && canonical.provider !== entry.provider) return false
	return entry.id === parsed.id || (entry.legacyIds ?? []).includes(parsed.id)
}

/**
 * Return the safe subset of model metadata exposed to picker clients. In particular, provider URLs, headers, compatibility options, and credentials never cross the service boundary.
 *
 * @param {ModelEntry} entry
 * @returns {ModelChoice}
 */
export function modelChoice(entry) {
	return {
		value: modelRef(entry),
		id: entry.id,
		displayName: entry.displayName,
		provider: entry.provider,
		authProvider: entry.authProvider,
		reasoning: entry.reasoning,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		cost: { ...entry.cost },
	}
}

/**
 * Existing sessions may only move within the same provider and may not lose context capacity.
 *
 * @param {Pick<ModelEntry, "provider" | "contextWindow"> | import("../../agent-core/types.js").Model} current
 * @param {Pick<ModelEntry, "provider" | "contextWindow"> | import("../../agent-core/types.js").Model} candidate
 * @returns {string | undefined}
 */
export function sessionModelEligibilityError(current, candidate) {
	if (!current?.provider || candidate?.provider !== current.provider) {
		return `Session models must use the current provider (${current?.provider ?? "unknown"}).`
	}
	const currentContextWindow = positiveNumberOrUndefined(current.contextWindow)
	const candidateContextWindow = positiveNumberOrUndefined(candidate.contextWindow)
	if (!currentContextWindow || !candidateContextWindow || candidateContextWindow < currentContextWindow) {
		return `Session models must have a context window of at least ${currentContextWindow ?? "the current model size"} tokens.`
	}
	return undefined
}

/**
 * @param {Pick<ModelEntry, "provider" | "contextWindow"> | import("../../agent-core/types.js").Model} current
 * @param {ModelEntry[]} entries
 * @returns {ModelEntry[]}
 */
export function eligibleSessionModelEntries(current, entries) {
	return entries.filter((entry) => sessionModelEligibilityError(current, entry) === undefined)
}

/** @param {unknown} value */
function plainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {}
}

/** @param {unknown} value */
function validProvider(value) {
	return typeof value === "string" && MODEL_PROVIDERS.has(value) ? /** @type {ModelProvider} */ (value) : undefined
}

/** @param {unknown} value */
export function knownModelProvider(value) {
	return validProvider(value)
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

/** @param {unknown} value */
function positiveNumberOrUndefined(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** @param {unknown} value @param {number} fallback */
function finiteNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function mergeCost(base, value) {
	const cost = plainObject(value)
	return {
		input: finiteNumber(cost.input, base.input),
		output: finiteNumber(cost.output, base.output),
		cacheRead: finiteNumber(cost.cacheRead, base.cacheRead),
		cacheWrite: finiteNumber(cost.cacheWrite, base.cacheWrite),
	}
}

function mergePricing(base, modelConfig) {
	if (modelConfig.pricing === null) return undefined
	const pricing = plainObject(modelConfig.pricing)
	if (Object.keys(pricing).length > 0) return pricing
	if (Object.keys(plainObject(modelConfig.cost)).length > 0) return undefined
	return base
}

function mergeRecords(...sources) {
	const merged = {}
	for (const source of sources) {
		for (const [key, value] of Object.entries(plainObject(source))) {
			if (typeof value === "string") merged[key] = value
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined
}

function mergeObjects(...sources) {
	const merged = {}
	for (const source of sources) Object.assign(merged, plainObject(source))
	return Object.keys(merged).length > 0 ? merged : undefined
}

/** @param {unknown} value @param {ModelEntry["input"]} fallback */
function modelInput(value, fallback) {
	if (!Array.isArray(value)) return fallback
	const input = value.filter((item) => item === "text" || item === "image")
	return input.length > 0 ? input : fallback
}

/** @param {unknown} value @param {ModelEntry["transport"]} fallback */
function modelTransport(value, fallback) {
	return value === "chat" || value === "responses" ? value : fallback
}

/** @param {unknown} value @param {ModelEntry["codexTransport"]} fallback */
function modelCodexTransport(value, fallback) {
	return value === "auto" || value === "sse" || value === "websocket" ? value : fallback
}

/** @param {unknown} value @param {ModelEntry["toolProfile"]} fallback */
function modelToolProfile(value, fallback) {
	if (value === CODEX_TOOL_PROFILE || value === DEFAULT_TOOL_PROFILE) return value
	return fallback
}

/** @param {unknown} value @param {ModelEntry["toolMode"]} fallback */
function modelToolMode(value, fallback) {
	return value === "code_mode_only" ? value : fallback
}

/** @param {unknown} value @param {string[] | undefined} fallback */
function stringArray(value, fallback) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback
}

/** @param {string} baseUrl @param {string} suffix */
function appendPath(baseUrl, suffix) {
	try {
		const url = new URL(baseUrl)
		const path = url.pathname.replace(/\/+$/, "")
		url.pathname = `${path}${suffix}`
		url.search = ""
		url.hash = ""
		return url.toString()
	} catch {
		return undefined
	}
}

/** @param {string} baseUrl */
function openAiModelsUrl(baseUrl) {
	return appendPath(baseUrl, "/models")
}

/** @param {string} baseUrl */
function llamaPropsUrl(baseUrl) {
	try {
		const url = new URL(baseUrl)
		const path = url.pathname.replace(/\/+$/, "")
		url.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/"
		url.search = ""
		url.hash = ""
		return appendPath(url.toString(), "/props")
	} catch {
		return undefined
	}
}

/**
 * @param {string} url
 * @param {{ headers?: Record<string, string>, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 */
async function fetchJsonUncached(url, options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch
	if (typeof fetchFn !== "function") return undefined
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MODEL_METADATA_TIMEOUT_MS)
	try {
		const response = await fetchFn(url, {
			headers: options.headers,
			signal: controller.signal,
		})
		if (!response.ok) return undefined
		return await response.json()
	} catch {
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

/** @param {string} url @param {Record<string, string> | undefined} headers */
function fetchCacheKey(url, headers) {
	return JSON.stringify([url, headers ? Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)) : []])
}

/**
 * @param {string} url
 * @param {{ headers?: Record<string, string>, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 */
async function fetchJsonWithTimeout(url, options = {}) {
	if (options.fetchFn) return fetchJsonUncached(url, options)
	const key = fetchCacheKey(url, options.headers)
	const now = Date.now()
	const cached = modelMetadataFetchCache.get(key)
	if (cached && cached.expiresAt > now) return cached.promise

	const promise = fetchJsonUncached(url, options)
	const cacheEntry = { promise, expiresAt: now + MODEL_METADATA_FAILURE_CACHE_MS }
	modelMetadataFetchCache.set(key, cacheEntry)
	promise.then((value) => {
		if (modelMetadataFetchCache.get(key) !== cacheEntry) return
		cacheEntry.expiresAt = Date.now() + (value === undefined ? MODEL_METADATA_FAILURE_CACHE_MS : MODEL_METADATA_SUCCESS_CACHE_MS)
	})
	return promise
}

/** @param {ModelEntry} entry @param {string | undefined} apiKey */
function metadataHeaders(entry, apiKey) {
	const headers = { ...(entry.headers ?? {}) }
	if (apiKey && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${apiKey}`
	return Object.keys(headers).length > 0 ? headers : undefined
}

/** @param {unknown} payload */
function contextWindowFromProps(payload) {
	const settings = plainObject(plainObject(payload).default_generation_settings)
	return positiveNumberOrUndefined(settings.n_ctx)
}

/** @param {unknown} modelInfo */
function contextWindowFromModelInfo(modelInfo) {
	const info = plainObject(modelInfo)
	const meta = plainObject(info.meta)
	for (const value of [
		meta.n_ctx,
		meta.contextWindow,
		meta.context_window,
		meta.context_length,
		meta.max_context_length,
		meta.max_context_window,
		meta.max_context_tokens,
		meta.max_model_len,
		info.contextWindow,
		info.context_window,
		info.context_length,
		info.max_context_length,
		info.max_context_window,
		info.max_context_tokens,
		info.max_model_len,
	]) {
		const n = positiveNumberOrUndefined(value)
		if (n !== undefined) return n
	}
	return undefined
}

/**
 * @param {unknown} payload
 * @param {ModelEntry} entry
 */
function contextWindowFromModelsPayload(payload, entry) {
	const record = plainObject(payload)
	const models = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : []
	const expectedIds = new Set([entry.id, entry.wireModel].filter((id) => typeof id === "string" && id))
	const matching = models.find((item) => {
		const info = plainObject(item)
		if (typeof info.id === "string" && expectedIds.has(info.id)) return true
		return stringArray(info.aliases, undefined)?.some((alias) => expectedIds.has(alias)) ?? false
	}) ?? (models.length === 1 ? models[0] : undefined)
	return contextWindowFromModelInfo(matching)
}

/**
 * @param {ModelEntry} entry
 * @param {{ apiKey?: string, fetchFn?: typeof fetch }} [options]
 */
async function providerModelMetadata(entry, options = {}) {
	if (entry.provider !== "llamacpp") return undefined
	const headers = metadataHeaders(entry, options.apiKey)
	const propsUrl = llamaPropsUrl(entry.baseUrl)
	const props = propsUrl ? await fetchJsonWithTimeout(propsUrl, { headers, fetchFn: options.fetchFn }) : undefined
	const propsContextWindow = contextWindowFromProps(props)
	if (propsContextWindow !== undefined) return { contextWindow: propsContextWindow }

	const modelsUrl = openAiModelsUrl(entry.baseUrl)
	const models = modelsUrl ? await fetchJsonWithTimeout(modelsUrl, { headers, fetchFn: options.fetchFn }) : undefined
	const modelsContextWindow = contextWindowFromModelsPayload(models, entry)
	return modelsContextWindow !== undefined ? { contextWindow: modelsContextWindow } : undefined
}

/**
 * @param {ModelEntry} entry
 * @param {{ apiKey?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<ModelEntry>}
 */
async function modelEntryWithProviderMetadata(entry, options = {}) {
	if (entry._contextWindowExplicit) return entry
	const metadata = await providerModelMetadata(entry, options)
	return metadata?.contextWindow ? { ...entry, contextWindow: metadata.contextWindow } : entry
}

/**
 * @param {ModelEntry} entry
 * @param {{ providers?: Record<string, import("../settings.js").ProviderSettings>, apiKey?: string }} [options]
 */
async function apiKeyForEntry(entry, options = {}) {
	if (typeof options.apiKey === "string" && options.apiKey) return options.apiKey
	const configuredKey = options.providers?.[entry.authProvider]?.apiKey
	return (typeof configuredKey === "string" && configuredKey) || await resolveApiKey(entry.authProvider)
}

/**
 * @param {string} id
 * @param {{ provider?: ModelProvider }} [options]
 * @returns {ModelEntry | undefined}
 */
function findRegistryModelEntry(id, options = {}) {
	const parsed = parseModelRef(id)
	const provider = options.provider ?? validProvider(parsed.provider)
	return MODEL_REGISTRY.find((m) => modelEntryMatches(m, parsed.id, provider))
}

/** @param {ModelProvider} provider */
function defaultTemplateForProvider(provider) {
	return MODEL_REGISTRY.find((m) => m.provider === provider) ?? /** @type {ModelEntry} */ (findRegistryModelEntry("llamacpp/local"))
}

function hasProviderModelOverrides(config) {
	return ["authProvider", "baseUrl", "headers", "compat", "transport", "codexTransport"].some((key) => config[key] !== undefined)
		|| Object.keys(plainObject(config.modelOverrides)).length > 0
}

/**
 * @param {ModelProvider} provider
 * @param {Record<string, any>} providerConfig
 * @param {Record<string, any>} modelConfig
 * @param {ModelEntry} template
 * @returns {ModelEntry}
 */
function configuredModelEntry(provider, providerConfig, modelConfig, template) {
	const id = typeof modelConfig.id === "string" && modelConfig.id ? modelConfig.id : template.id
	const extended = typeof modelConfig.extends === "string" ? findRegistryModelEntry(modelConfig.extends) : undefined
	const baseTemplate = extended ?? template
	const authProvider = validProvider(modelConfig.authProvider) ?? validProvider(providerConfig.authProvider) ?? provider
	const sameTemplateModel = baseTemplate.id === id && baseTemplate.provider === provider
	const contextWindowExplicit = positiveNumberOrUndefined(modelConfig.contextWindow) !== undefined
	const extraCapabilities = {
		useResponsesLite: typeof modelConfig.useResponsesLite === "boolean" ? modelConfig.useResponsesLite : baseTemplate.useResponsesLite,
		serviceTiers: stringArray(modelConfig.serviceTiers, baseTemplate.serviceTiers),
		toolMode: modelToolMode(modelConfig.toolMode, baseTemplate.toolMode),
	}
	return {
		...baseTemplate,
		...extraCapabilities,
		id,
		displayName: typeof modelConfig.displayName === "string" && modelConfig.displayName ? modelConfig.displayName : sameTemplateModel ? baseTemplate.displayName : id,
		provider,
		authProvider,
		baseUrl: typeof modelConfig.baseUrl === "string" && modelConfig.baseUrl ? modelConfig.baseUrl : typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl ? providerConfig.baseUrl : baseTemplate.baseUrl,
		wireModel: typeof modelConfig.wireModel === "string" && modelConfig.wireModel ? modelConfig.wireModel : sameTemplateModel ? baseTemplate.wireModel : id,
		reasoning: typeof modelConfig.reasoning === "boolean" ? modelConfig.reasoning : baseTemplate.reasoning,
		contextWindow: positiveNumber(modelConfig.contextWindow, baseTemplate.contextWindow),
		maxTokens: positiveNumber(modelConfig.maxTokens, baseTemplate.maxTokens),
		cost: mergeCost(baseTemplate.cost, modelConfig.cost),
		pricing: mergePricing(baseTemplate.pricing, modelConfig),
		input: modelInput(modelConfig.input, baseTemplate.input),
		headers: mergeRecords(baseTemplate.headers, providerConfig.headers, modelConfig.headers),
		compat: mergeObjects(baseTemplate.compat, providerConfig.compat, modelConfig.compat),
		compaction: mergeObjects(baseTemplate.compaction, modelConfig.compaction),
		transport: modelTransport(modelConfig.transport, modelTransport(providerConfig.transport, baseTemplate.transport)),
		codexTransport: modelCodexTransport(modelConfig.codexTransport, modelCodexTransport(providerConfig.codexTransport, baseTemplate.codexTransport)),
		maintenanceModelRef: typeof modelConfig.maintenanceModelRef === "string" && modelConfig.maintenanceModelRef ? modelConfig.maintenanceModelRef : baseTemplate.maintenanceModelRef,
		toolProfile: modelToolProfile(modelConfig.toolProfile, baseTemplate.toolProfile),
		tags: stringArray(modelConfig.tags, baseTemplate.tags),
		...(contextWindowExplicit ? { _contextWindowExplicit: true } : {}),
	}
}

/**
 * @param {Record<string, import("../settings.js").ProviderSettings> | undefined} providers
 * @returns {ModelEntry[]}
 */
export function configuredModelEntries(providers = {}) {
	const entries = []
	for (const [providerId, value] of Object.entries(plainObject(providers))) {
		const provider = validProvider(providerId)
		if (!provider) continue
		const providerConfig = plainObject(value)
		const overrides = plainObject(providerConfig.modelOverrides)
		if (Array.isArray(providerConfig.models)) {
			for (const modelValue of providerConfig.models) {
				const modelConfig = plainObject(modelValue)
				if (typeof modelConfig.id !== "string" || !modelConfig.id) continue
				const template = (typeof modelConfig.extends === "string" ? findRegistryModelEntry(modelConfig.extends) : undefined)
					?? findRegistryModelEntry(modelConfig.id, { provider })
					?? defaultTemplateForProvider(provider)
				entries.push(configuredModelEntry(provider, providerConfig, modelConfig, template))
			}
		}
		if (hasProviderModelOverrides(providerConfig)) {
			for (const template of MODEL_REGISTRY.filter((m) => m.provider === provider)) {
				entries.push(configuredModelEntry(provider, providerConfig, { id: template.id, ...plainObject(overrides[template.id]) }, template))
			}
		}
	}
	return entries
}

/** @param {ModelEntry[]} entries */
function dedupeModelEntries(entries) {
	const seen = new Set()
	const result = []
	for (const entry of entries) {
		const key = modelRef(entry)
		if (seen.has(key)) continue
		seen.add(key)
		result.push(entry)
	}
	return result
}

/** @param {Record<string, import("../settings.js").ProviderSettings> | undefined} providers */
function allModelEntries(providers = {}) {
	return dedupeModelEntries([...configuredModelEntries(providers), ...MODEL_REGISTRY])
}

/**
 * @param {Record<string, import("../settings.js").ProviderSettings> | undefined} providers
 * @param {string} ref
 */
export function providerSettingsHasRef(providers, ref) {
	return configuredModelEntries(providers).some((entry) => modelRefMatches(entry, ref))
}

/**
 * @param {string} id
 * @param {{ provider?: ModelProvider, providers?: Record<string, import("../settings.js").ProviderSettings> }} [options]
 * @returns {ModelEntry | undefined}
 */
export function findModelEntry(id, options = {}) {
	const parsed = parseModelRef(id)
	const provider = validProvider(options.provider) ?? validProvider(parsed.provider)
	return allModelEntries(options.providers).find((m) => modelEntryMatches(m, parsed.id, provider))
}

/**
 * @param {string} id
 * @param {{ provider?: string, providers?: Record<string, import("../settings.js").ProviderSettings> }} [options]
 */
export function canonicalModelRef(id, options = {}) {
	const entry = findModelEntry(id, { providers: options.providers })
	if (entry) return modelRef(entry)
	const parsed = parseModelRef(id)
	if (parsed.provider) return id
	return `${options.provider ?? "llamacpp"}/${parsed.id}`
}

/**
 * @param {import("../settings.js").Settings | undefined} [settings]
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<ModelEntry[]>}
 */
export async function availableModelEntries(settings = undefined, options = {}) {
	const entries = allModelEntries(settings?.providers)
	const providers = Array.from(new Set(entries.map((m) => m.authProvider)))
	const available = new Map(
		(await Promise.all(providers.map(async (p) => {
			const configuredKey = settings?.providers?.[p]?.apiKey
			const apiKey = (typeof configuredKey === "string" && configuredKey) || await resolveApiKey(p)
			return apiKey ? /** @type {[ModelProvider, string]} */ ([p, apiKey]) : undefined
		}))).filter((entry) => entry !== undefined),
	)
	const sorted = entries
		.filter((m) => available.has(m.authProvider))
		.sort((a, b) => {
			if (a.authProvider === "openai-codex" && b.authProvider !== "openai-codex") return -1
			if (a.authProvider !== "openai-codex" && b.authProvider === "openai-codex") return 1
			return 0
		})
	return Promise.all(sorted.map((entry) => modelEntryWithProviderMetadata(entry, {
		apiKey: available.get(entry.authProvider),
		fetchFn: options.fetchFn,
	})))
}

/**
 * Build the Model struct that ai-apis consumes from a registry or settings model entry.
 *
 * @param {ModelEntry} entry
 * @param {{ baseUrl?: string, id?: string }} [overrides]
 */
export function buildModel(entry, overrides = {}) {
	const extraCapabilities = {
		useResponsesLite: entry.useResponsesLite,
		serviceTiers: entry.serviceTiers ? [...entry.serviceTiers] : undefined,
		toolMode: entry.toolMode,
	}
	return {
		...extraCapabilities,
		id: overrides.id ?? entry.id,
		wireModel: entry.wireModel ?? entry.id,
		provider: entry.provider,
		authProvider: entry.authProvider,
		baseUrl: overrides.baseUrl ?? entry.baseUrl,
		reasoning: entry.reasoning,
		transport: entry.transport,
		codexTransport: entry.codexTransport,
		input: [
			...(entry.input ?? (entry.provider === "openai" || entry.provider === "openai-codex" ? VISION_INPUT : TEXT_ONLY_INPUT)),
		],
		headers: entry.headers,
		cost: entry.cost,
		pricing: entry.pricing,
		costVersion: entry.costVersion,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat,
		compaction: entry.compaction ? { ...entry.compaction } : undefined,
		supportsTextVerbosity: entry.supportsTextVerbosity,
		defaultTextVerbosity: entry.defaultTextVerbosity,
		supportsParallelToolCalls: entry.supportsParallelToolCalls,
		supportedReasoningLevels: entry.supportedReasoningLevels ? [...entry.supportedReasoningLevels] : undefined,
		defaultReasoningLevel: entry.defaultReasoningLevel,
		baseInstructionsKey: entry.baseInstructionsKey,
		maintenanceModelRef: entry.maintenanceModelRef,
		toolProfile: entry.toolProfile,
	}
}

/**
 * Refresh a persisted model object with current registry metadata while keeping
 * the session-selected id/provider/baseUrl. This preserves model locking but
 * lets old sessions pick up new model capabilities.
 *
 * @param {any} model
 * @param {string | undefined} [ref]
 * @returns {any}
 */
export function refreshModelFromRegistry(model, ref = undefined) {
	if (!model?.id && !ref) return model
	const entry =
		(model?.id && model?.provider ? findRegistryModelEntry(model.id, { provider: model.provider }) : undefined)
		?? (ref ? findRegistryModelEntry(ref) : undefined)
		?? (model?.id ? findRegistryModelEntry(model.id) : undefined)
	if (!entry) return model
	const refreshed = buildModel(entry, { id: model?.id ?? entry.id, baseUrl: model?.baseUrl })
	const next = { ...model, ...refreshed }
	delete next.baseInstructions
	return next
}

/**
 * Refresh a persisted model like `refreshModelFromRegistry`, then enrich
 * llama.cpp metadata from the current provider when available.
 *
 * @param {any} model
 * @param {string | undefined} [ref]
 * @param {{ providers?: Record<string, import("../settings.js").ProviderSettings>, apiKey?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<any>}
 */
export async function refreshModelWithProviderMetadata(model, ref = undefined, options = {}) {
	if (!model?.id && !ref) return model
	const refreshed = refreshModelFromRegistry(model, ref)
	const entryRef = ref ?? (model?.provider && model?.id ? `${model.provider}/${model.id}` : model?.id)
	const entry =
		(entryRef ? findModelEntry(entryRef, { provider: model?.provider, providers: options.providers }) : undefined)
		?? (refreshed?.id ? findModelEntry(refreshed.id, { provider: refreshed.provider, providers: options.providers }) : undefined)
	if (!entry) return refreshed
	const baseUrl = refreshed?.baseUrl ?? model?.baseUrl ?? entry.baseUrl
	const modelEntry = { ...entry, baseUrl }
	const apiKey = modelEntry.provider === "llamacpp" && !modelEntry._contextWindowExplicit ? await apiKeyForEntry(modelEntry, options) : undefined
	const enriched = buildModel(await modelEntryWithProviderMetadata(modelEntry, {
		apiKey,
		fetchFn: options.fetchFn,
	}), {
		id: refreshed?.id ?? model?.id ?? entry.id,
		baseUrl,
	})
	const next = { ...model, ...refreshed, ...enriched }
	delete next.baseInstructions
	return next
}

/**
 * Resolve a model from the curated registry plus declarative settings providers.
 * Unknown ids fall back to the selected provider's first registry template.
 *
 * @param {string} id
 * @param {{ provider?: ModelProvider, providers?: Record<string, import("../settings.js").ProviderSettings> }} [options]
 */
export function resolveModel(id, options = {}) {
	const entry = findModelEntry(id, { provider: options.provider, providers: options.providers })
	if (entry) return buildModel(entry)
	const parsed = parseModelRef(id)
	const provider = validProvider(options.provider) ?? validProvider(parsed.provider) ?? "llamacpp"
	return buildModel(defaultTemplateForProvider(provider), { id: parsed.id })
}

/**
 * Resolve a model like `resolveModel`, enriching llama.cpp entries with
 * provider metadata when the server exposes it. Explicit `contextWindow`
 * settings are left untouched.
 *
 * @param {string} id
 * @param {{ provider?: ModelProvider, providers?: Record<string, import("../settings.js").ProviderSettings>, apiKey?: string, fetchFn?: typeof fetch }} [options]
 */
export async function resolveModelWithProviderMetadata(id, options = {}) {
	const entry = findModelEntry(id, { provider: options.provider, providers: options.providers })
	if (!entry) return resolveModel(id, options)
	const apiKey = entry.provider === "llamacpp" && !entry._contextWindowExplicit ? await apiKeyForEntry(entry, options) : undefined
	return buildModel(await modelEntryWithProviderMetadata(entry, {
		apiKey,
		fetchFn: options.fetchFn,
	}))
}
