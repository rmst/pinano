import { MANAGED_WORKTREE_INSTRUCTIONS, SESSION_INSTRUCTIONS } from "./common.js"
import { CODEX_TOOL_PROFILE, DEFAULT_TOOL_PROFILE, defaultInstructionsForToolProfile } from "./default.js"
import { GPT_5_4_MINI_INSTRUCTIONS, GPT_5_4_MINI_INSTRUCTIONS_KEY } from "./openai/gpt-5.4-mini.js"
import { GPT_5_5_INSTRUCTIONS, GPT_5_5_INSTRUCTIONS_KEY } from "./openai/gpt-5.5.js"
import { GPT_5_6_SOL_INSTRUCTIONS, GPT_5_6_SOL_INSTRUCTIONS_KEY } from "./openai/gpt-5.6-sol.js"
import { previewInstructions } from "./previews.js"

export { MANAGED_WORKTREE_INSTRUCTIONS, SESSION_INSTRUCTIONS } from "./common.js"
export { CODEX_TOOL_PROFILE, DEFAULT_TOOL_PROFILE } from "./default.js"
export { GPT_5_4_MINI_INSTRUCTIONS, GPT_5_4_MINI_INSTRUCTIONS_KEY } from "./openai/gpt-5.4-mini.js"
export { GPT_5_5_INSTRUCTIONS, GPT_5_5_INSTRUCTIONS_KEY } from "./openai/gpt-5.5.js"
export { GPT_5_6_SOL_INSTRUCTIONS, GPT_5_6_SOL_INSTRUCTIONS_KEY } from "./openai/gpt-5.6-sol.js"
export { previewInstructions } from "./previews.js"

/**
 * @typedef {object} ModelInstructionModel
 * @property {string} [baseInstructionsKey]
 * @property {string} [baseInstructions]
 * @property {string} [toolProfile]
 */

/**
 * @typedef {object} ModelInstructionContext
 * @property {ModelInstructionModel} [model]
 * @property {string} [previewPublicUrl]
 */

/** @param {ModelInstructionModel | undefined} model */
export function modelUsesInstructionsKey(model, key) {
	const configured = model?.baseInstructionsKey
	return configured === key || configured === key.replace(/-cerex$/, "-pinano")
}

/** @param {ModelInstructionModel | undefined} model */
export function baseInstructionsForModel(model) {
	if (modelUsesInstructionsKey(model, GPT_5_6_SOL_INSTRUCTIONS_KEY)) return GPT_5_6_SOL_INSTRUCTIONS
	if (modelUsesInstructionsKey(model, GPT_5_5_INSTRUCTIONS_KEY)) return GPT_5_5_INSTRUCTIONS
	if (modelUsesInstructionsKey(model, GPT_5_4_MINI_INSTRUCTIONS_KEY)) return GPT_5_4_MINI_INSTRUCTIONS
	return typeof model?.baseInstructions === "string" && model.baseInstructions.trim().length > 0
		? model.baseInstructions.trim()
		: undefined
}

/** @param {ModelInstructionModel | undefined} model */
export function toolProfileForModel(model) {
	if (model?.toolProfile === CODEX_TOOL_PROFILE) return CODEX_TOOL_PROFILE
	return DEFAULT_TOOL_PROFILE
}

/** @param {ModelInstructionContext} [context] */
export function modelInstructionsForContext(context = {}) {
	const model = context.model
	const base = baseInstructionsForModel(model) ?? defaultInstructionsForToolProfile(toolProfileForModel(model))
	const preview = context.previewPublicUrl ? previewInstructions() : ""
	return [
		base,
		SESSION_INSTRUCTIONS,
		MANAGED_WORKTREE_INSTRUCTIONS,
		preview,
	].filter(Boolean).join("\n\n")
}
