// Interactive chat loop. Layout (top → bottom):
//
//   ┌───────────────────────────┐
//   │ transcript (chatContainer)│   ← grows; user messages, assistant replies, tool I/O
//   ├───────────────────────────┤
//   │ Spacer                    │
//   │ keybinding hints          │
//   │ Editor (input)            │   ← bottom-anchored
//   │ Footer (status)           │
//   └───────────────────────────┘
//
// Wiring:
//   editor.onSubmit       → /command  | agent.prompt() | agent.steer()
//   ctrl+c                → agent.abort() while running, exit when idle
//   agent events          → append to chatContainer + persist into session
//   slash commands        → routed via slashCommandRegistry, see slash-commands.ts

import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Loader,
	ProcessTerminal,
	Spacer,
	TUI,
	isKeyRelease,
	matchesKey,
} from "../tui/index.ts"
import type { Component } from "../tui/index.ts"
import { Agent } from "../agent-core/agent.js"
import { Session } from "../session-manager/index.js"
import { editorTheme, theme } from "./theme.ts"
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	TextLine,
	ToolExecutionComponent,
	UserMessageComponent,
} from "./components/messages.ts"
import { dispatchSlashCommand } from "./slash-commands.ts"
import type { SlashCommandRegistry } from "./slash-commands.ts"
import { deleteSession, openSession, sessionIsEmpty, touchSession } from "./session-store.ts"
import { ensureProjectContextMessage, isProjectContextMessage, PROJECT_CONTEXT_HEADING } from "./project-context.ts"
import { LAZY_NOTICE_HEADING } from "./lazy-context.ts"
import { Footer } from "./components/footer.ts"
import { buildKeybindHints } from "./components/keybind-hints.ts"
import { parseBashShortcut, runBashShortcut, recordBashShortcut } from "./bash-shortcut.ts"
import { loadSettings } from "./settings.ts"
import { getCredential, listProviders } from "./auth.ts"
import type { StderrCapture } from "./stderr-capture.ts"

export interface ChatOptions {
	agent: Agent
	session: Session
	sessionId: string
	hello?: string
	commands?: SlashCommandRegistry
	/**
	 * Optional hook called after we've already swapped the in-process session.
	 * The app can update auxiliary state (e.g. session-store touch).
	 */
	onSessionSwitched?: (id: string) => void | Promise<void>
	/** One-shot action to run after the TUI has started — e.g. open the session picker. */
	onReady?: (ctx: ChatContext) => void | Promise<void>
	/** Forwarded into ChatContext so /model preserves the override. */
	baseUrlOverride?: string
	/** Ring buffer of recent stderr writes — surfaced in the footer and by /log. */
	stderrCapture?: StderrCapture
}

/** Handle exposed to slash command handlers and overlays. */
export interface ChatContext {
	agent: Agent
	get session(): Session
	get sessionId(): string
	tui: TUI
	appendLine: (text: string) => void
	clearTranscript: () => void
	/** Replace the editor's current text. Used by /fork to drop the picked user message back into the prompt. */
	setEditorText: (text: string) => void
	requestExit: (code?: number) => void
	/** Switch to an existing session in-process. Loads its history into the agent. */
	switchSession: (id: string) => Promise<void>
	/** Replace the current session with `next` (just-created or freshly opened). */
	useSession: (next: Session, id: string) => void
	/**
	 * Swap the editor with a selector component. Mirrors pi-coding-agent's
	 * `showSelector` — used for full-page pickers (rewind, tree, model, etc.)
	 * that benefit from more vertical space than a centered modal overlay
	 * provides. The factory is given a `done` callback that restores the
	 * editor; call it when the user picks or cancels.
	 */
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component },
	) => void
	/**
	 * Re-render the current session's active branch into the chat transcript.
	 * Use after `session.moveTo(...)` so the user sees the new branch's
	 * messages instead of an empty transcript. Mirrors pi's behaviour after
	 * a tree navigation / fork.
	 */
	replaySession: () => void
	commands?: SlashCommandRegistry
	/**
	 * --baseurl override forwarded from the CLI. When the user switches model via
	 * /model we re-apply this so the new model uses the same backend.
	 */
	baseUrlOverride?: string
	stderrCapture?: StderrCapture
}

