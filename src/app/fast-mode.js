export const FAST_SERVICE_TIER = "priority"

/** @param {any} model */
export function isCodexModel(model) {
	return model?.provider === "openai-codex"
}

/** @param {any} model */
export function isFastModeEligibleModel(model) {
	return isCodexModel(model) && model?.id === "gpt-5.5"
}

/** @param {any} agent */
export function fastModeActive(agent) {
	return agent?.state?.serviceTier === FAST_SERVICE_TIER
}

/** @param {any} agent */
export function fastModeStatusLine(agent) {
	const model = agent?.state?.model
	const active = fastModeActive(agent)
	if (!isFastModeEligibleModel(model)) {
		return active
			? "Fast mode is set on this session, but the current model does not support Codex Fast mode so it will not be used."
			: "Fast mode is unavailable for the current model. Switch to GPT-5.5 (subscription) first."
	}
	return `Fast mode is ${active ? "on" : "off"} for this session.`
}

/**
 * @param {any} agent
 * @param {import("../session-manager/index.js").Session | undefined} session
 * @param {boolean} enabled
 */
export async function setSessionFastMode(agent, session, enabled) {
	if (enabled && !isFastModeEligibleModel(agent?.state?.model)) {
		throw new Error("Fast mode is only available for GPT-5.5 (subscription).")
	}
	agent.state.serviceTier = enabled ? FAST_SERVICE_TIER : undefined
	await session?.appendConfigPatch?.({
		version: 1,
		serviceTier: enabled ? FAST_SERVICE_TIER : null,
	})
}

/**
 * @param {any} agent
 * @param {import("../session-manager/index.js").Session | undefined} session
 * @param {string} args
 */
export async function handleFastCommand(agent, session, args) {
	const subcommand = args.trim().toLowerCase()
	if (subcommand === "status") return fastModeStatusLine(agent)
	if (subcommand === "on") {
		await setSessionFastMode(agent, session, true)
		return "Fast mode on for this session."
	}
	if (subcommand === "off") {
		await setSessionFastMode(agent, session, false)
		return "Fast mode off for this session."
	}
	return "usage: /fast on | /fast off | /fast status"
}
