// Branching commands: /fork (branch off a previous user message),
// /clone (duplicate the current session at the current point),
// /tree (visualize the session tree and switch to a leaf).

import { randomUUID } from "node:crypto"
import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { SlashCommand } from "../slash-commands.ts"
import { theme } from "../theme.ts"
import { pickFromOverlay } from "../components/picker.ts"
import { pickRewindMessage } from "../components/user-message-selector.ts"
import { pickInline } from "../components/inline-picker.ts"
import { sessionsDir } from "../paths.ts"
import { JsonlSessionStorage } from "../../session-manager/index.js"
import { summarizeMessages } from "../compaction.ts"
import { isProjectContextMessage } from "../project-context.ts"

/** Build a `branch summary`-style label like "user: refactor session manager...". */
function entrySummary(entry: any): string {
	if (entry.type !== "message") return entry.type
	const m = entry.message
	if (m.role === "user") {
		const text = typeof m.content === "string"
			? m.content
			: (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
		return `user: ${text.slice(0, 80)}`
	}
	if (m.role === "assistant") {
		const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
		return `assistant: ${text.slice(0, 80) || "(tool call)"}`
	}
	if (m.role === "toolResult") return `tool: ${m.toolName}`
	return m.role
}

/** Pull the plain-text portion of a user message back into the editor on rewind. */
function userMessageText(entry: any): string {
	const c = entry?.message?.content
	if (typeof c === "string") return c
	if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
	return ""
}

export const forkCommand: SlashCommand = {
	name: "fork",
	description: "rewind to a previous user message (with optional branch summary)",
	handler: async (ctx) => {
		const entries = ctx.session.getEntries() as any[]
		// The synthetic project-context user message looks like a normal user
		// turn but isn't one — exclude it from the rewind picker.
		const userEntries = entries.filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "user" &&
				!isProjectContextMessage(e.message),
		)
		if (userEntries.length === 0) {
			ctx.appendLine(theme.dim("no user messages to fork from"))
			return
		}

		// Show the tree-style picker. The tree's parent edges ignore non-user
		// entries: a user message's "tree parent" is its nearest user-message
		// ancestor in the entry graph (so two user messages separated only by
		// assistant turns and tool calls still render as parent/child).
		// Branches that were rewound away appear as siblings.
		const userIds = new Set(userEntries.map((e) => e.id))
		const entryById = new Map<string, any>(entries.map((e) => [e.id, e]))
		const userParentOf = (id: string): string | null => {
			let cur = entryById.get(id)?.parentId ?? null
			while (cur !== null) {
				if (userIds.has(cur)) return cur
				cur = entryById.get(cur)?.parentId ?? null
			}
			return null
		}

		// Active path: walk from current leaf to root, collect user-message ids.
		const activePath = new Set<string>()
		{
			let cur: string | null = ctx.session.getLeafId()
			while (cur) {
				if (userIds.has(cur)) activePath.add(cur)
				cur = entryById.get(cur)?.parentId ?? null
			}
		}

		const treeEntries = userEntries.map((e) => ({
			id: e.id,
			parentId: userParentOf(e.id),
			text: userMessageText(e) || entrySummary(e),
			onActivePath: activePath.has(e.id),
		}))
		// Default cursor: most recent active-path user message (typically what
		// you want to rewind near).
		const initialSelectedId = (() => {
			for (let i = treeEntries.length - 1; i >= 0; i--) {
				if (treeEntries[i].onActivePath) return treeEntries[i].id
			}
			return undefined
		})()
		const chosenId = await pickRewindMessage(ctx, treeEntries, {
			initialSelectedId,
		})
		if (!chosenId) return

		// Second prompt — let the user choose between a clean rewind (no model
		// call, instant) and a rewind that summarizes the discarded tail.
		// Same in-place swap so the flow stays in one place.
		const mode = await pickInline(
			ctx,
			[
				{ value: "rewind", label: "Rewind", description: "drop everything after this point — no model call" },
				{ value: "summary", label: "Rewind with branch summary", description: "summarize the discarded branch first" },
			],
			{ title: "How should the rewind discard the branch?" },
		)
		if (!mode) return

		const chosenEntry = userEntries.find((e) => e.id === chosenId)
		const chosenText = userMessageText(chosenEntry)

		// pi-style rewind: leaf moves to the *parent* of the picked user
		// message and the message text drops back into the editor, so the
		// next submit is a fresh attempt rather than a sibling of the old
		// reply. parentId is null for the very first user message.
		const newLeafId: string | null = chosenEntry?.parentId ?? null

		// Discarded tail (for summarization) = everything from the chosen user
		// message to the old leaf, inclusive — since the chosen message is no
		// longer on the active branch.
		const oldBranch = ctx.session.getBranch()
		const idx = oldBranch.findIndex((e: any) => e.id === chosenId)
		const discardedTail = idx >= 0 ? oldBranch.slice(idx) : []
		const discardedMessages = discardedTail
			.filter((e: any) => e.type === "message")
			.map((e: any) => e.message)

		ctx.session.moveTo(newLeafId)

		// One-shot LLM summary of the discarded branch. Appended as a
		// synthetic user-role message at the new leaf so the user (and the
		// next prompt) can see what was discarded. user-role + explicit
		// "[branch summary]" preamble keeps the model from rationalizing the
		// content as something it itself wrote. Best-effort: if summarization
		// fails we still complete the rewind.
		if (mode === "summary" && discardedMessages.length > 0) {
			ctx.appendLine(theme.dim(`summarizing ${discardedMessages.length} discarded message(s)…`))
			try {
				const summary = await summarizeMessages(ctx.agent, discardedMessages, {
					systemPrompt:
						"You are summarizing a conversation branch that the user has just discarded by rewinding earlier in the session. Capture the user's goals, what was attempted, what worked, and what didn't — so the next attempt can avoid repeating mistakes. Reply with the summary text only.",
					userPreamble: "Summarize this discarded conversation branch:",
				})
				const summaryMsg: any = {
					role: "user",
					content: [
						{
							type: "text",
							text: `[branch summary — earlier branch from this point was discarded by /fork]\n${summary}`,
						},
					],
					timestamp: Date.now(),
					branchSummary: true,
				}
				await ctx.session.appendMessage(summaryMsg)
			} catch (err: any) {
				ctx.appendLine(theme.yellow(`(branch summary failed: ${err?.message ?? err})`))
			}
		}

		// Replay the new branch into the transcript so the user sees what
		// context survived the rewind (the messages still in agent state)
		// rather than an empty transcript with just a status line.
		// `replaySession` clears, re-renders all branch messages via the
		// component path, and resets `agent.state.messages` from the session.
		ctx.replaySession()
		if (chosenText) ctx.setEditorText(chosenText)
		const where = chosenId.slice(0, 8)
		const tag = mode === "summary" ? "rewound (with summary)" : "rewound"
		ctx.appendLine(theme.dim(`${tag} to before ${where} — ${ctx.agent.state.messages.length} messages active`))
	},
}

