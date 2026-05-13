// RPC mode: headless operation with a JSON-line stdin/stdout protocol.
//
// Ported from pi-mono `coding-agent/src/modes/rpc/rpc-mode.ts`. Pinano lacks
// pi's AgentSession + extensions surface, so the dispatcher talks directly to
// `Agent` plus session-store helpers. Commands pinano can't fulfil yet (bash,
// extension UI, get_commands, …) are listed in rpc-types.ts as comments so a
// future port can just uncomment.
//
// I/O is parameterized — tests pass PassThrough streams instead of stdio.

import * as readline from "node:readline"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"

import type { Agent } from "../agent-core/agent.js"
import type { Session } from "../session-manager/index.js"

import { compact } from "./compaction.ts"
import { cycleModelId, cycleThinkingLevel } from "./cycle.ts"
import { MODEL_REGISTRY, buildModel, resolveModel } from "./models.ts"
import { sessionsDir } from "./paths.ts"
import {
	createSession,
	openSession,
	setSessionName as persistSessionName,
	touchSession,
} from "./session-store.ts"
import { loadSettings } from "./settings.ts"
import { ensureProjectContextMessage } from "./project-context.ts"
import type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc-types.ts"

export interface RpcModeOptions {
	agent: Agent
	session: Session
	sessionId: string
	sessionFile: string
	cwd: string
	/** Forwarded from --baseurl so /set_model preserves the override. */
	baseUrlOverride?: string
	/** Default to process.stdin/stdout. Tests inject PassThrough streams. */
	input?: Readable
	output?: Writable
	/** Test-only — resolves when the readline loop ends (real run never resolves). */
	exitOnInputEnd?: boolean
}

interface MutableState {
	session: Session
	sessionId: string
	sessionFile: string
}

