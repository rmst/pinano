// Bottom status bar — model | thinking | cost | context %.
//
// Renders as a single Text component. Calling `update()` recomputes the line
// and asks the TUI to repaint.

import { Text } from "../../tui/index.js"
import { breakdownContext } from "../context-accounting.js"
import { summarizeMessageBilling } from "../context-summary.js"
import { reasoningLevelLabel } from "../../reasoning.js"
import { findModelEntry } from "../models.js"
import { buildModelMessagesForSession, contextFilesDisabledForAgent } from "../session-context.js"
import { theme } from "../theme.js"

/** @typedef {import("../../agent-core/agent.js").Agent} Agent */

/**
 * @param {{ id?: string, provider?: string }} model
 * @param {{ displayName?: string, provider?: string }} [entry]
 */
export function modelDisplayLabel(model, entry = undefined) {
	const label = entry?.displayName ?? model?.id ?? ""
	const provider = entry?.provider ?? model?.provider
	if (provider !== "openai-codex") return label
	if (/\(subscription\)$/i.test(label)) return label
	if (/\(Codex\)$/i.test(label)) return label.replace(/\s*\(Codex\)$/i, " (subscription)")
	return label ? `${label} (subscription)` : label
}

export class Footer {
	/** @type {Text} */
	component
	/** @type {Agent} */
	agent
	// Sync predicate: true when the active model's provider currently has an
	// OAuth-style credential on disk (e.g. Codex). Cached upstream and refreshed
	// after credentials changes and /reload — so this stays a cheap synchronous lookup.
	/** @type {(provider: string) => boolean} */
	isUsingSubscription
	/** @type {() => number} */
	getStderrCount

	/**
	 * @param {Agent} agent
	 * @param {(provider: string) => boolean} [isUsingSubscription]
	 * @param {() => number} [getStderrCount]
	 */
	constructor(agent, isUsingSubscription = () => false, getStderrCount = () => 0) {
		this.agent = agent
		this.isUsingSubscription = isUsingSubscription
		this.getStderrCount = getStderrCount
		this.component = new Text("", 0, 0)
		this.update()
	}

	update() {
		const m = this.agent.state.model
		const entry = findModelEntry(m.id, { provider: m.provider })
		const modelLabel = modelDisplayLabel(m, entry)
		const thinking = reasoningLevelLabel(this.agent.state.thinkingLevel)

		// Cost is summed across turns (each turn is billed independently).
		// Context fill takes the larger of:
		//   - lastTotal:  the prompt+completion of the most recent assistant
		//                 call (real, from the provider, but stale by any tool
		//                 result or user message appended since).
		//   - estimated:  a live breakdown including system prompt, tool
		//                 definitions, and every message — so big tool
		//                 results push the bar up immediately rather than
		//                 waiting for the next assistant turn.
		// Snapshot-backed clients receive precomputed context stats so normal UI refreshes do not need the full model-context message array.
		const contextStats = this.agent.state.contextStats
		const billing = summarizeMessageBilling(/** @type {any[]} */ (this.agent.state.messages))
		const cost = Number.isFinite(contextStats?.costTotal) ? contextStats.costTotal : billing.costTotal
		let used = Number.isFinite(contextStats?.usedTokens) ? contextStats.usedTokens : undefined
		if (used === undefined) {
			const messages = this.agent.session && !contextFilesDisabledForAgent(this.agent)
				? buildModelMessagesForSession(this.agent.session, this.agent.state.messages)
				: this.agent.state.messages
			const estimated = breakdownContext({
				messages,
				systemPrompt: this.agent.state.systemPrompt,
				tools: this.agent.state.tools,
			}).total
			used = Math.max(billing.lastTotalTokens, estimated)
		}

		const ctxWindow = m.contextWindow ?? 0
		const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((used / ctxWindow) * 100)) : 0
		const ctxUsedStr = ctxWindow > 0 ? `${ctxPct}%` : "—"

		const onSubscription = m.provider === "openai-codex" || this.isUsingSubscription(m.provider)
		const isLocal = m.provider === "llamacpp"
		const billingSegment = onSubscription || isLocal ? "" : `$${cost.toFixed(2)}`

		const segments = [
			theme.cyan(modelLabel),
			theme.dim(`reasoning:${thinking}`),
			...(billingSegment ? [theme.dim(billingSegment)] : []),
			theme.dim(`context:${ctxUsedStr}`),
		]
		const stderrCount = this.getStderrCount()
		if (stderrCount > 0) segments.push(theme.red(`log=${stderrCount}`))
		this.component.setText(segments.join(theme.dim(" │ ")))
	}
}
