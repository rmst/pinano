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
//   slash commands        → routed via slashCommandRegistry, see slash-commands.js

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
} from "../tui/index.js"
import { Agent } from "../agent-core/agent.js"
import { Session } from "../session-manager/index.js"
import { editorTheme, theme } from "./theme.js"
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	TextLine,
	ToolExecutionComponent,
	UserMessageComponent,
} from "./components/messages.js"
import { dispatchSlashCommand } from "./slash-commands.js"
import { deleteSession, openSession, sessionIsEmpty, touchSession } from "./session-store.js"
import { ensureProjectContextMessage, isProjectContextMessage, PROJECT_CONTEXT_HEADING } from "./project-context.js"
import { LAZY_NOTICE_HEADING } from "./lazy-context.js"
import { Footer } from "./components/footer.js"
import { buildKeybindHints } from "./components/keybind-hints.js"
import { parseBashShortcut, runBashShortcut, recordBashShortcut } from "./bash-shortcut.js"
import { loadSettings } from "./settings.js"
import { getCredential, listProviders } from "./auth.js"

/** @typedef {import("../tui/index.js").Component} Component */
/** @typedef {import("./slash-commands.js").SlashCommandRegistry} SlashCommandRegistry */
/** @typedef {import("./stderr-capture.js").StderrCapture} StderrCapture */

/**
 * @typedef {object} ChatOptions
 * @property {Agent} agent
 * @property {Session} session
 * @property {string} sessionId
 * @property {string} [hello]
 * @property {SlashCommandRegistry} [commands]
 * @property {(id: string) => void | Promise<void>} [onSessionSwitched] Optional hook called after we've already swapped the in-process session.
 * @property {(ctx: ChatContext) => void | Promise<void>} [onReady] One-shot action to run after the TUI has started — e.g. open the session picker.
 * @property {string} [baseUrlOverride] Forwarded into ChatContext so /model preserves the override.
 * @property {StderrCapture} [stderrCapture] Ring buffer of recent stderr writes — surfaced in the footer and by /log.
 */

/**
 * Handle exposed to slash command handlers and overlays.
 *
 * @typedef {object} ChatContext
 * @property {Agent} agent
 * @property {Session} session
 * @property {string} sessionId
 * @property {TUI} tui
 * @property {(text: string) => void} appendLine
 * @property {() => void} clearTranscript
 * @property {(text: string) => void} setEditorText Replace the editor's current text. Used by /fork to drop the picked user message back into the prompt.
 * @property {(code?: number) => void} requestExit
 * @property {(id: string) => Promise<void>} switchSession Switch to an existing session in-process. Loads its history into the agent.
 * @property {(next: Session, id: string) => void} useSession Replace the current session with `next` (just-created or freshly opened).
 * @property {(create: (done: () => void) => { component: Component, focus: Component }) => void} showSelector Swap the editor with a selector component.
 * @property {() => void} replaySession Re-render the current session's active branch into the chat transcript.
 * @property {SlashCommandRegistry} [commands]
 * @property {string} [baseUrlOverride] --baseurl override forwarded from the CLI.
 * @property {StderrCapture} [stderrCapture]
 */

/**
 * @param {ChatOptions} options
 * @returns {Promise<void>}
 */