export async function runRpcMode(opts: RpcModeOptions): Promise<void> {
	const { agent, cwd, baseUrlOverride } = opts
	const input = opts.input ?? process.stdin
	const output = opts.output ?? process.stdout

	const state: MutableState = {
		session: opts.session,
		sessionId: opts.sessionId,
		sessionFile: opts.sessionFile,
	}

	const write = (obj: unknown) => {
		output.write(`${JSON.stringify(obj)}\n`)
	}

	const success = (id: string | undefined, command: RpcCommand["type"], data?: unknown): RpcResponse => {
		if (data === undefined) return { id, type: "response", command, success: true } as RpcResponse
		return { id, type: "response", command, success: true, data } as RpcResponse
	}

	const error = (id: string | undefined, command: string, message: string): RpcResponse => ({
		id,
		type: "response",
		command,
		success: false,
		error: message,
	})

	// ─── Event fan-out ──────────────────────────────────────────────────────
	// Mirror chat-mode's persistence: append every message_end to the current
	// session file, and bump the index entry on agent_end.
	agent.subscribe(async (event) => {
		write(event)
		if (event.type === "message_end") {
			try {
				await state.session.appendMessage(event.message as any)
			} catch (err: any) {
				write({ type: "error", scope: "session_persist", error: err?.message ?? String(err) })
			}
		}
		if (event.type === "agent_end") {
			touchSession(state.sessionId).catch(() => {})
		}
	})

	// Mirror existing transcript into the agent so a `--mode rpc -r` resume
	// works the same way it does in chat-mode.
	{
		const existing = state.session.getMessages()
		if (existing.length > 0) agent.state.messages = existing as any
	}

	// ─── Helpers ────────────────────────────────────────────────────────────
	const buildState = async (): Promise<RpcSessionState> => ({
		model: agent.state.model as any,
		thinkingLevel: agent.state.thinkingLevel as any,
		isStreaming: agent.state.isStreaming,
		isCompacting: false, // pinano has no separate "compacting" flag; transformContext blocks the turn
		steeringMode: agent.steeringMode as any,
		followUpMode: agent.followUpMode as any,
		sessionFile: state.sessionFile,
		sessionId: state.sessionId,
		sessionName: state.session.getSessionName(),
		autoCompactionEnabled: true, // pinano: always on via transformContext
		messageCount: agent.state.messages.length,
		pendingMessageCount: 0, // pinano's queues don't expose a count yet
	})

	const swapSession = (next: Session, id: string, sessionFile: string) => {
		state.session = next
		state.sessionId = id
		state.sessionFile = sessionFile
		const messages = next.getMessages()
		agent.state.messages = messages as any
	}

	const userMessageText = (m: any): string => {
		if (typeof m.content === "string") return m.content
		return (m.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join(" ")
	}

	// ─── Command dispatch ──────────────────────────────────────────────────
	const handle = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id

		switch (command.type) {
			case "prompt": {
				if (agent.state.isStreaming && command.streamingBehavior === "steer") {
					agent.steer({
						role: "user",
						content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
						timestamp: Date.now(),
					} as any)
					return success(id, "prompt")
				}
				if (agent.state.isStreaming && command.streamingBehavior === "followUp") {
					agent.followUp({
						role: "user",
						content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
						timestamp: Date.now(),
					} as any)
					return success(id, "prompt")
				}
				if (agent.state.isStreaming) {
					return error(id, "prompt", "Agent is streaming. Use streamingBehavior:'steer'|'followUp'.")
				}
				// Don't await — events stream via subscribe.
				agent
					.prompt(command.message, command.images as any)
					.catch((e: any) => write(error(id, "prompt", e?.message ?? String(e))))
				return success(id, "prompt")
			}

			case "steer": {
				agent.steer({
					role: "user",
					content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
					timestamp: Date.now(),
				} as any)
				return success(id, "steer")
			}

			case "follow_up": {
				agent.followUp({
					role: "user",
					content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
					timestamp: Date.now(),
				} as any)
				return success(id, "follow_up")
			}

			case "abort": {
				agent.abort()
				await agent.waitForIdle()
				return success(id, "abort")
			}

			case "new_session": {
				if (agent.state.isStreaming) {
					agent.abort()
					await agent.waitForIdle()
				}
				const created = await createSession(cwd)
				await ensureProjectContextMessage(created.session, cwd)
				swapSession(created.session, created.id, join(sessionsDir(), `${created.id}.jsonl`))
				return success(id, "new_session", { cancelled: false, sessionId: created.id })
			}

			case "get_state": {
				return success(id, "get_state", await buildState())
			}

			case "set_model": {
				const entry = MODEL_REGISTRY.find((m) => m.provider === command.provider && m.id === command.modelId)
				if (!entry) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`)
				}
				agent.state.model = buildModel(entry, { baseUrl: baseUrlOverride }) as any
				return success(id, "set_model", agent.state.model)
			}

			case "cycle_model": {
				const settings = await loadSettings()
				const cycled = cycleModelId(agent.state.model.id, settings.scopedModelIds)
				if (!cycled) return success(id, "cycle_model", null)
				agent.state.model = resolveModel(cycled.id, { baseUrl: baseUrlOverride }) as any
				return success(id, "cycle_model", {
					model: agent.state.model,
					thinkingLevel: agent.state.thinkingLevel,
					isScoped: cycled.isScoped,
				})
			}

			case "get_available_models": {
				const models = MODEL_REGISTRY.map((entry) => buildModel(entry, { baseUrl: baseUrlOverride }))
				return success(id, "get_available_models", { models })
			}

			case "set_thinking_level": {
				agent.state.thinkingLevel = command.level as any
				return success(id, "set_thinking_level")
			}

			case "cycle_thinking_level": {
				const next = cycleThinkingLevel(agent.state.thinkingLevel as any)
				agent.state.thinkingLevel = next as any
				return success(id, "cycle_thinking_level", { level: next })
			}

			case "set_steering_mode": {
				agent.steeringMode = command.mode
				return success(id, "set_steering_mode")
			}

			case "set_follow_up_mode": {
				agent.followUpMode = command.mode
				return success(id, "set_follow_up_mode")
			}

			case "compact": {
				// pinano's compact() doesn't yet honour customInstructions. The
				// parallel pinano-features branch is rewiring summarize() to take
				// a custom prompt — once merged we can pass it through here.
				void command.customInstructions
				const result = await compact(agent)
				return success(id, "compact", result)
			}

			case "get_session_stats": {
				const messages = agent.state.messages as any[]
				const last = [...messages].reverse().find((m) => m.role === "assistant" && m.usage?.totalTokens)
				const tokensUsed = last?.usage?.totalTokens ?? 0
				const contextWindow = agent.state.model.contextWindow ?? 0
				return success(id, "get_session_stats", {
					messageCount: messages.length,
					tokensUsed,
					contextWindow,
					usageRatio: contextWindow > 0 ? tokensUsed / contextWindow : 0,
				})
			}

			case "switch_session": {
				const sessionId = pathToSessionId(command.sessionPath)
				if (!sessionId) {
					return error(id, "switch_session", `Could not derive session id from ${command.sessionPath}`)
				}
				if (agent.state.isStreaming) {
					agent.abort()
					await agent.waitForIdle()
				}
				try {
					const opened = await openSession(sessionId)
					await ensureProjectContextMessage(opened.session, cwd)
					swapSession(opened.session, opened.id, command.sessionPath)
					return success(id, "switch_session", { cancelled: false })
				} catch (e: any) {
					return error(id, "switch_session", e?.message ?? String(e))
				}
			}

			case "fork": {
				const target = state.session.getEntry(command.entryId)
				if (!target) return error(id, "fork", `Entry not found: ${command.entryId}`)
				state.session.moveTo(command.entryId)
				const branch = state.session.getBranch()
				agent.state.messages = branch
					.filter((e: any) => e.type === "message")
					.map((e: any) => e.message) as any
				const text = target.type === "message" ? userMessageText(target.message) : ""
				return success(id, "fork", { text, cancelled: false })
			}

			case "get_fork_messages": {
				const entries = state.session.getEntries() as any[]
				const userEntries = entries.filter((e) => e.type === "message" && e.message?.role === "user")
				return success(id, "get_fork_messages", {
					messages: userEntries.map((e) => ({ entryId: e.id, text: userMessageText(e.message) })),
				})
			}

			case "get_last_assistant_text": {
				const messages = agent.state.messages as any[]
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i]
					if (m.role !== "assistant") continue
					const text = (m.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("")
					return success(id, "get_last_assistant_text", { text: text || null })
				}
				return success(id, "get_last_assistant_text", { text: null })
			}

			case "set_session_name": {
				const name = command.name.trim()
				if (!name) return error(id, "set_session_name", "Session name cannot be empty")
				await state.session.appendSessionName(name)
				await persistSessionName(state.sessionId, name)
				return success(id, "set_session_name")
			}

			case "get_messages": {
				return success(id, "get_messages", { messages: agent.state.messages.slice() })
			}

			default: {
				const u = command as { type: string }
				return error(undefined, u.type, `Unknown command: ${u.type}`)
			}
		}
	}

	// ─── Readline loop ──────────────────────────────────────────────────────
	const rl = readline.createInterface({ input, output, terminal: false })

	const inputClosed = new Promise<void>((resolve) => rl.once("close", resolve))

	rl.on("line", async (line: string) => {
		const trimmed = line.trim()
		if (!trimmed) return
		let parsed: RpcCommand
		try {
			parsed = JSON.parse(trimmed) as RpcCommand
		} catch (e: any) {
			write(error(undefined, "parse", `Failed to parse command: ${e?.message ?? e}`))
			return
		}
		try {
			const response = await handle(parsed)
			write(response)
		} catch (e: any) {
			write(error(parsed.id, parsed.type ?? "unknown", e?.message ?? String(e)))
		}
	})

	if (opts.exitOnInputEnd) {
		await inputClosed
		await agent.waitForIdle()
		return
	}

	// Real CLI usage: when the controlling stdin closes (parent process gone,
	// EOF on a pipe), drain any in-flight work and exit cleanly. Without this
	// the active subscriber + listeners can keep the loop alive indefinitely.
	await inputClosed
	await agent.waitForIdle()
	process.exit(0)
}

/** Pi's RPC takes session paths; pinano stores by id. Extract id from filename. */
function pathToSessionId(p: string): string | null {
	const m = p.match(/([0-9a-f-]{36})\.jsonl$/i)
	if (m) return m[1] ?? null
	// Allow callers to pass a bare id too.
	if (/^[0-9a-f-]{36}$/i.test(p)) return p
	return null
}
