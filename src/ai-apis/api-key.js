import { configuredProviderApiKey } from "../app/service-config.js"

const LABEL_BY_PROVIDER = {
	openai: "OpenAI",
	llamacpp: "llama.cpp / OpenAI-compatible",
	moonshot: "Moonshot",
	deepseek: "DeepSeek",
}

/**
 * @param {any} model
 * @returns {string | undefined}
 */
export function providerConfiguredApiKey(model) {
	const provider = model?.authProvider ?? model?.provider ?? "openai"
	try {
		return configuredProviderApiKey(provider)
	} catch {
		return undefined
	}
}

/**
 * @param {any} model
 * @returns {string}
 */
export function missingApiKeyMessage(model) {
	const provider = model?.authProvider ?? model?.provider ?? "openai"
	const label = LABEL_BY_PROVIDER[provider] ?? provider
	return `${label} API key is required. Run pinano open /settings/credentials, pass options.apiKey, or configure providers.${provider}.apiKey in $PINANO_HOME/config/settings.json or default-settings.json.`
}
