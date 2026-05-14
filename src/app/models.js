// Curated model registry. Cost / context / capability numbers come from
// pi-mono's `packages/ai/src/models.generated.ts` (commit 3d5cbe98) and are
// kept in sync manually for the providers we actually care about:
//
//   - OpenAI cloud (API key)        — gpt-5.5 / gpt-5.4 / gpt-5.3+
//   - Codex (ChatGPT subscription)  — gpt-5.x via OAuth
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
 * @property {Record<string, unknown>} [compat]
 * @property {"chat" | "responses"} [transport]
 * @property {string[]} [tags]
 */

const OPENAI_BASE = "https://api.openai.com/v1"
const CODEX_BASE = "https://chatgpt.com/backend-api"
const MOONSHOT_BASE = "https://api.moonshot.ai/v1"
const DEEPSEEK_BASE = "https://api.deepseek.com"

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

/** @type {ModelEntry[]} */
export const MODEL_REGISTRY = [
	// ─── OpenAI cloud (API key) ──────────────────────────────────────────────
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: true,
		transport: "responses",
		contextWindow: 272_000,
		maxTokens: 128_000,
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
		contextWindow: 272_000,
		maxTokens: 128_000,
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
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
	},
	{
		id: "gpt-5.3-chat-latest",
		displayName: "GPT-5.3 chat-latest",
		provider: "openai",
		authProvider: "openai",
		baseUrl: OPENAI_BASE,
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	},
	// ─── Codex (ChatGPT subscription, OAuth) ────────────────────────────────
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5 (Codex)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.5-codex"],
		reasoning: true,
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	{
		id: "gpt-5.4",
		displayName: "GPT-5.4 (Codex)",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.4-codex"],
		reasoning: true,
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tags: ["subscription"],
	},
	{
		id: "gpt-5.3",
		displayName: "GPT-5.3 Codex",
		provider: "openai-codex",
		authProvider: "openai-codex",
		baseUrl: CODEX_BASE,
		legacyIds: ["gpt-5.3-codex"],
		reasoning: true,
		contextWindow: 272_000,
		maxTokens: 128_000,
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
	const expectedProvider = provider ?? parsed.provider
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

/**
 * @param {string} id
 * @param {{ provider?: ModelProvider }} [options]
 * @returns {ModelEntry | undefined}
 */
export function findModelEntry(id, options = {}) {
	const parsed = parseModelRef(id)
	const provider = options.provider ?? parsed.provider
	return MODEL_REGISTRY.find((m) => modelEntryMatches(m, parsed.id, provider))
}

/**
 * @returns {Promise<ModelEntry[]>}
 */
export async function availableModelEntries() {
	const providers = Array.from(new Set(MODEL_REGISTRY.map((m) => m.authProvider)))
	const available = new Set(
		/** @type {ModelProvider[]} */ ((await Promise.all(providers.map(async (p) => ((await resolveApiKey(p)) ? p : undefined)))).filter(Boolean)),
	)
	return MODEL_REGISTRY
		.filter((m) => available.has(m.authProvider))
		.sort((a, b) => {
			if (a.authProvider === "openai-codex" && b.authProvider !== "openai-codex") return -1
			if (a.authProvider !== "openai-codex" && b.authProvider === "openai-codex") return 1
			return 0
		})
}

/**
 * Build the Model struct that ai-apis consumes from a registry entry plus
 * runtime overrides (e.g. `--baseurl` or a custom local model id).
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
		input: ["text"],
		cost: entry.cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat,
	}
}

/**
 * Resolve a model from id + optional overrides. Unknown ids fall back to the
 * local-llamacpp template — useful for local models like `qwen2.5-coder`.
 *
 * @param {string} id
 * @param {{ baseUrl?: string }} [overrides]
 */
export function resolveModel(id, overrides = {}) {
	const entry = findModelEntry(id)
	if (entry) return buildModel(entry, { baseUrl: overrides.baseUrl })
	return buildModel(/** @type {ModelEntry} */ (findModelEntry("local")), { id, baseUrl: overrides.baseUrl })
}
