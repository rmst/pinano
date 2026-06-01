// Curated model registry. Cost / context / capability numbers come from
// pi-mono's `packages/ai/src/models.generated.ts` (commit 3d5cbe98) and are
// kept in sync manually for the providers we actually care about:
//
//   - OpenAI cloud (API key)        — gpt-5.5 / gpt-5.4
//   - Codex (ChatGPT subscription)  — gpt-5.5 / gpt-5.4 / gpt-5.4-mini via OAuth
//   - Local llama.cpp / OpenAI-compat
//   - Moonshot Kimi K2.x
//   - DeepSeek V4
//
// src/ai-apis speaks both /v1/chat/completions and /v1/responses. The
// reasoning gpt-5.x family is responses-only when combined with tools, so we
// flag those entries with `transport: "responses"`. Everything else (kimi,
// deepseek, llama.cpp) stays on chat completions, which is also what
// most OpenAI-compatible servers speak.

import { resolveApiKey } from "./auth.js"
import { APPLY_PATCH_TOOL_PROFILE, DEFAULT_TOOL_PROFILE, GPT_5_4_MINI_PINANO_INSTRUCTIONS_KEY, GPT_5_5_PINANO_INSTRUCTIONS_KEY } from "./model-instructions.js"

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
 * @property {("text" | "image")[]} [input]
 * @property {Record<string, unknown>} [compat]
 * @property {{ implicitResponses?: boolean }} [compaction]
 * @property {"chat" | "responses"} [transport]
 * @property {boolean} [supportsTextVerbosity]
 * @property {"low" | "medium" | "high"} [defaultTextVerbosity]
 * @property {boolean} [supportsParallelToolCalls]
 * @property {("none" | "minimal" | "low" | "medium" | "high" | "xhigh")[]} [supportedReasoningLevels]
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh"} [defaultReasoningLevel]
 * @property {string} [baseInstructionsKey]
 * @property {"default" | "apply_patch"} [toolProfile]
 * @property {string[]} [tags]
 */

const OPENAI_BASE = "https://api.openai.com/v1"
const CODEX_BASE = "https://chatgpt.com/backend-api"
const MOONSHOT_BASE = "https://api.moonshot.ai/v1"
const DEEPSEEK_BASE = "https://api.deepseek.com"
const TEXT_ONLY_INPUT = ["text"]
const VISION_INPUT = ["text", "image"]

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

const GPT_5_5_MODEL = {
	reasoning: true,
	transport: "responses",
	toolProfile: APPLY_PATCH_TOOL_PROFILE,
	compaction: { implicitResponses: true },
	contextWindow: 272_000,
	maxTokens: 128_000,
	supportsTextVerbosity: true,
	defaultTextVerbosity: "low",
	supportsParallelToolCalls: true,
	supportedReasoningLevels: GPT_5_5_REASONING_LEVELS,
	defaultReasoningLevel: "medium",
	baseInstructionsKey: GPT_5_5_PINANO_INSTRUCTIONS_KEY,
}

