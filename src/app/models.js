// Curated model registry. Cost / context / capability numbers come from
// pi-mono's `packages/ai/src/models.generated.ts` (commit 3d5cbe98) and are
// kept in sync manually for the providers we actually care about:
//
//   - OpenAI cloud (API key)        — gpt-5.5 / gpt-5.4-mini
//   - Codex (ChatGPT subscription)  — gpt-5.5 / gpt-5.4-mini via OAuth
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
import { CODEX_TOOL_PROFILE, DEFAULT_TOOL_PROFILE, GPT_5_4_MINI_PINANO_INSTRUCTIONS_KEY, GPT_5_5_PINANO_INSTRUCTIONS_KEY } from "./model-instructions.js"

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
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} [compat]
 * @property {"chat" | "responses"} [transport]
 * @property {boolean} [supportsTextVerbosity]
 * @property {"low" | "medium" | "high"} [defaultTextVerbosity]
 * @property {boolean} [supportsParallelToolCalls]
 * @property {("none" | "minimal" | "low" | "medium" | "high" | "xhigh")[]} [supportedReasoningLevels]
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh"} [defaultReasoningLevel]
 * @property {string} [baseInstructionsKey]
 * @property {string} [maintenanceModelRef]
 * @property {"default" | "codex"} [toolProfile]
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
	toolProfile: CODEX_TOOL_PROFILE,
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
		toolProfile: CODEX_TOOL_PROFILE,
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
		id: "gpt-5.4-mini",
		displayName: "GPT-5.4 mini (subscription)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		reasoning: true,
		toolProfile: CODEX_TOOL_PROFILE,
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

/** @param {unknown} value @param {ModelEntry["toolProfile"]} fallback */
function modelToolProfile(value, fallback) {
	if (value === CODEX_TOOL_PROFILE || value === DEFAULT_TOOL_PROFILE) return value
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

/** @param {ModelProvider} provider */
function defaultTemplateForProvider(provider) {
	return MODEL_REGISTRY.find((m) => m.provider === provider) ?? /** @type {ModelEntry} */ (findRegistryModelEntry("llamacpp/local"))
}

function hasProviderModelOverrides(config) {
	return ["authProvider", "baseUrl", "headers", "compat", "transport"].some((key) => config[key] !== undefined)
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
	return {
		...baseTemplate,
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
		input: modelInput(modelConfig.input, baseTemplate.input),
		headers: mergeRecords(baseTemplate.headers, providerConfig.headers, modelConfig.headers),
		compat: mergeObjects(baseTemplate.compat, providerConfig.compat, modelConfig.compat),
		transport: modelTransport(modelConfig.transport, modelTransport(providerConfig.transport, baseTemplate.transport)),
		maintenanceModelRef: typeof modelConfig.maintenanceModelRef === "string" && modelConfig.maintenanceModelRef ? modelConfig.maintenanceModelRef : baseTemplate.maintenanceModelRef,
		toolProfile: modelToolProfile(modelConfig.toolProfile, baseTemplate.toolProfile),
		tags: stringArray(modelConfig.tags, baseTemplate.tags),
	}
}

/**
 * @param {Record<string, import("./settings.js").ProviderSettings> | undefined} providers
 * @returns {ModelEntry[]}
 */
export function configuredModelEntries(providers = {}) {
	const entries = []
	for (const [providerId, value] of Object.entries(plainObject(providers))) {
		const provider = validProvider(providerId)
		if (!provider) continue
		const providerConfig = plainObject(value)
		const overrides = plainObject(providerConfig.modelOverrides)
		if (hasProviderModelOverrides(providerConfig)) {
			for (const template of MODEL_REGISTRY.filter((m) => m.provider === provider)) {
				entries.push(configuredModelEntry(provider, providerConfig, { id: template.id, ...plainObject(overrides[template.id]) }, template))
			}
		}
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

/** @param {Record<string, import("./settings.js").ProviderSettings> | undefined} providers */
function allModelEntries(providers = {}) {
	return dedupeModelEntries([...configuredModelEntries(providers), ...MODEL_REGISTRY])
}

/**
 * @param {Record<string, import("./settings.js").ProviderSettings> | undefined} providers
 * @param {string} ref
 */
export function providerSettingsHasRef(providers, ref) {
	return configuredModelEntries(providers).some((entry) => modelRefMatches(entry, ref))
}

/**
 * @param {string} id
 * @param {{ provider?: ModelProvider, providers?: Record<string, import("./settings.js").ProviderSettings> }} [options]
 * @returns {ModelEntry | undefined}
 */
export function findModelEntry(id, options = {}) {
	const parsed = parseModelRef(id)
	const provider = validProvider(options.provider) ?? validProvider(parsed.provider)
	return allModelEntries(options.providers).find((m) => modelEntryMatches(m, parsed.id, provider))
}

/**
 * @param {string} id
 * @param {{ provider?: string, providers?: Record<string, import("./settings.js").ProviderSettings> }} [options]
 */
export function canonicalModelRef(id, options = {}) {
	const entry = findModelEntry(id, { providers: options.providers })
	if (entry) return modelRef(entry)
	const parsed = parseModelRef(id)
	if (parsed.provider) return id
	return `${options.provider ?? "llamacpp"}/${parsed.id}`
}

/**
 * @param {import("./settings.js").Settings | undefined} [settings]
 * @returns {Promise<ModelEntry[]>}
 */
export async function availableModelEntries(settings = undefined) {
	const entries = allModelEntries(settings?.providers)
	const providers = Array.from(new Set(entries.map((m) => m.authProvider)))
	const available = new Set(
		/** @type {ModelProvider[]} */ ((await Promise.all(providers.map(async (p) => {
			const configuredKey = settings?.providers?.[p]?.apiKey
			const apiKey = (typeof configuredKey === "string" && configuredKey) || await resolveApiKey(p)
			return apiKey ? p : undefined
		}))).filter(Boolean)),
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
		headers: entry.headers,
		cost: entry.cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat,
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
	delete next.compaction
	return next
}

/**
 * Resolve a model from the curated registry plus declarative settings providers.
 * Unknown ids fall back to the selected provider's first registry template.
 *
 * @param {string} id
 * @param {{ provider?: ModelProvider, providers?: Record<string, import("./settings.js").ProviderSettings> }} [options]
 */
export function resolveModel(id, options = {}) {
	const entry = findModelEntry(id, { provider: options.provider, providers: options.providers })
	if (entry) return buildModel(entry)
	const parsed = parseModelRef(id)
	const provider = validProvider(options.provider) ?? validProvider(parsed.provider) ?? "llamacpp"
	return buildModel(defaultTemplateForProvider(provider), { id: parsed.id })
}
