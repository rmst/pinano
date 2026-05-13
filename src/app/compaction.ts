// Conversation compaction.
//
// When the cumulative context approaches the model's contextWindow, we
// replace the oldest N messages with a single "compaction summary" assistant
// message. The summary is produced by asking the same model to summarize the
// discarded prefix.
//
// Strategy:
//   - threshold:   compact when usage > settings.autocompactThreshold * contextWindow
//   - cut point:   keep the last K turns intact; summarize everything before
//   - replacement: a single assistant message with role="assistant" and a
//                  custom marker (`compaction: true`) so it round-trips through
//                  the agent context but is rendered specially.

import type { Agent } from "../agent-core/agent.js"
import { stream as openaiStream } from "../ai-apis/index.js"
import { resolveApiKey } from "./auth.ts"

export interface CompactionResult {
	summary: string
	keptCount: number
	removedCount: number
	tokensBefore: number
}

/** Approximate token count: 1 token ≈ 4 chars (good enough for budget gates). */
export function estimateTokens(messages: any[]): number {
	let total = 0
	for (const m of messages) {
		if (typeof m.content === "string") {
			total += Math.ceil(m.content.length / 4)
		} else if (Array.isArray(m.content)) {
			for (const c of m.content) {
				if (c.type === "text") total += Math.ceil(c.text.length / 4)
				if (c.type === "thinking") total += Math.ceil(c.thinking.length / 4)
				if (c.type === "toolCall") total += Math.ceil(JSON.stringify(c.arguments ?? {}).length / 4) + 8
			}
		}
		total += 8 // per-message overhead
	}
	return total
}

/** Last reported usage from any prior assistant message, or 0. */
export function lastReportedTokens(messages: any[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.role === "assistant" && m.usage?.totalTokens) return m.usage.totalTokens
	}
	return 0
}

/** Decide whether the agent should compact before its next turn. */
export function shouldCompact(agent: Agent, threshold: number): boolean {
	const ctx = agent.state.model.contextWindow ?? 0
	if (!ctx) return false
	const reported = lastReportedTokens(agent.state.messages as any)
	const estimated = estimateTokens(agent.state.messages as any)
	// `reported` is the prompt size from the last assistant turn — stale by any
	// toolResult or user message appended since. Take the max so a large tool
	// result still triggers compaction before the next call.
	const used = Math.max(reported, estimated)
	return used >= threshold * ctx
}

const SUMMARY_PROMPT = `You are summarizing the older portion of a coding conversation so we can fit more context.
Write a concise but specific summary capturing:
  - the user's overall goals / tasks
  - any decisions or constraints that were established
  - file paths, function names, or other identifiers that matter for follow-up
  - what's been done so far and what's still in progress

Reply with the summary text only. No greetings, no code fences.`

/** Render a list of messages as a plaintext transcript for the summarizer. */
function serializeMessages(messages: any[]): string {
	return messages
		.map((m) => {
			const role = m.role
			if (typeof m.content === "string") return `${role}: ${m.content}`
			const text = (m.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join(" ")
			if (role === "assistant" && m.content?.some?.((c: any) => c.type === "toolCall")) {
				const calls = m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name)
				return `${role}[tools: ${calls.join(", ")}]: ${text}`
			}
			if (role === "toolResult") return `tool[${m.toolName}]: ${text.slice(0, 500)}`
			return `${role}: ${text}`
		})
		.join("\n")
}

/**
 * Run a non-streaming summarization using the same model with a custom system
 * prompt. Lightweight wrapper around the OpenAI Chat Completions stream — we
 * just collect the deltas.
 */
export async function summarizeMessages(
	agent: Agent,
	messages: any[],
	options: { systemPrompt?: string; userPreamble?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const ctx = {
		systemPrompt: options.systemPrompt ?? SUMMARY_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: options.userPreamble ?? "Summarize the following conversation:" },
					{ type: "text", text: serializeMessages(messages) },
				],
			},
		],
		tools: [],
	}
	const apiKey = await resolveApiKey(agent.state.model.provider)
	const s = openaiStream(agent.state.model, ctx, { apiKey, signal: options.signal })
	let buf = ""
	for await (const event of s) {
		if (event.type === "text_delta") buf += event.delta
	}
	const final = await s.result()
	if (final.errorMessage) throw new Error(final.errorMessage)
	return buf.trim()
}

/** Backward-compat default summarizer — used by /compact. */
async function summarize(agent: Agent, prefix: any[], signal?: AbortSignal): Promise<string> {
	return summarizeMessages(agent, prefix, { signal })
}

/**
 * Compact the agent's transcript in place. Keeps the system prompt + the most
 * recent `keepLast` messages, replaces everything before with a single
 * compaction-summary assistant message.
 *
 * Returns metadata describing the compaction (used by /compact UI).
 */
export async function compact(agent: Agent, keepLast = 6, signal?: AbortSignal): Promise<CompactionResult> {
	const messages = agent.state.messages as any[]
	const tokensBefore = lastReportedTokens(messages) || estimateTokens(messages)

	if (messages.length <= keepLast) {
		return { summary: "", keptCount: messages.length, removedCount: 0, tokensBefore }
	}
	const prefix = messages.slice(0, messages.length - keepLast)
	const tail = messages.slice(messages.length - keepLast)

	const summary = await summarize(agent, prefix, signal)
	const compactionMsg = {
		role: "assistant",
		content: [{ type: "text", text: `[earlier context compacted]\n${summary}` }],
		provider: agent.state.model.provider,
		model: agent.state.model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		compaction: true,
	}

	agent.state.messages = [compactionMsg, ...tail] as any

	return {
		summary,
		keptCount: tail.length,
		removedCount: prefix.length,
		tokensBefore,
	}
}
