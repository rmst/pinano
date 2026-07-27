// Bottom status bar — model | thinking | cost | context %.
//
// Renders as a segmented text component. Calling `update()` recomputes the line
// and asks the TUI to repaint.

import { SegmentedText } from "../../tui/index.js"
import { summarizeContext, summarizeMessageBilling } from "../../../../server/src/app/context/summary.js"
import { reasoningLevelLabel } from "../../../../protocol/src/reasoning.js"
import { findModelEntry } from "../../../../server/src/app/model/registry.js"
import { modelDisplayLabel } from "../../../../server/src/app/model/display.js"
import { buildModelMessagesForSession, contextFilesDisabledForAgent } from "../../../../server/src/app/session/context.js"
import { theme } from "../theme.js"

/** @typedef {import("../../../../server/src/agent-core/agent.js").Agent} Agent */
/** @typedef {{ onContextClick?: () => void, onReasoningClick?: () => void }} FooterOptions */

export { modelDisplayLabel }

export class Footer {
	/** @type {SegmentedText} */
	component
	/** @type {Agent} */
	agent
	// Sync predicate: true when the active model's provider currently has an
	// OAuth-style credential on disk (e.g. Codex). Cached upstream and refreshed
	// after credentials changes and /reload — so this stays a cheap synchronous lookup.
	/** @type {(provider: string) => boolean} */
	isUsingSubscription
	/** @type {() => void} */
	onContextClick
	/** @type {() => void} */
	onReasoningClick
	/**
	 * @param {Agent} agent
	 * @param {(provider: string) => boolean} [isUsingSubscription]
	 * @param {FooterOptions} [options]
	 */
	constructor(agent, isUsingSubscription = () => false, options = {}) {
		this.agent = agent
		this.isUsingSubscription = isUsingSubscription
		this.onContextClick = options.onContextClick ?? (() => {})
		this.onReasoningClick = options.onReasoningClick ?? (() => {})
		this.component = new SegmentedText([], { paddingX: 0, paddingY: 0 })
		this.update()
	}

	update() {
		const m = this.agent.state.model
		const entry = findModelEntry(m.id, { provider: m.provider })
		const modelLabel = modelDisplayLabel(m, entry)
		const thinking = reasoningLevelLabel(this.agent.state.thinkingLevel)

		// Cost is summed across turns (each turn is billed independently). Context fill comes from the shared context-summary path: latest provider/synthetic baseline plus estimated unreported delta, with the full local estimate as fallback.
		// Snapshot-backed clients receive precomputed context stats so normal UI refreshes do not need the full model-context message array.
		const contextStats = this.agent.state.contextStats
		const billing = summarizeMessageBilling(/** @type {any[]} */ (this.agent.state.messages))
		const cost = Number.isFinite(contextStats?.costTotal) ? contextStats.costTotal : billing.costTotal
		let used = Number.isFinite(contextStats?.usedTokens) ? contextStats.usedTokens : undefined
		if (used === undefined) {
			const messages = this.agent.session && !contextFilesDisabledForAgent(this.agent)
				? buildModelMessagesForSession(this.agent.session, this.agent.state.messages)
				: this.agent.state.messages
			used = summarizeContext({
				messages,
				systemPrompt: this.agent.state.systemPrompt,
				tools: this.agent.state.tools,
			}).usedTokens
		}

		const ctxWindow = m.contextWindow ?? 0
		const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((used / ctxWindow) * 100)) : 0
		const ctxUsedStr = ctxWindow > 0 ? `${ctxPct}%` : "—"

		const onSubscription = m.provider === "openai-codex" || this.isUsingSubscription(m.provider)
		const isLocal = m.provider === "llamacpp"
		const billingSegment = onSubscription || isLocal ? "" : `$${cost.toFixed(2)}`

		const segments = intersperseSegments([
			{ text: modelLabel, style: theme.cyan },
			{
				text: `reasoning:${thinking}`,
				style: theme.dim,
				id: "footer.reasoning",
				role: "button",
				label: "Reasoning",
				metadata: { action: "reasoning" },
				onClick: () => this.onReasoningClick(),
			},
			...(billingSegment ? [{ text: billingSegment, style: theme.dim }] : []),
			{
				text: `context:${ctxUsedStr}`,
				style: theme.dim,
				id: "footer.context",
				role: "button",
				label: "Context",
				metadata: { action: "context" },
				onClick: () => this.onContextClick(),
			},
		], { text: " │ ", style: theme.dim })
		this.component.setSegments(segments)
	}
}

/**
 * @param {import("../../tui/components/segmented-text.js").TextSegment[]} segments
 * @param {import("../../tui/components/segmented-text.js").TextSegment} separator
 * @returns {import("../../tui/components/segmented-text.js").TextSegment[]}
 */
function intersperseSegments(segments, separator) {
	return segments.flatMap((segment, index) => [
		...(index === 0 ? [] : [separator]),
		segment,
	])
}
