// Bottom status bar — model | thinking | cost | ctx %.
//
// Renders as a single Text component. Calling `update()` recomputes the line
// and asks the TUI to repaint.

import { Text } from "../../tui/index.ts"
import type { Agent } from "../../agent-core/agent.js"
import { findModelEntry } from "../models.ts"
import { theme } from "../theme.ts"

export class Footer {
	readonly component: Text
	private agent: Agent
	// Sync predicate: true when the active model's provider currently has an
	// OAuth-style credential on disk (e.g. Codex). Cached upstream and refreshed
	// after /login, /logout, /reload — so this stays a cheap synchronous lookup.
	private isUsingSubscription: (provider: string) => boolean
	private getStderrCount: () => number

	constructor(
		agent: Agent,
		isUsingSubscription: (provider: string) => boolean = () => false,
		getStderrCount: () => number = () => 0,
	) {
		this.agent = agent
		this.isUsingSubscription = isUsingSubscription
		this.getStderrCount = getStderrCount
		this.component = new Text("", 0, 0)
		this.update()
	}

	update(): void {
		const m = this.agent.state.model
		const entry = findModelEntry(m.id)
		const modelLabel = entry?.displayName ?? m.id
		const thinking = this.agent.state.thinkingLevel

		// Cost is summed across turns (each turn is billed independently).
		// Context fill uses the *last* turn's totalTokens — that's the
		// prompt+completion of the most recent call, which is what determines
		// how close we are to the model's context window.
		let cost = 0
		let lastTotal = 0
		for (const msg of this.agent.state.messages as any[]) {
			if (msg.role !== "assistant") continue
			const u = msg.usage
			if (!u) continue
			cost += u.cost?.total ?? 0
			lastTotal = u.totalTokens ?? lastTotal
		}

		const ctxWindow = m.contextWindow ?? 0
		const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((lastTotal / ctxWindow) * 100)) : 0
		const ctxStr = ctxWindow > 0 ? `${ctxPct}%` : "—"

		// Billing segment:
		//   (sub)   — OAuth subscription (e.g. Codex). No API charge — show the
		//             marker by itself, no dollar amount.
		//   (local) — local llama.cpp / OpenAI-compatible host. No remote billing.
		//   else    — metered API; show `$cost.toFixed(2)`.
		// The two free markers are mutually exclusive: llamacpp models never carry
		// a codex credential.
		const onSubscription = this.isUsingSubscription(m.provider)
		const isLocal = m.provider === "llamacpp"
		const billingSegment = onSubscription
			? "(sub)"
			: isLocal
				? "(local)"
				: `$${cost.toFixed(2)}`

		const segments = [
			theme.cyan(modelLabel),
			theme.dim(`thinking=${thinking}`),
			theme.dim(billingSegment),
			theme.dim(`ctx=${ctxStr}`),
		]
		const stderrCount = this.getStderrCount()
		if (stderrCount > 0) segments.push(theme.red(`log=${stderrCount}`))
		this.component.setText(segments.join(theme.dim(" │ ")))
	}
}