/** @type {ModelEntry[]} */
export const MODEL_REGISTRY = [
	// ─── OpenAI cloud (API key) ──────────────────────────────────────────────
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
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
		tags: ["frontier", "pro"],
	},
	{
		id: "gpt-5.4",
		displayName: "GPT-5.4",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	},
	{
		id: "gpt-5.4-mini",
		displayName: "GPT-5.4 mini",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 272_000,
		maxTokens: 128_000,
		baseInstructionsKey: GPT_5_4_MINI_PINANO_INSTRUCTIONS_KEY,
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
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
	},
	// ─── Codex (ChatGPT subscription, OAuth) ────────────────────────────────
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5 (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.5-codex"],
		...GPT_5_5_MODEL,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	{
		id: "gpt-5.4",
		displayName: "GPT-5.4 (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.4-codex"],
		reasoning: true,
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	{
		id: "gpt-5.4-mini",
		displayName: "GPT-5.4 mini (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		reasoning: true,
		toolProfile: APPLY_PATCH_TOOL_PROFILE,
		compaction: { implicitResponses: true },
		contextWindow: 272_000,
		maxTokens: 128_000,
		baseInstructionsKey: GPT_5_4_MINI_PINANO_INSTRUCTIONS_KEY,
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
 * @returns {{ provider?: ModelProvider, id: string }}
 */
function parseModelRef(ref) {
	const match = ref.match(/^([^/]+)\/(.+)$/)
	if (!match) return { id: ref }
	return { provider: /** @type {ModelProvider} */ (match[1]), id: match[2] }
}

/**
 * @param {ModelEntry} entry
 * @returns {string}
 */
export function modelRef(entry) {
	return entry.provider === "openai-codex" ? `${entry.provider}/${entry.id}` : entry.id
}

/**
 * @param {ModelEntry} entry
 * @param {string} id
 * @param {ModelProvider} [provider]
 * @returns {boolean}
 */
export function modelEntryMatches(entry, id, provider) {
	const parsed = parseModelRef(id)
	const expectedProvider = provider ?? validProvider(parsed.provider)
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
	if ((entry.legacyIds ?? []).includes(id)) return true
	return !id.includes("/") && entry.provider !== "openai-codex" && modelEntryMatches(entry, id)
}

/** @param {unknown} value */
function plainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {}
}

/** @param {unknown} value */
function validProvider(value) {
	return typeof value === "string" && MODEL_PROVIDERS.has(value) ? /** @type {ModelProvider} */ (value) : undefined
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
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

/** @param {unknown} value @param {ModelEntry["toolProfile"]} fallback */
function modelToolProfile(value, fallback) {
	if (value === APPLY_PATCH_TOOL_PROFILE || value === DEFAULT_TOOL_PROFILE) return value
	return fallback
}

/** @param {unknown} value @param {string[] | undefined} fallback */
function stringArray(value, fallback) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback
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

/** @param {string} ref @param {unknown} value */
function configuredModelEntry(ref, value) {
	const config = plainObject(value)
	if (Object.keys(config).length === 0 && (!value || typeof value !== "object")) return undefined
	const parsed = parseModelRef(ref)
	const extended = typeof config.extends === "string" ? findRegistryModelEntry(config.extends) : undefined
	const template = extended ?? findRegistryModelEntry(ref) ?? /** @type {ModelEntry} */ (findRegistryModelEntry("local"))
	const provider = validProvider(config.provider) ?? validProvider(parsed.provider) ?? template.provider
	const authProvider = validProvider(config.authProvider) ?? (provider !== template.provider ? provider : template.authProvider)
	const sameTemplateModel = template.id === parsed.id && template.provider === provider
	return {
		...template,
		id: parsed.id,
		displayName: typeof config.displayName === "string" && config.displayName ? config.displayName : sameTemplateModel ? template.displayName : parsed.id,
		provider,
		authProvider,
		baseUrl: typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl : template.baseUrl,
		wireModel: typeof config.wireModel === "string" && config.wireModel ? config.wireModel : sameTemplateModel ? template.wireModel : parsed.id,
		reasoning: typeof config.reasoning === "boolean" ? config.reasoning : template.reasoning,
		contextWindow: positiveNumber(config.contextWindow, template.contextWindow),
		maxTokens: positiveNumber(config.maxTokens, template.maxTokens),
		cost: mergeCost(template.cost, config.cost),
		input: modelInput(config.input, template.input),
		compat: Object.keys(plainObject(config.compat)).length > 0 ? { ...(template.compat ?? {}), ...plainObject(config.compat) } : template.compat,
		compaction: Object.keys(plainObject(config.compaction)).length > 0 ? { ...(template.compaction ?? {}), ...plainObject(config.compaction) } : template.compaction,
		transport: modelTransport(config.transport, template.transport),
		toolProfile: modelToolProfile(config.toolProfile, template.toolProfile),
		tags: stringArray(config.tags, template.tags),
	}
}

/**
 * @param {Record<string, import("./settings.js").ModelSettings> | undefined} models
 * @returns {ModelEntry[]}
 */
export function configuredModelEntries(models = {}) {
	return Object.entries(plainObject(models))
		.map(([ref, config]) => configuredModelEntry(ref, config))
		.filter(Boolean)
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

/** @param {Record<string, import("./settings.js").ModelSettings> | undefined} models */
function allModelEntries(models = {}) {
	return dedupeModelEntries([...configuredModelEntries(models), ...MODEL_REGISTRY])
}

/**
 * @param {Record<string, import("./settings.js").ModelSettings> | undefined} models
 * @param {string} ref
 */
export function modelSettingsHasRef(models, ref) {
	return configuredModelEntries(models).some((entry) => modelRefMatches(entry, ref))
}

/**
 * @param {string} id
 * @param {{ provider?: ModelProvider, models?: Record<string, import("./settings.js").ModelSettings> }} [options]
 * @returns {ModelEntry | undefined}
 */
export function findModelEntry(id, options = {}) {
	const parsed = parseModelRef(id)
	const provider = options.provider ?? validProvider(parsed.provider)
	return allModelEntries(options.models).find((m) => modelEntryMatches(m, parsed.id, provider))
}

/**
 * @param {import("./settings.js").Settings | undefined} [settings]
 * @returns {Promise<ModelEntry[]>}
 */
export async function availableModelEntries(settings = undefined) {
	const entries = allModelEntries(settings?.models)
	const providers = Array.from(new Set(entries.map((m) => m.authProvider)))
	const available = new Set(
		/** @type {ModelProvider[]} */ ((await Promise.all(providers.map(async (p) => ((await resolveApiKey(p)) ? p : undefined)))).filter(Boolean)),
	)
	return entries
		.filter((m) => available.has(m.authProvider))
		.sort((a, b) => {
			if (a.authProvider === "openai-codex" && b.authProvider !== "openai-codex") return -1
			if (a.authProvider !== "openai-codex" && b.authProvider === "openai-codex") return 1
			return 0
		})
}

/**
 * Build the Model struct that ai-apis consumes from a registry or settings model entry.
 *
 * @param {ModelEntry} entry
 * @param {{ baseUrl?: string, id?: string }} [overrides]
 */
export function buildModel(entry, overrides = {}) {
	return {
		id: overrides.id ?? entry.id,
		wireModel: entry.wireModel ?? entry.id,
		provider: entry.provider,
		authProvider: entry.authProvider,
		baseUrl: overrides.baseUrl ?? entry.baseUrl,
		reasoning: entry.reasoning,
		transport: entry.transport,
		input: [
			...(entry.input ?? (entry.provider === "openai" || entry.provider === "openai-codex" ? VISION_INPUT : TEXT_ONLY_INPUT)),
		],
		cost: entry.cost,
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
		toolProfile: entry.toolProfile,
	}
}

/**
 * Refresh a persisted model object with current registry metadata while keeping
 * the session-selected id/provider/baseUrl. This preserves model locking but
 * lets old sessions pick up new capabilities such as implicit compaction.
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
 * Resolve a model from the curated registry plus declarative settings.models.
 * Unknown ids fall back to the local-llamacpp template.
 *
 * @param {string} id
 * @param {{ models?: Record<string, import("./settings.js").ModelSettings> }} [options]
 */
export function resolveModel(id, options = {}) {
	const entry = findModelEntry(id, { models: options.models })
	if (entry) return buildModel(entry)
	return buildModel(/** @type {ModelEntry} */ (findRegistryModelEntry("local")), { id })
}