export async function runChat(options: ChatOptions): Promise<void> {
	const { agent } = options
	const terminal = new ProcessTerminal()
	const tui = new TUI(terminal)

	// Cached at runChat boot, refreshed after /settings (and any other slash
	// command that might mutate it). Reading from disk on every keypress would
	// be sync-impossible (loadSettings is async) and overkill — refreshing on
	// command boundary is responsive enough.
	let doubleEscapeAction: "tree" | "fork" | "none" = (await loadSettings()).doubleEscapeAction
	const refreshSettingsCache = async () => {
		try {
			doubleEscapeAction = (await loadSettings()).doubleEscapeAction
		} catch {}
	}

	// Track which providers have a subscription-style (OAuth) credential on
	// disk, so the footer can flash `(sub)` next to cost. Refreshed after every
	// slash command — that covers /login, /logout, /reload without each handler
	// having to opt in.
	let subscriptionProviders = new Set<string>()
	const refreshAuthCache = async () => {
		try {
			const next = new Set<string>()
			for (const p of await listProviders()) {
				const cred = await getCredential(p)
				if (cred?.kind === "codex") next.add(p)
			}
			subscriptionProviders = next
		} catch {}
	}
	await refreshAuthCache()

	// Mutable references — they get swapped by /new and /resume.
	let currentSession: Session = options.session
	let currentSessionId: string = options.sessionId

	// Dedicated container for the transcript so new lines never bleed into
	// the bottom-anchored editor + footer.
	const chatContainer = new Container()

	const appendLine = (text: string) => {
		chatContainer.addChild(new TextLine(text))
		tui.requestRender()
	}

	// Dim status-style line (used for "(switched to session…)", "(empty turn)" etc.)
	const appendDim = (text: string) => {
		chatContainer.addChild(new TextLine(theme.dim(text)))
		tui.requestRender()
	}

	const clearTranscript = () => {
		chatContainer.clear()
		// Tool components are tracked by callId across the whole transcript;
		// clearing the transcript without resetting the map would leave stale
		// references that the next tool_execution_end would try to mutate.
		toolComponents.clear()
		tui.requestRender()
	}

	// Map open tool calls to their on-screen component so tool_execution_end
	// can flip the state from pending → success/error in place.
	const toolComponents = new Map<string, ToolExecutionComponent>()

	const flattenContent = (content: any): string => {
		if (typeof content === "string") return content
		if (!Array.isArray(content)) return ""
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
	}

	const appendMessage = (msg: any) => {
		if (msg.role === "user") {
			chatContainer.addChild(new UserMessageComponent(msg))
		} else if (msg.role === "assistant") {
			const c = new AssistantMessageComponent(msg)
			chatContainer.addChild(c)
			// Replay tool calls as their own components so resumed sessions
			// look like live ones.
			const blocks = Array.isArray(msg.content) ? msg.content : []
			for (const b of blocks) {
				if (b.type === "toolCall") {
					const tc = new ToolExecutionComponent(b.name, b.arguments)
					toolComponents.set(b.id, tc)
					chatContainer.addChild(tc)
				}
			}
		} else if (msg.role === "toolResult") {
			// A toolResult message is the second half of a tool execution we
			// already showed via the assistant's toolCall block — just
			// retro-fit the matching ToolExecutionComponent.
			const id = msg.toolCallId
			const tc = id ? toolComponents.get(id) : undefined
			const text = flattenContent(msg.content)
			if (tc) {
				tc.setResult(text, !!msg.isError)
				toolComponents.delete(id)
			} else {
				// Stray result with no matching call (shouldn't happen). Fall
				// back to a labelled custom message so it still shows up.
				chatContainer.addChild(
					new CustomMessageComponent(text || "(no output)", {
						label: msg.toolName ?? "tool",
						tone: msg.isError ? "error" : "info",
					}),
				)
			}
		} else {
			// custom / unknown roles — render as a labelled note.
			chatContainer.addChild(
				new CustomMessageComponent(flattenContent(msg.content) || "", {
					label: msg.role,
				}),
			)
		}
		tui.requestRender()
	}

	let exitRequested = false
	const requestExit = (code = 0) => {
		exitRequested = true
		try {
			tui.stop()
		} catch {}
		// Print a resume hint to stdout so it lands in scrollback after the TUI
		// tears down. Skipped on a no-message session (nothing worth resuming).
		// Uses an 8-char prefix — `--session` accepts any unique id prefix.
		try {
			const realMessages = currentSession.getMessages().filter((m: any) => !isProjectContextMessage(m))
			if (realMessages.length > 0 && currentSessionId) {
				const id = currentSessionId.slice(0, 8)
				console.log(`\nTo resume this session:\npinano --session ${id}`)
			}
		} catch {}
		process.exit(code)
	}

	// Tracks AGENTS.md / CLAUDE.md paths we've already surfaced as a status
	// line, so subsequent messages in the same session don't re-announce.
	// Reset on session swap (each session has its own context).
	const announcedContextPaths = new Set<string>()
	const CONTEXT_HEADINGS = [PROJECT_CONTEXT_HEADING, LAZY_NOTICE_HEADING]
	const announceContextPathsInMessage = (m: any): void => {
		if (!m) return
		const content = m.content
		const texts: string[] = []
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text)
			}
		} else if (typeof content === "string") {
			texts.push(content)
		}
		for (const text of texts) {
			if (!CONTEXT_HEADINGS.some((h) => text.includes(h))) continue
			const re = /^##\s+(\/\S+)\s*$/gm
			let match: RegExpExecArray | null
			while ((match = re.exec(text))) {
				if (announcedContextPaths.has(match[1])) continue
				announcedContextPaths.add(match[1])
				appendDim(`loaded ${match[1]}`)
			}
		}
	}

	const replaySession = (session: Session) => {
		clearTranscript()
		announcedContextPaths.clear()
		const messages = session.getMessages()
		agent.state.messages = messages as any
		for (const msg of messages) {
			announceContextPathsInMessage(msg)
			if (isProjectContextMessage(msg)) continue
			appendMessage(msg)
		}
	}

	const useSession = (next: Session, id: string) => {
		// If the outgoing session never received a message, drop it on the
		// floor instead of leaving an empty record behind in the per-cwd
		// index. Skips when we're swapping in the same session (no-op) or
		// when the outgoing session was already non-empty.
		const prevId = currentSessionId
		const prevSession = currentSession
		currentSession = next
		currentSessionId = id
		replaySession(next)
		footer.update()
		tui.requestRender()
		void options.onSessionSwitched?.(id)
		if (prevId && prevId !== id && sessionIsEmpty(prevSession)) {
			deleteSession(prevId).catch(() => {})
		}
	}

	const switchSession = async (id: string) => {
		if (id === currentSessionId) return
		const opened = await openSession(id)
		// Upgrade legacy sessions on first switch; no-op for sessions already
		// containing the project-context user message.
		await ensureProjectContextMessage(opened.session, process.cwd())
		useSession(opened.session, id)
		const visibleCount = agent.state.messages.filter((m: any) => !isProjectContextMessage(m)).length
		appendLine(theme.dim(`(switched to session ${id.slice(0, 8)}, ${visibleCount} messages)`))
	}

	// Forward-declared so ChatContext can expose `setEditorText` without
	// reordering Editor construction (which depends on `tui` + commands list).
	let editor: Editor

	// editorContainer wraps the editor so we can temporarily swap the editor
	// out for a full-page selector component (pi-style /fork picker, /tree,
	// /model overlays). Centered modal overlays felt cramped — selector
	// components benefit from the full bottom-of-pane width.
	const editorContainer = new Container()

	const showSelector = (
		create: (done: () => void) => { component: Component; focus: Component },
	) => {
		const done = () => {
			editorContainer.clear()
			editorContainer.addChild(editor)
			tui.setFocus(editor)
			tui.requestRender()
		}
		const { component, focus } = create(done)
		editorContainer.clear()
		editorContainer.addChild(component)
		tui.setFocus(focus)
		tui.requestRender()
	}

	const ctx: ChatContext = {
		agent,
		get session() {
			return currentSession
		},
		get sessionId() {
			return currentSessionId
		},
		tui,
		appendLine,
		clearTranscript,
		setEditorText: (text: string) => editor.setText(text),
		requestExit,
		switchSession,
		useSession,
		showSelector,
		replaySession: () => replaySession(currentSession),
		commands: options.commands,
		baseUrlOverride: options.baseUrlOverride,
		stderrCapture: options.stderrCapture,
	}

	// Live streaming assistant component so partial text shows as it arrives.
	// We attach it to chatContainer directly (rather than via appendMessage)
	// so we can mutate it in place via update().
	let streamingAssistant: AssistantMessageComponent | undefined

	// Working indicator (spinner + label) shown between the transcript and the
	// editor while the agent is running. Created on agent_start, swapped in
	// place during tool execution, torn down on agent_end.
	const statusContainer = new Container()
	let workingLoader: Loader | undefined
	const showLoader = (message: string) => {
		if (workingLoader) {
			workingLoader.setMessage(message)
			return
		}
		workingLoader = new Loader(tui, theme.cyan, theme.dim, message)
		statusContainer.addChild(workingLoader)
		tui.requestRender()
	}
	const hideLoader = () => {
		if (!workingLoader) return
		workingLoader.stop()
		statusContainer.clear()
		workingLoader = undefined
		tui.requestRender()
	}

	const footer = new Footer(
		agent,
		(provider) => subscriptionProviders.has(provider),
		() => options.stderrCapture?.size() ?? 0,
	)
	options.stderrCapture?.subscribe(() => {
		footer.update()
		tui.requestRender()
	})

	// Replay any pre-existing session messages into the transcript and mirror
	// into agent state so the next prompt has full context. The synthetic
	// project-context user message stays in agent.state (the model needs it)
	// but is hidden from the visible transcript and the "(resumed)" hint —
	// otherwise a brand-new session looks like a resumed one.
	{
		const existing = currentSession.getMessages()
		agent.state.messages = existing as any
		for (const msg of existing) announceContextPathsInMessage(msg)
		const visible = existing.filter((m: any) => !isProjectContextMessage(m))
		for (const msg of visible) appendMessage(msg)
		if (visible.length > 0) {
			appendDim(`(resumed session ${currentSessionId.slice(0, 8)}, ${visible.length} messages)`)
		}
	}

	if (options.hello) appendDim(options.hello)

	agent.subscribe(async (event) => {
		switch (event.type) {
			case "agent_start": {
				showLoader("Thinking…")
				break
			}
			case "message_start": {
				if (event.message.role === "assistant") {
					showLoader("Generating…")
					streamingAssistant = new AssistantMessageComponent(event.message as any)
					chatContainer.addChild(streamingAssistant)
					tui.requestRender()
				} else if (event.message.role === "user") {
					// Show the user prompt as soon as the agent starts processing
					// it (before the first model token). The eventual append from
					// session replay would also work, but this is snappier.
					appendMessage(event.message)
				}
				break
			}
			case "message_update": {
				if (event.message.role === "assistant" && streamingAssistant) {
					streamingAssistant.update(event.message as any)
					tui.requestRender()
				}
				break
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					if (streamingAssistant) {
						streamingAssistant.update(event.message as any)
						// Spawn pending tool components for any toolCall blocks
						// the model produced. They flip to success/error on
						// tool_execution_end.
						const blocks = Array.isArray((event.message as any).content)
							? (event.message as any).content
							: []
						for (const b of blocks) {
							if (b.type === "toolCall" && !toolComponents.has(b.id)) {
								const tc = new ToolExecutionComponent(b.name, b.arguments)
								toolComponents.set(b.id, tc)
								chatContainer.addChild(tc)
							}
						}
						streamingAssistant = undefined
					} else {
						appendMessage(event.message)
					}
				} else if (event.message.role === "toolResult") {
					// Wire the result into the existing pending component.
					appendMessage(event.message)
					// Surface any subdir AGENTS.md/CLAUDE.md the lazy loader
					// just appended into this tool result.
					announceContextPathsInMessage(event.message)
				} else if (event.message.role !== "user") {
					// User messages already shown on message_start; everything
					// else that's not a user/assistant/toolResult goes through
					// appendMessage as a custom note.
					appendMessage(event.message)
				}
				try {
					await currentSession.appendMessage(event.message as any)
				} catch (err: any) {
					appendLine(theme.red(`[session save error] ${err?.message ?? err}`))
				}
				footer.update()
				tui.requestRender()
				break
			}
			case "tool_execution_start": {
				showLoader(`Running ${event.toolName}…`)
				break
			}
			case "tool_execution_end": {
				showLoader("Thinking…")
				footer.update()
				tui.requestRender()
				break
			}
			case "agent_end": {
				hideLoader()
				touchSession(currentSessionId).catch(() => {})
				footer.update()
				tui.requestRender()
				break
			}
		}
	})

	editor = new Editor(tui, editorTheme as any, { paddingX: 1 })
	if (options.commands) {
		const slashCommands = options.commands.list().map((c) => ({
			name: c.name,
			description: c.description,
		}))
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd(), null))
	}
	editor.onSubmit = async (text: string) => {
		const trimmed = text.trim()
		if (!trimmed) return

		if (trimmed.startsWith("/") && options.commands) {
			try {
				await dispatchSlashCommand(options.commands, trimmed.slice(1), ctx)
			} catch (err: any) {
				appendLine(theme.red(`[/cmd error] ${err?.message ?? err}`))
			}
			await refreshSettingsCache()
			await refreshAuthCache()
			footer.update()
			tui.requestRender()
			return
		}

		// !cmd / !!cmd — run shell directly without an LLM round-trip.
		const shortcut = parseBashShortcut(trimmed)
		if (shortcut) {
			if (agent.state.isStreaming) {
				appendLine(theme.yellow("[bash shortcut] agent is streaming — press Ctrl+C to abort first"))
				return
			}
			const marker = shortcut.excludeFromContext ? "(no-ctx)" : ""
			appendLine(theme.dim(`$ ${shortcut.command} ${marker}`.trimEnd()))
			try {
				const result = await runBashShortcut(agent, shortcut.command, {
					excludeFromContext: shortcut.excludeFromContext,
				})
				if (result.output) appendLine(result.output)
				await recordBashShortcut(agent, currentSession, result)
			} catch (err: any) {
				appendLine(theme.red(`[bash error] ${err?.message ?? err}`))
			}
			footer.update()
			tui.requestRender()
			return
		}

		if (agent.state.isStreaming) {
			agent.steer({ role: "user", content: [{ type: "text", text: trimmed }], timestamp: Date.now() })
			appendLine(theme.dim(`(steered) ${trimmed}`))
		} else {
			agent.prompt(trimmed).catch((err) => {
				appendLine(theme.red(`[error] ${err?.message ?? err}`))
			})
		}
	}

	// Layout: chat first (grows), then bottom-anchored block.
	editorContainer.addChild(editor)
	tui.addChild(chatContainer)
	tui.addChild(statusContainer)
	tui.addChild(new Spacer(1))
	tui.addChild(buildKeybindHints())
	tui.addChild(editorContainer)
	tui.addChild(footer.component)
	tui.setFocus(editor)

	tui.addInputListener((data: string | Buffer) => {
		if (matchesKey(data, "ctrl+c")) {
			if (agent.state.isStreaming) {
				agent.abort()
				appendLine(theme.yellow("[aborted]"))
				return
			}
			requestExit(0)
		}
	})

	// Esc-Esc on an empty editor: open /tree (default) or /fork to roll back
	// to a previous user message. Skipped when the editor isn't focused (an
	// overlay is up — escape should close it instead) or when there's text in
	// the buffer (escape is for autocomplete cancel / future text actions).
	let lastEscapeTime = 0
	tui.addInputListener((data: string) => {
		if (!matchesKey(data, "escape")) return
		// Kitty keyboard protocol fires both press + release for the same key.
		// Without filtering, a single Esc tap would satisfy the 500ms threshold
		// against itself and instantly trigger /tree.
		if (isKeyRelease(data)) return
		if (!editor.focused) return
		// Interrupt the agent if it's running — matches pi and Claude Code.
		// The same AbortSignal is passed to tools, so any in-flight tool call
		// (bash, find, grep) gets cancelled too.
		if (agent.state.isStreaming) {
			agent.abort()
			return { consume: true }
		}
		if (editor.getText().trim().length > 0) return
		const action = doubleEscapeAction
		if (action === "none") return
		const now = Date.now()
		if (now - lastEscapeTime < 500) {
			lastEscapeTime = 0
			if (!options.commands) return
			const cmd = action === "fork" ? "fork" : "tree"
			void dispatchSlashCommand(options.commands, cmd, ctx).catch((err) => {
				appendLine(theme.red(`[/${cmd} error] ${err?.message ?? err}`))
			})
			return { consume: true }
		}
		lastEscapeTime = now
	})

	tui.start()
	void exitRequested

	if (options.onReady) {
		// Defer so the first paint completes before any overlay opens.
		queueMicrotask(() => {
			Promise.resolve(options.onReady!(ctx)).catch((err) => {
				appendLine(theme.red(`[onReady error] ${err?.message ?? err}`))
			})
		})
	}

	await new Promise<void>(() => {
		// runs until process.exit
	})
}