export const cloneCommand: SlashCommand = {
	name: "clone",
	description: "duplicate the current session as a new session at the current point",
	handler: async (ctx) => {
		if (!ctx.switchSession) {
			ctx.appendLine(theme.red("session switching is not wired up"))
			return
		}
		const meta = ctx.session.getMetadata()
		const newId = randomUUID()
		const srcPath = join(sessionsDir(), `${ctx.sessionId}.jsonl`)
		const dstPath = join(sessionsDir(), `${newId}.jsonl`)
		await mkdir(dirname(dstPath), { recursive: true })
		await copyFile(srcPath, dstPath)
		ctx.appendLine(theme.dim(`cloned to ${newId.slice(0, 8)} (cwd ${meta.cwd})`))
		await ctx.switchSession(newId)
	},
}

export const treeCommand: SlashCommand = {
	name: "tree",
	description: "show the session tree and switch to a leaf",
	handler: async (ctx) => {
		const entries = ctx.session.getEntries() as any[]
		// Collect all leaves: entries with no children pointing at them.
		const childrenOf = new Map<string | null, string[]>()
		for (const e of entries) {
			const arr = childrenOf.get(e.parentId ?? null) ?? []
			arr.push(e.id)
			childrenOf.set(e.parentId ?? null, arr)
		}
		const leaves = entries.filter((e) => !childrenOf.get(e.id))
		if (leaves.length <= 1) {
			ctx.appendLine(theme.dim("only one branch — nothing to switch to"))
			return
		}
		const items = leaves.map((e) => ({
			value: e.id,
			label: e.id.slice(0, 8) + (e.id === ctx.session.getLeafId() ? " *" : ""),
			description: entrySummary(e),
		}))
		const chosen = await pickFromOverlay(ctx.tui, items)
		if (!chosen || chosen === ctx.session.getLeafId()) return
		ctx.session.moveTo(chosen)
		const branch = ctx.session.getBranch()
		ctx.agent.state.messages = branch
			.filter((e: any) => e.type === "message")
			.map((e: any) => e.message)
		ctx.clearTranscript()
		ctx.appendLine(theme.dim(`switched leaf → ${chosen.slice(0, 8)}`))
	},
}

export function registerBranchingCommands(registry: { register: (cmd: SlashCommand) => void }) {
	for (const c of [forkCommand, cloneCommand, treeCommand]) registry.register(c)
}