export async function runChat(options) {
	const { agent } = options
	const terminal = new ProcessTerminal()
	const tui = new TUI(terminal)

	// Cached at runChat boot, refreshed after /settings (and any other slash
	// command that might mutate it). Reading from disk on every keypress would
	// be sync-impossible (loadSettings is async) and overkill — refreshing on
	// command boundary is responsive enough.
	/** @type {"tree" | "fork" | "none"} */
	let doubleEscapeAction = (await loadSettings()).doubleEscapeAction
	const refreshSettingsCache = async () => {
		try {
			doubleEscapeAction = (await loadSettings()).doubleEscapeAction
		} catch {}
	}

	// Track which providers have a subscription-style (OAuth) credential on
	// disk, so the footer can flash `(sub)` next to cost. Refreshed after every
	// slash command — that covers /login, /logout, /reload without each handler
	// having to opt in.
	/** @type {Set<string>} */
	let subscriptionProviders = new Set()
	const refreshAuthCache = async () => {
		try {
			/** @type {Set<string>} */
			const next = new Set()
			for (const p of await listProviders()) {
				const cred = await getCredential(p)
				if (cred?.kind === "codex") next.add(p)
			}
			subscriptionProviders = next
		} catch {}
	}
	await refreshAuthCache()

	// Mutable references — they get swapped by /new and /resume.
	/** @type {Session} */
	let currentSession = options.session
	/** @type {string} */
	let currentSessionId = options.sessionId

	// Dedicated container for the transcript so new lines never bleed into
	// the bottom-anchored editor + footer.
	const chatContainer = new Container()

	/** @param {string} text */
	const appendLine = (text) => {
		chatContainer.addChild(new TextLine(text))
		tui.requestRender()
	}

	// Dim status-style line (used for "(switched to session…)", "(empty turn)" etc.)
	/** @param {string} text */
	const appendDim = (text) => {
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
	/** @type {Map<string, ToolExecutionComponent>} */
	const toolComponents = new Map()

	/**
	 * @param {any} content
	 * @returns {string}
	 */
	const flattenContent = (content) => {
		if (typeof content === "string") return content
		if (!Array.isArray(content)) return ""
		return content
			.filter((/** @type {any} */ c) => c.type === "text")
			.map((/** @type {any} */ c) => c.text)
			.join("")
	}

	/** @param {any} msg */
	const appendMessage = (msg) => {
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
			const realMessages = currentSession.getMessages().filter((/** @type {any} */ m) => !isProjectContextMessage(m))
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
	/** @type {Set<string>} */
	const announcedContextPaths = new Set()
	const CONTEXT_HEADINGS = [PROJECT_CONTEXT_HEADING, LAZY_NOTICE_HEADING]
	/**
	 * @param {any} m
	 * @returns {void}
	 */
	const announceContextPathsInMessage = (m) => {
		if (!m) return
		const content = m.content
		/** @type {string[]} */
		const texts = []
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
			/** @type {RegExpExecArray | null} */
			let match
			while ((match = re.exec(text))) {
				if (announcedContextPaths.has(match[1])) continue
				announcedContextPaths.add(match[1])
				appendDim(`loaded ${match[1]}`)
			}
		}
	}

	/** @param {Session} session */
	const replaySession = (session) => {
		clearTranscript()
		announcedContextPaths.clear()
		const messages = session.getMessages()
		agent.state.messages = /** @type {any} */ (messages)
		for (const msg of messages) {
			announceContextPathsInMessage(msg)
			if (isProjectContextMessage(msg)) continue
			appendMessage(msg)
		}
	}

	/**
	 * @param {Session} next
	 * @param {string} id
	 */
	const useSession = (next, id) => {
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

	/** @param {string} id */
	const switchSession = async (id) => {
		if (id === currentSessionId) return
		const opened = await openSession(id)
		// Upgrade legacy sessions on first switch; no-op for sessions already
		// containing the project-context user message.
		await ensureProjectContextMessage(opened.session, process.cwd())
		useSession(opened.session, id)
		const visibleCount = agent.state.messages.filter((/** @type {any} */ m) => !isProjectContextMessage(m)).length
		appendLine(theme.dim(`(switched to session ${id.slice(0, 8)}, ${visibleCount} messages)`))
	}

	// Forward-declared so ChatContext can expose `setEditorText` without
	// reordering Editor construction (which depends on `tui` + commands list).
	/** @type {Editor} */
	let editor

	// editorContainer wraps the editor so we can temporarily swap the editor
	// out for a full-page selector component (pi-style /fork picker, /tree,
	// /model overlays). Centered modal overlays felt cramped — selector
	// components benefit from the full bottom-of-pane width.
	const editorContainer = new Container()

	/**
	 * @param {(done: () => void) => { component: Component, focus: Component }} create
	 */
	const showSelector = (create) => {
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

	/** @type {ChatContext} */
	const ctx = {
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
		setEditorText: (text) => editor.setText(text),
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
	/** @type {AssistantMessageComponent | undefined} */
	let streamingAssistant

	// Working indicator (spinner + label) shown between the transcript and the
	// editor while the agent is running. Created on agent_start, swapped in
	// place during tool execution, torn down on agent_end.
	const statusContainer = new Container()
	/** @type {Loader | undefined} */
	let workingLoader
	/** @param {string} message */
	const showLoader = (message) => {
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
		agent.state.messages = /** @type {any} */ (existing)
		for (const msg of existing) announceContextPathsInMessage(msg)
		const visible = existing.filter((/** @type {any} */ m) => !isProjectContextMessage(m))
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
					streamingAssistant = new AssistantMessageComponent(/** @type {any} */ (event.message))
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
					streamingAssistant.update(/** @type {any} */ (event.message))
					tui.requestRender()
				}
				break
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					if (streamingAssistant) {
						streamingAssistant.update(/** @type {any} */ (event.message))
						// Spawn pending tool components for any toolCall blocks
						// the model produced. They flip to success/error on
						// tool_execution_end.
						const blocks = Array.isArray(/** @type {any} */ (event.message).content)
							? /** @type {any} */ (event.message).content
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
					await currentSession.appendMessage(/** @type {any} */ (event.message))
				} catch (err) {
					appendLine(theme.red(`[session save error] ${/** @type {any} */ (err)?.message ?? err}`))
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

	editor = new Editor(tui, /** @type {any} */ (editorTheme), { paddingX: 1 })
	if (options.commands) {
		const slashCommands = options.commands.list().map((c) => ({
			name: c.name,
			description: c.description,
		}))
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd(), null))
	}
	editor.onSubmit = async (/** @type {string} */ text) => {
		const trimmed = text.trim()
		if (!trimmed) return

		if (trimmed.startsWith("/") && options.commands) {
			try {
				await dispatchSlashCommand(options.commands, trimmed.slice(1), ctx)
			} catch (err) {
				appendLine(theme.red(`[/cmd error] ${/** @type {any} */ (err)?.message ?? err}`))
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
			} catch (err) {
				appendLine(theme.red(`[bash error] ${/** @type {any} */ (err)?.message ?? err}`))
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

	tui.addInputListener((/** @type {string | Buffer} */ data) => {
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
	tui.addInputListener((/** @type {string} */ data) => {
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
			Promise.resolve(/** @type {NonNullable<typeof options.onReady>} */ (options.onReady)(ctx)).catch((err) => {
				appendLine(theme.red(`[onReady error] ${err?.message ?? err}`))
			})
		})
	}

	await new Promise(() => {
		// runs until process.exit
	})
}
