import { randomUUID } from "node:crypto"

import { PLAN_UPDATE_MESSAGE_ROLE } from "../../../../../server/src/session-manager/plan-update-entry.js"

import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Loader,
	MouseWheelDeltaTracker,
	Spacer,
	Text,
	isKeyRelease,
	matchesKey,
} from "../../../tui/index.js"
import {
	AssistantMessageComponent,
	BashShortcutComponent,
	ContextLoadComponent,
	CustomMessageComponent,
	isBashShortcutMessage,
	TextLine,
	ToolExecutionComponent,
	UserMessageComponent,
} from "../../components/messages.js"
import { TranscriptContainer, TranscriptViewport } from "../../components/transcript.js"
import { Footer } from "../../components/footer.js"
import { pickInline } from "../../components/inline-picker.js"
import { showTextModal } from "../../components/text-modal.js"
import { pickModel, rowsForModels } from "../../components/model-selector.js"
import { pickHistoryTarget } from "../../components/history-selector.js"
import { reasoningLevelLabel } from "../../../../../protocol/src/reasoning.js"
import { promptImagePlaceholders } from "../../../../../protocol/src/prompt-images.js"
import { parseBashShortcut } from "../../../../../server/src/app/bash-shortcut.js"
import { clipboardImagePasteNotice, readClipboardImage } from "../../../../../server/src/app/clipboard-image.js"
import { formatContextReport } from "../../../../../server/src/app/context/report.js"
import { formatSystemReport, projectContextPathsInMessages } from "../../../../../server/src/app/project/context-display.js"
import { REWIND_PICKER_SUBTITLE } from "../../../../../server/src/app/session/rewind-actions.js"
import { modelRetryExhaustedText, modelRetryScheduledText } from "../../../../../server/src/app/model/retry-policy.js"
import { availableModelEntries } from "../../../../../server/src/app/model/registry.js"
import { applySessionEvent, cloneSessionSnapshot } from "../../../../../server/src/app/session/state.js"
import { sessionRoute } from "../../../../../server/src/app/navigation/routes.js"
import { updateSetting } from "../../../../../server/src/app/settings.js"
import { WEB_BROWSER_UI_NAME } from "../../../../../protocol/src/web-branding.js"
import { sessionCursorGeneration, sessionCursorGenerationChanged } from "../../../../../protocol/src/session-cursor.js"
import { editorTheme, theme } from "../../theme.js"
import { AccentDividerLine, SessionCwdLine, SessionInfoLine, sessionInfoBody } from "./status.js"
import { flattenContent, isTranscriptMessageRenderable, mergeStaleSnapshotMessages, transcriptCursor, transcriptMessageFingerprint, transcriptMessageKey, transcriptMessageState, transcriptStateFromSnapshot, transcriptStatesEqual } from "./transcript-state.js"
import { streamingContentProgress, streamingStatusBase } from "./streaming-status.js"
import { clearPromptImageAttachmentsForText, colorUsageStatus, insertPromptImageAttachment, promptAttachmentsForText, singleLine } from "../format.js"
import { elapsedAge, elapsedDuration, formatCount } from "../time-format.js"
import { SessionKeyHints } from "../chrome.js"
import { isTransientServiceTransportError } from "../service-events.js"
import { commandHelpBody, isWebSlashCommand, parseAgentSpawnArgs, rewindPromptActionItems, serviceChatCommandLine, serviceChatCommandsForModel, sessionOpenCommand, showCodexUsageModal, subSessionLines, webForOpening, webUrlForRoute } from "../slash-commands.js"
import { openUrlInBrowser, webOpenNotice } from "../browser-open.js"
import { showCredentialsSettings } from "../settings/credentials-modal.js"
import { pickReasoningLevel, reloadUiSettingsAndAuth } from "../settings/model-preferences.js"
import { showSettingsEditor } from "../settings/settings-editor.js"

/** @typedef {import("../../../../../server/src/app/stderr-capture.js").StderrCapture} StderrCapture */

const CLIPBOARD_IMAGE_NOTICE_MS = 4000
const SESSION_WORKTREE_STATUS_REFRESH_INTERVAL_MS = 10 * 1000
const DRAFT_SYNC_RETRY_INITIAL_MS = 500
const DRAFT_SYNC_RETRY_MAX_MS = 5000
const NO_MODEL_PROVIDER_CHAT_NOTICE = "No model provider configured. Open /settings and choose credentials before sending."

async function hasAvailableModelProvider() {
	return (await availableModelEntries()).length > 0
}

/** @param {any} snapshot */
function agentAdapterForSnapshot(snapshot) {
	return {
		state: {
			model: snapshot?.model ?? { id: "?", provider: "unknown", baseUrl: "", contextWindow: 0 },
			thinkingLevel: reasoningLevelLabel(snapshot?.thinkingLevel),
			messages: snapshot?.contextMessages ?? snapshot?.messages ?? [],
			contextStats: snapshot?.contextStats,
			systemPrompt: snapshot?.systemPrompt ?? "",
			tools: snapshot?.tools ?? [],
		},
	}
}

export class Chat {
	/**
	 * @param {object} opts
	 * @param {TUI} opts.tui
	 * @param {any} opts.client
	 * @param {string} opts.sessionId
	 * @param {() => void} opts.detach
	 * @param {() => void} opts.exit
	 * @param {StderrCapture} [opts.stderrCapture]
	 * @param {(err: unknown) => boolean} [opts.onClientError]
	 * @param {{ showThinkingOutput: boolean, showToolOutput: boolean }} opts.messageRenderOptions
	 * @param {boolean} [opts.webEnabled]
	 * @param {(settings: import("../../../../../server/src/app/settings.js").Settings) => void} [opts.onSettingsChanged]
	 * @param {(payload: import("../../../../../server/src/app/usage/codex.js").CodexUsagePayload) => void} [opts.onCodexUsage]
	 * @param {(model: any) => string | undefined} [opts.getCodexUsageBaseUrl]
	 * @param {() => Promise<void>} [opts.refreshGlobalAuth]
	 * @param {(sessionId: string, options?: { routeHistory?: "record" | "replace" }) => void} [opts.onSessionIdChanged]
	 */
	constructor(opts) {
		this.tui = opts.tui
		this.client = opts.client
		this.sessionId = opts.sessionId
		this.detach = opts.detach
		this.exit = opts.exit
		this.stderrCapture = opts.stderrCapture
		this.onClientError = opts.onClientError
		this.messageRenderOptions = opts.messageRenderOptions
		this.webEnabled = opts.webEnabled === true
		this.onSettingsChanged = opts.onSettingsChanged
		this.onCodexUsage = opts.onCodexUsage
		this.getCodexUsageBaseUrl = opts.getCodexUsageBaseUrl
		this.refreshGlobalAuth = opts.refreshGlobalAuth
		this.onSessionIdChanged = opts.onSessionIdChanged
		this.disposed = false
		this.promptRequestInFlight = false
		this.interruptRequested = false
		this.abortPromise = undefined
		this.promptCancelPromise = undefined
		this.backgroundMutationRefreshes = new Map()
		this.submittedPromptText = undefined
		this.submittedPromptAttachments = []
		this.draftClientId = randomUUID()
		this.draftClientSeq = 0
		this.draftSyncTimer = undefined
		this.draftSyncRetryTimer = undefined
		this.draftSyncRetryDelayMs = DRAFT_SYNC_RETRY_INITIAL_MS
		this.applyingPromptDraft = false
		this.lastPromptDraftVersion = -1
		this.promptImages = []
		this.promptImageCounter = 0
		this.snapshot = null
		this.root = new Container()
		this.headerContainer = new Container()
		this.chatContainer = new TranscriptContainer()
		this.transcriptWheelDeltas = new MouseWheelDeltaTracker()
		this.controlsContainer = new Container()
		this.transcriptViewport = new TranscriptViewport(this.chatContainer, {
			getMaxLines: (width) => this.transcriptViewportMaxLines(width),
		})
		this.statusContainer = new Container()
		this.pendingContainer = new Container()
		this.usageStatusLine = new Text("", 0, 0)
		this.statusChromeVisible = false
		this.pendingChromeVisible = false
		this.usageChromeVisible = false
		this.composerGapSpacer = new Spacer(2)
		this.sessionWorktrees = []
		this.sessionWorktreesSessionId = undefined
		this.sessionWorktreesLoadedAt = 0
		this.sessionWorktreeStatusRefresh = undefined
		this.sessionWorktreeForceRefreshSessionId = undefined
		this.editorContainer = new Container()
		this.toolComponents = new Map()
		this.toolCallDetails = new Map()
		this.transcriptTurnIndex = 0
		this.currentTranscriptWorkGroupId = undefined
		this.statusLoader = undefined
		this.transientStatusNoticeTimer = undefined
		this.statusAgeTimer = undefined
		this.statusProgress = undefined
		this.statusRunStartedAt = undefined
		this.streamingAssistant = undefined
		this.renderedMessageKeys = []
		this.renderedMessageFingerprints = []
		this.messageEventCursors = new Map()
		this.announcedContextPaths = new Set()
		this.needsSnapshotRebuild = false
		this.needsBranchSnapshotRebuild = false
		this.lastSeq = -1
		this.viewEpoch = undefined
		this.retiredCursorGenerations = new Set()
		this.subscriptionProviders = new Set()
		this.footerAgent = agentAdapterForSnapshot(null)
		this.footer = new Footer(
			/** @type {any} */ (this.footerAgent),
			(provider) => this.subscriptionProviders.has(provider),
			{
				onContextClick: () => {
					void this.handleSlash("context").catch((err) => this.reportClientError(err, "/context error"))
				},
				onReasoningClick: () => {
					void this.handleSlash("reasoning").catch((err) => this.reportClientError(err, "/reasoning error"))
				},
			},
		)
		this.sessionInfoLine = new SessionInfoLine(() => this.snapshot)
		this.sessionHeaderDivider = new AccentDividerLine()
		this.sessionCwdLine = new SessionCwdLine(() => ({
			snapshot: this.snapshot,
			worktrees: this.sessionWorktreesSessionId === this.snapshot?.sessionId ? this.sessionWorktrees : [],
		}))
		this.sessionKeyHints = new SessionKeyHints(() => ({
			hasText: this.editor.getText().trim() !== "",
			interruptible: this.hasInterruptibleTurn(),
		}), {
			onBack: () => this.detach(),
			onDetach: () => {
				void this.exit()
			},
			onHelp: () => {
				void this.handleSlash("help").catch((err) => this.reportClientError(err, "/help error"))
			},
		})
		this.editor = new Editor(this.tui, /** @type {any} */ (editorTheme), { paddingX: 1 })
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(() => serviceChatCommandsForModel(this.snapshot?.model, { web: this.webEnabled }), process.cwd(), null))
		this.editor.onChange = (text) => {
			if (this.applyingPromptDraft) return
			this.schedulePromptDraftSync(text)
		}
		this.editor.onSubmit = (text) => {
			const trimmed = text.trim()
			if (!trimmed) return
			const commandLine = serviceChatCommandLine(trimmed, { web: this.webEnabled })
			if (commandLine) {
				this.clearPromptImagesForText(trimmed)
				void this.handleSlash(commandLine).catch((err) => this.reportClientError(err, "/cmd error"))
				return
			}
			if (!this.webEnabled && isWebSlashCommand(trimmed)) {
				this.clearPromptImagesForText(trimmed)
				this.appendLine(theme.dim(`${WEB_BROWSER_UI_NAME} is disabled; set web: true in settings.json to enable /web.`))
				return
			}
			const shortcut = parseBashShortcut(trimmed)
			if (shortcut) {
				this.clearPromptImagesForText(trimmed)
				if (this.draftSyncTimer) {
					clearTimeout(this.draftSyncTimer)
					this.draftSyncTimer = undefined
				}
				this.clearDraftSyncRetryTimer()
				const draftClientSeq = this.nextDraftClientSeq()
				void this.client.bash(this.sessionId, trimmed, { draftClientId: this.draftClientId, draftClientSeq }).then(async (res) => {
					await this.refreshAfterMutation(res)
				}).catch((err) => {
					this.reportClientError(err, "bash error")
					this.restorePromptDraft(trimmed)
				})
				return
			}
			const streaming = this.snapshot?.isStreaming
			void this.sendPromptIfConfigured(trimmed, streaming ? "steer" : undefined).catch((err) => this.reportClientError(err, "error"))
		}
		this.headerContainer.addChild(this.sessionInfoLine)
		this.headerContainer.addChild(this.sessionHeaderDivider)
		this.root.addChild(this.headerContainer)
		this.root.addChild(this.transcriptViewport)
		this.controlsContainer.addChild(this.statusContainer)
		this.controlsContainer.addChild(this.pendingContainer)
		this.controlsContainer.addChild(this.usageStatusLine)
		this.controlsContainer.addChild(this.composerGapSpacer)
		this.controlsContainer.addChild(this.sessionCwdLine)
		this.controlsContainer.addChild(this.sessionKeyHints)
		this.editorContainer.addChild(this.editor)
		this.controlsContainer.addChild(this.editorContainer)
		this.controlsContainer.addChild(this.footer.component)
		this.root.addChild(this.controlsContainer)
		void this.refreshAuthCache()
	}

	/** @param {number} width */
	transcriptViewportMaxLines(width) {
		const rows = Number(this.tui.terminal?.rows)
		if (!Number.isFinite(rows)) return Infinity
		const headerHeight = this.headerContainer.render(width).length
		const controlsHeight = this.controlsContainer.render(width).length
		return rows - headerHeight - controlsHeight
	}

	setSessionId(sessionId, options = {}) {
		if (!sessionId || sessionId === this.sessionId) return
		this.sessionId = sessionId
		this.onSessionIdChanged?.(sessionId, options)
	}

	/**
	 * @param {() => boolean} action
	 * @returns {boolean}
	 */
	handleTranscriptScrollAction(action) {
		if (action()) this.tui.requestRender()
		return true
	}

	/** @param {string} data */
	handleTranscriptScrollInput(data) {
		if (isKeyRelease(data)) return false
		const promptIsEmpty = this.editor.getText().trim() === ""
		const autocompleteActive = this.editor.isShowingAutocomplete?.() === true
		const plainKeysScrollTranscript = (promptIsEmpty || !this.editor.focused) && !autocompleteActive

		if (matchesKey(data, "shift+pageUp") || matchesKey(data, "ctrl+pageUp") || (plainKeysScrollTranscript && matchesKey(data, "pageUp"))) {
			return this.handleTranscriptScrollAction(() => this.transcriptViewport.scrollPage(-1))
		}
		if (matchesKey(data, "shift+pageDown") || matchesKey(data, "ctrl+pageDown") || (plainKeysScrollTranscript && matchesKey(data, "pageDown"))) {
			return this.handleTranscriptScrollAction(() => this.transcriptViewport.scrollPage(1))
		}
		if (matchesKey(data, "ctrl+home") || (plainKeysScrollTranscript && matchesKey(data, "home"))) {
			return this.handleTranscriptScrollAction(() => this.transcriptViewport.scrollToTop())
		}
		if (matchesKey(data, "ctrl+end") || (plainKeysScrollTranscript && matchesKey(data, "end"))) {
			return this.handleTranscriptScrollAction(() => this.transcriptViewport.scrollToBottom())
		}
		return false
	}

	/** @param {any} event */
	handleMouseEvent(event) {
		if (event.type === "wheel") {
			const delta = this.transcriptWheelDeltas.deltaFromEvent(event)
			if (delta !== 0 && this.transcriptViewport.scrollLines(delta)) this.tui.requestRender()
			return true
		}
		return false
	}

	dispose() {
		this.disposed = true
		this.stopStatusAgeTimer()
		this.clearTransientStatusNoticeTimer()
		this.hideStatusLoader()
		if (this.draftSyncTimer) clearTimeout(this.draftSyncTimer)
		this.clearDraftSyncRetryTimer()
	}

	clearSessionWorktrees() {
		this.sessionWorktrees = []
		this.sessionWorktreesSessionId = undefined
		this.sessionWorktreesLoadedAt = 0
	}

	updateSessionWorktrees(sessionId, worktrees, loadedAt = Date.now()) {
		if (this.disposed || !sessionId || (this.snapshot?.sessionId ?? this.sessionId) !== sessionId) return
		this.sessionWorktrees = Array.isArray(worktrees) ? worktrees : []
		this.sessionWorktreesSessionId = sessionId
		this.sessionWorktreesLoadedAt = Number.isFinite(loadedAt) ? loadedAt : Date.now()
		this.tui.requestRender()
	}

	async refreshSessionWorktrees(options = {}) {
		const sessionId = this.snapshot?.sessionId ?? this.sessionId
		if (this.disposed || !sessionId || typeof this.client.worktrees !== "function") return undefined
		if (this.sessionWorktreeStatusRefresh?.sessionId === sessionId) {
			if (options.force === true) this.sessionWorktreeForceRefreshSessionId = sessionId
			return this.sessionWorktreeStatusRefresh.promise
		}
		if (options.force !== true && this.sessionWorktreesSessionId === sessionId && Date.now() - this.sessionWorktreesLoadedAt < SESSION_WORKTREE_STATUS_REFRESH_INTERVAL_MS) return undefined
		const promise = this.client.worktrees(sessionId)
			.then((worktrees) => {
				this.updateSessionWorktrees(sessionId, worktrees)
				return worktrees
			})
			.catch((err) => {
				if (this.disposed || (this.snapshot?.sessionId ?? this.sessionId) !== sessionId) return undefined
				this.clearSessionWorktrees()
				this.sessionWorktreesSessionId = sessionId
				this.sessionWorktreesLoadedAt = Date.now()
				if (options.showError === true) this.reportClientError(err, "worktree status error")
				this.tui.requestRender()
				return undefined
			})
			.finally(() => {
				if (this.sessionWorktreeStatusRefresh?.promise === promise) {
					this.sessionWorktreeStatusRefresh = undefined
					if (this.sessionWorktreeForceRefreshSessionId === sessionId) {
						this.sessionWorktreeForceRefreshSessionId = undefined
						if (!this.disposed && (this.snapshot?.sessionId ?? this.sessionId) === sessionId) void this.refreshSessionWorktrees({ force: true })
					}
				}
			})
		this.sessionWorktreeStatusRefresh = { sessionId, promise }
		return promise
	}

	async refreshAuthCache() {
		try {
			this.subscriptionProviders = await loadSubscriptionProviders()
			this.footer.update()
			this.tui.requestRender()
		} catch {}
	}

	reportClientError(err, label) {
		if (this.onClientError?.(err)) return
		this.appendLine(theme.red(`[${label}] ${err?.message ?? err}`))
	}

	nextDraftClientSeq() {
		this.draftClientSeq += 1
		return this.draftClientSeq
	}

	clearDraftSyncRetryTimer() {
		if (!this.draftSyncRetryTimer) return
		clearTimeout(this.draftSyncRetryTimer)
		this.draftSyncRetryTimer = undefined
	}

	/** @param {string} text @param {{ immediate?: boolean }} [options] */
	schedulePromptDraftSync(text, options = {}) {
		if (!this.client.setPromptDraft) return
		if (this.draftSyncTimer) clearTimeout(this.draftSyncTimer)
		this.clearDraftSyncRetryTimer()
		const sync = () => this.syncPromptDraft(text)
		if (options.immediate) return sync()
		this.draftSyncTimer = setTimeout(sync, 150)
	}

	schedulePromptDraftRetry() {
		if (this.disposed || this.draftSyncTimer || this.draftSyncRetryTimer) return
		const delayMs = this.draftSyncRetryDelayMs
		this.draftSyncRetryDelayMs = Math.min(DRAFT_SYNC_RETRY_MAX_MS, delayMs * 2)
		this.draftSyncRetryTimer = setTimeout(() => {
			this.draftSyncRetryTimer = undefined
			if (!this.disposed) this.syncPromptDraft(this.editor.getText())
		}, delayMs)
		this.draftSyncRetryTimer.unref?.()
	}

	flushPromptDraft() {
		if (!this.client.setPromptDraft) return
		if (this.draftSyncTimer) {
			clearTimeout(this.draftSyncTimer)
			this.draftSyncTimer = undefined
		}
		this.clearDraftSyncRetryTimer()
		void this.syncPromptDraft(this.editor.getText(), { reportErrors: false })
	}

	/** @param {string} text @param {{ reportErrors?: boolean }} [options] */
	syncPromptDraft(text, options = {}) {
		this.draftSyncTimer = undefined
		const clientSeq = this.nextDraftClientSeq()
		return this.client.setPromptDraft(this.sessionId, text, { clientId: this.draftClientId, clientSeq })
			.then((result) => {
				this.draftSyncRetryDelayMs = DRAFT_SYNC_RETRY_INITIAL_MS
				return result
			})
			.catch((err) => {
				if (isTransientServiceTransportError(err)) {
					if (!this.disposed && this.editor.getText() === text) this.schedulePromptDraftRetry()
					return undefined
				}
				if (options.reportErrors !== false) this.reportClientError(err, "draft sync error")
				return undefined
			})
	}

	/** @param {any} draft @param {{ force?: boolean }} [options] */
	applyPromptDraft(draft, options = {}) {
		const version = Number(draft?.version ?? 0)
		if (!options.force && version <= this.lastPromptDraftVersion) return
		this.lastPromptDraftVersion = version
		const text = draft?.text ?? ""
		if (this.editor.getText() === text) {
			this.clearDraftSyncRetryTimer()
			return
		}
		if (!options.force && draft?.updatedByClientId === this.draftClientId) return
		this.clearDraftSyncRetryTimer()
		this.applyingPromptDraft = true
		try {
			this.editor.setText(text)
		} finally {
			this.applyingPromptDraft = false
		}
	}

	restorePromptDraft(text) {
		this.applyingPromptDraft = true
		try {
			this.editor.setText(text)
		} finally {
			this.applyingPromptDraft = false
		}
		this.schedulePromptDraftSync(text, { immediate: true })
	}

	/** @param {string} text @param {"steer" | undefined} [streamingBehavior] */
	async sendPromptIfConfigured(text, streamingBehavior) {
		if (!(await hasAvailableModelProvider())) {
			this.appendSpacer()
			this.appendLine(theme.dim(NO_MODEL_PROVIDER_CHAT_NOTICE))
			this.restorePromptDraft(text)
			this.tui.requestRender()
			return
		}
		this.sendPrompt(text, streamingBehavior)
	}

	/** @param {string} text @param {"steer" | undefined} [streamingBehavior] */
	sendPrompt(text, streamingBehavior) {
		const attachments = this.promptAttachmentsForText(text)
		const images = attachments.map((attachment) => attachment.image)
		this.promptRequestInFlight = true
		if (!streamingBehavior) {
			this.submittedPromptText = text
			this.submittedPromptAttachments = attachments
		}
		if (this.draftSyncTimer) {
			clearTimeout(this.draftSyncTimer)
			this.draftSyncTimer = undefined
		}
		this.clearDraftSyncRetryTimer()
		const draftClientSeq = this.nextDraftClientSeq()
		const request = this.client.prompt(this.sessionId, text, streamingBehavior, { draftClientId: this.draftClientId, draftClientSeq, images })
			.then(async (res) => {
				this.clearPromptImagesForText(text)
				await this.refreshAfterMutation(res)
			})
			.catch((err) => {
				this.reportClientError(err, "error")
				this.restorePromptDraft(text)
			})
			.finally(() => {
				this.promptRequestInFlight = false
				if (this.interruptRequested) {
					if (!this.promptCancelPromise) this.requestInterrupt()
					else {
						if (this.snapshot) this.renderStatus(this.snapshot)
						this.tui.requestRender()
					}
					return
				}
				if (this.snapshot) this.renderStatus(this.snapshot)
				this.tui.requestRender()
			})
		request.catch(() => {})
	}

	promptAttachmentsForText(text) {
		return promptAttachmentsForText(this.promptImages, text)
	}

	promptImagesForText(text) {
		return this.promptAttachmentsForText(text).map((attachment) => attachment.image)
	}

	clearPromptImagesForText(text) {
		this.promptImages = clearPromptImageAttachmentsForText(this.promptImages, text)
	}

	clearSubmittedPrompt() {
		this.submittedPromptText = undefined
		this.submittedPromptAttachments = []
	}

	restorePromptImagesForText(text, images = []) {
		const seen = new Set()
		const placeholders = promptImagePlaceholders(text).filter((item) => {
			if (seen.has(item.placeholder)) return false
			seen.add(item.placeholder)
			return true
		})
		if (placeholders.length === 0) return
		const restored = placeholders.flatMap((item, index) => {
			const existing = this.submittedPromptAttachments.find((attachment) => attachment.placeholder === item.placeholder)
				?? this.promptImages.find((attachment) => attachment.placeholder === item.placeholder)
			const image = existing?.image ?? images[index]
			return image ? [{ placeholder: item.placeholder, image }] : []
		})
		this.promptImages = [
			...this.promptImages.filter((attachment) => !placeholders.some((item) => item.placeholder === attachment.placeholder)),
			...restored,
		]
		this.promptImageCounter = Math.max(this.promptImageCounter, ...placeholders.map((item) => item.index))
	}

	insertPromptImage(image) {
		this.promptImageCounter = insertPromptImageAttachment(this.editor, this.promptImages, this.promptImageCounter, image)
		this.tui.requestRender()
	}

	async pasteClipboardImage() {
		try {
			const image = await readClipboardImage()
			this.insertPromptImage(image)
		} catch (err) {
			this.showClipboardImagePasteNotice(err)
		}
	}

	hasPromptCancelCandidate() {
		return !!this.submittedPromptText && (this.promptRequestInFlight || this.snapshot?.isStreaming === true)
	}

	hasInterruptibleTurn() {
		return this.interruptRequested || this.promptRequestInFlight || this.snapshot?.isStreaming === true
	}

	requestEscapeInterrupt() {
		if (this.client.cancelPrompt && (this.hasPromptCancelCandidate() || this.snapshot?.isStreaming === true)) return this.requestPromptCancel()
		return this.requestInterrupt()
	}

	requestPromptCancel() {
		this.interruptRequested = true
		this.showStatusLoader("Stopping…")
		this.tui.requestRender()
		if (this.promptCancelPromise) return this.promptCancelPromise
		const fallbackText = this.submittedPromptText
		const fallbackAttachments = this.submittedPromptAttachments
		this.promptCancelPromise = this.client.cancelPrompt(this.sessionId)
			.then((res) => {
				this.settleInterruptLocally()
				if (res?.cancelled || res?.queuedCancelled || typeof res?.text === "string") {
					const text = typeof res?.text === "string" ? res.text : res?.cancelled ? fallbackText ?? "" : ""
					const fallbackImages = res?.cancelled ? fallbackAttachments.map((attachment) => attachment.image) : []
					this.restorePromptImagesForText(text, res.images ?? fallbackImages)
					this.editor.setText(text)
					if (res?.cancelled) this.clearSubmittedPrompt()
				} else if (this.snapshot?.isStreaming === false) {
					this.clearSubmittedPrompt()
				}
				this.refreshAfterMutationInBackground(res, { errorLabel: "cancel prompt refresh error" })
			})
			.catch((err) => this.reportClientError(err, "cancel prompt error"))
			.finally(() => {
				this.promptCancelPromise = undefined
				this.interruptRequested = false
				if (this.snapshot) this.renderStatus(this.snapshot)
				else this.hideStatusLoader()
				this.tui.requestRender()
			})
		this.promptCancelPromise.catch(() => {})
		return this.promptCancelPromise
	}

	requestInterrupt() {
		this.interruptRequested = true
		if (this.snapshot) this.renderStatus(this.snapshot)
		else this.showStatusLoader("Interrupting…")
		this.tui.requestRender()
		if (this.abortPromise) return this.abortPromise
		this.abortPromise = this.client.abort(this.sessionId)
			.then((res) => {
				this.settleInterruptLocally()
				this.refreshAfterMutationInBackground(res, { errorLabel: "interrupt refresh error" })
			})
			.catch((err) => this.reportClientError(err, "interrupt error"))
			.finally(() => {
				this.abortPromise = undefined
				if (this.interruptRequested && (this.promptRequestInFlight || this.snapshot?.isStreaming)) {
					this.renderStatus(this.snapshot ?? {})
					this.tui.requestRender()
					return
				}
				this.interruptRequested = false
				if (this.snapshot) this.renderStatus(this.snapshot)
				else this.hideStatusLoader()
				this.tui.requestRender()
			})
		this.abortPromise.catch(() => {})
		return this.abortPromise
	}

	appendLine(text) {
		this.chatContainer.addItem(new TextLine(text), "custom")
		this.tui.requestRender()
	}

	/** @param {{ text: string, tone: "normal" | "warn" | "error" } | undefined} status */
	setCodexUsageStatus(status) {
		this.usageStatusLine.setText(status?.text ? colorUsageStatus(status.text, status.tone) : "")
		this.usageChromeVisible = !!status?.text
		this.updateComposerGapSpacer()
		this.tui.requestRender()
	}

	updateComposerGapSpacer() {
		const lines = this.statusChromeVisible || this.pendingChromeVisible || this.usageChromeVisible ? 2 : 3
		if (this.composerGapSpacer.lines !== lines) this.composerGapSpacer.setLines(lines)
	}

	appendSpacer() {
		if (this.chatContainer.children.length === 0) return
		this.chatContainer.addSeparator()
		this.tui.requestRender()
	}

	async openWeb() {
		this.appendSpacer()
		const web = await webForOpening(this.client)
		const url = webUrlForRoute(web, sessionRoute(this.sessionId, this.snapshot?.cwd))
		await openUrlInBrowser(url)
		this.appendLine(webOpenNotice(url))
	}

	/** @param {string} text @param {{ label?: string, tone?: "info" | "warn" | "error" }} [options] */
	appendChatNote(text, options = {}) {
		this.chatContainer.addItem(new CustomMessageComponent(text, {
			label: options.label ?? "note",
			tone: options.tone ?? "info",
		}), "custom")
		this.tui.requestRender()
	}

	/** @param {string} text @param {"info" | "warn" | "error"} [tone] */
	appendOverviewNote(text, tone = "info") {
		this.appendChatNote(text, { label: "overview", tone })
	}

	/**
	 * @param {ReadonlyArray<any>} messages
	 * @param {{ reset?: boolean, requestRender?: boolean }} [options]
	 */
	announceContextPaths(messages, options = {}) {
		if (options.reset) this.announcedContextPaths.clear()
		const paths = projectContextPathsInMessages(messages)
		const newPaths = paths.filter((path) => !this.announcedContextPaths.has(path))
		if (newPaths.length === 0) return
		const collapseGroupId = this.ensureTranscriptWorkGroupId()
		for (const path of newPaths) {
			this.announcedContextPaths.add(path)
			this.chatContainer.addItem(new ContextLoadComponent({ files: [{ path }] }), "custom", { collapseGroupId })
		}
		if (options.requestRender !== false) this.tui.requestRender()
	}

	async showModal(title, body, opts = {}) {
		await showTextModal(this.tui, title, body, opts)
	}

	showSelector(create, opts = {}) {
		if (opts.fullscreen) {
			let handle
			const done = () => {
				handle?.hide()
				this.tui.setFocus(this.editor)
				this.tui.requestRender()
			}
			const { component } = create(done)
			handle = this.tui.showOverlay(component, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				row: 0,
				col: 0,
				margin: 0,
			})
			this.tui.setFocus(component)
			this.tui.requestRender()
			return
		}

		const done = () => {
			this.editorContainer.clear()
			this.editorContainer.addChild(this.editor)
			this.tui.setFocus(this.editor)
			this.tui.requestRender()
		}
		const { component, focus } = create(done)
		this.editorContainer.clear()
		this.editorContainer.addChild(component)
		this.tui.setFocus(focus)
		this.tui.requestRender()
	}

	/**
	 * @param {any} target
	 * @param {string} [sessionId]
	 */
	async handleRewindTarget(target, sessionId = this.sessionId) {
		if (sessionId !== this.sessionId) return
		if (target.kind === "leaf") {
			const res = await this.client.rewind(sessionId, target.id, { targetKind: "leaf" })
			await this.refreshAfterMutation(res)
			this.appendSpacer()
			this.appendLine(theme.dim(target.active ? "already on that branch tip" : "switched to branch tip"))
			return
		}

		const actionItems = rewindPromptActionItems(target)
		const mode = await pickInline(this, actionItems, { title: "What should happen from here?", descriptionMode: "selected" }) ?? ""
		if (!mode) return
		if (sessionId !== this.sessionId) return
		if (mode === "branch") {
			const sourceSessionId = sessionId
			const branched = await this.client.branchSession(sourceSessionId, { entryId: target.id, restoreDraft: true })
			this.setSessionId(branched.sessionId, { routeHistory: "record" })
			await this.refreshAfterMutation(branched, { sessionId: branched.sessionId, replace: true })
			this.appendSpacer()
			this.appendLine(theme.dim(`branched into ${branched.sessionId.slice(0, 8)}; prompt restored in editor`))
			this.appendLine(theme.dim(`open previous branch: ${sessionOpenCommand(sourceSessionId)}`))
			return
		}

		const restoreConversation = mode !== "files"
		const restoreFiles = mode === "files" || mode === "files-conversation"
		const rewind = async () => {
			const res = await this.client.rewind(sessionId, target.id, {
				summary: mode === "conversation-summary",
				restoreFiles,
				restoreConversation,
			})
			await this.refreshAfterMutation(res)
			return res
		}
		const res = mode === "conversation-summary"
			? await this.withStatusLoader("Summarizing branch…", rewind)
			: await rewind()
		if (restoreConversation) this.editor.setText(res.text ?? "")
		this.appendSpacer()
		const message = restoreConversation
			? `rewound${mode === "conversation-summary" ? " with branch summary" : ""}; prompt restored in editor — edit and press Enter`
			: "restored files"
		this.appendLine(theme.dim(message))
	}

	/** @param {any} msg */
	async openTranscriptMessageActions(msg) {
		if (msg?.role !== "user" || !msg.entryId) return
		const sessionId = this.sessionId
		const targets = await this.client.rewindTargets(sessionId)
		if (sessionId !== this.sessionId) return
		const target = targets.find((item) => item.kind === "message" && item.id === msg.entryId)
		if (!target) {
			this.appendLine(theme.red("rewind target not found"))
			return
		}
		await this.handleRewindTarget(target, sessionId)
	}

	/**
	 * @param {any} msg
	 * @param {import("../../../tui/tui.js").TuiMouseEvent} event
	 */
	handleTranscriptMessageContextMenu(msg, event) {
		if (msg?.role !== "user" || !msg.entryId) return { consume: false }
		event.preventDefault()
		void this.openTranscriptMessageActions(msg).catch((err) => this.reportClientError(err, "transcript action error"))
		return { consume: true }
	}

	/** @param {string} commandLine */
	async handleSlash(commandLine) {
		const [name, ...rest] = commandLine.trim().split(/\s+/)
		const arg = rest.join(" ").trim()
		if (name === "help") {
			await this.showModal("Commands", commandHelpBody(serviceChatCommandsForModel(this.snapshot?.model, { web: this.webEnabled }), ["", "!cmd / !!cmd  run shell commands"]))
			return
		}
		if (name === "hotkeys") {
			await this.showModal("Hotkeys", [
				"Enter         submit prompt",
				"Shift+Enter   newline in prompt",
				"Ctrl+C        exit this frontend without stopping service sessions",
				"Left          return to agents overview when the editor is empty",
				"Ctrl+G        return to agents overview",
				"Esc           interrupt a running turn",
				"Esc Esc       open the rewind picker",
				"Tab           accept autocomplete suggestion",
			].join("\n"))
			return
		}
		if (name === "web") {
			if (!this.webEnabled) {
				this.appendLine(theme.dim(`${WEB_BROWSER_UI_NAME} is disabled; set web: true in settings.json to enable /web.`))
				return
			}
			await this.openWeb()
			return
		}
		if (name === "abort") {
			await this.refreshAfterMutation(await this.client.abort(this.sessionId))
			return
		}
		if (name === "agent") {
			const [subCommand = "", ...subRest] = arg.split(/\s+/).filter(Boolean)
			if (!arg) {
				this.appendLine(theme.dim("usage: /agent [--name name] [--fork-turns all|none|N] <task>"))
				this.appendLine(theme.dim("       /agent list | /agent wait <name-or-id> | /agent resume <name-or-id> | /agent close <name-or-id>"))
				return
			}
			if (subCommand === "list") {
				const listed = await this.client.subSessions(this.sessionId, { includeClosed: true })
				this.appendSpacer()
				for (const line of subSessionLines(listed.agents)) this.appendLine(theme.dim(line))
				return
			}
			if (subCommand === "wait") {
				const selector = subRest.join(" ").trim()
				if (!selector) {
					this.appendLine(theme.dim("usage: /agent wait <name-or-id>"))
					return
				}
				const waited = await this.withStatusLoader(`Waiting for ${selector}…`, () => this.client.waitSubSession(this.sessionId, { agent: selector }))
				await this.refreshAfterMutation(waited, { sessionId: this.sessionId })
				this.appendSpacer()
				this.appendLine(theme.dim(`sub-agent ${waited.subSession.name}: ${waited.subSession.status}`))
				this.appendLine(theme.dim(waited.subSession.openCommand || sessionOpenCommand(waited.subSession.childSessionId)))
				if (waited.subSession.latestAssistantText) this.appendLine(waited.subSession.latestAssistantText)
				return
			}
			if (subCommand === "resume") {
				const selector = subRest.join(" ").trim()
				if (!selector) {
					this.appendLine(theme.dim("usage: /agent resume <name-or-id>"))
					return
				}
				const resumed = await this.client.resumeSubSession(this.sessionId, { agent: selector })
				await this.refreshAfterMutation(resumed, { sessionId: this.sessionId })
				this.appendSpacer()
				this.appendLine(theme.dim(`resumed sub-agent ${resumed.subSession.name}`))
				this.appendLine(theme.dim(resumed.subSession.openCommand || sessionOpenCommand(resumed.subSession.childSessionId)))
				return
			}
			if (subCommand === "close") {
				const selector = subRest.join(" ").trim()
				if (!selector) {
					this.appendLine(theme.dim("usage: /agent close <name-or-id>"))
					return
				}
				const closed = await this.client.closeSubSession(this.sessionId, { agent: selector, reason: "closed by user" })
				await this.refreshAfterMutation(closed, { sessionId: this.sessionId })
				this.appendSpacer()
				this.appendLine(theme.dim(`closed sub-agent ${closed.subSession.name}`))
				return
			}
			const spawned = await this.client.spawnSubSession(this.sessionId, { ...parseAgentSpawnArgs(arg), origin: "user" })
			await this.refreshAfterMutation(spawned, { sessionId: this.sessionId })
			this.appendSpacer()
			this.appendLine(theme.dim(`spawned sub-agent ${spawned.subSession.name} (${spawned.subSession.childSessionId.slice(0, 8)})`))
			this.appendLine(theme.dim(spawned.subSession.openCommand || sessionOpenCommand(spawned.subSession.childSessionId)))
			return
		}
		if (name === "continue") {
			try {
				const res = await this.client.continueRun(this.sessionId)
				await this.refreshAfterMutation(res)
			} catch (err) {
				if ((err?.message ?? String(err)) === "Cannot continue: assistant_complete") {
					this.appendLine(theme.dim("nothing to resume; sending 'continue' as a prompt"))
					this.sendPrompt("continue")
					return
				}
				throw err
			}
			return
		}
		if (name === "session") {
			const worktrees = this.client.worktrees ? await this.client.worktrees(this.sessionId) : []
			await this.showModal("Session", sessionInfoBody(this.snapshot, this.sessionId, worktrees))
			return
		}
		if (name === "branch") {
			const sourceSessionId = this.sessionId
			const branched = await this.client.branchSession(sourceSessionId)
			this.setSessionId(branched.sessionId, { routeHistory: "record" })
			await this.refreshAfterMutation(branched, { sessionId: branched.sessionId, replace: true })
			this.appendSpacer()
			this.appendLine(theme.dim(`branched into ${branched.sessionId.slice(0, 8)}`))
			this.appendLine(theme.dim(`open previous branch: ${sessionOpenCommand(sourceSessionId)}`))
			return
		}
		if (name === "rewind") {
			if (arg) {
				this.appendLine(theme.dim("use /rewind to choose interactively"))
				return
			}
			const targets = await this.client.rewindTargets(this.sessionId)
			if (targets.length === 0) {
				this.appendLine(theme.dim("no rewind targets or branch tips yet"))
				return
			}
			const initialSelectedId = [...targets].reverse().find((target) => target.onActivePath)?.id
			const chosen = await pickHistoryTarget(this, targets, {
				initialSelectedId,
				title: "Rewind or switch branches",
				subtitle: REWIND_PICKER_SUBTITLE,
			})
			if (!chosen) return
			const match = targets.find((target) => target.id === chosen)
			if (!match) {
				this.appendLine(theme.red("rewind target not found"))
				return
			}
			await this.handleRewindTarget(match)
			return
		}
		if (name === "model") {
			if (arg) {
				this.appendLine(theme.dim("use /model to choose interactively"))
				return
			}
			const response = await this.client.sessionModels(this.sessionId)
			if (response.models.length === 0) {
				this.appendLine(theme.dim("no eligible authenticated models available for this session"))
				return
			}
			const rows = rowsForModels(response.models, { currentId: response.currentModel })
			const chosen = await pickModel(this, rows, {
				initialSelectedValue: response.currentModel,
				title: "Session model",
				subtitle: "Same provider and at least the current context window.",
			}) ?? ""
			if (!chosen) return
			const result = await this.client.setModel(this.sessionId, chosen)
			await this.refreshAfterMutation(result)
			this.appendLine(theme.dim(`session model → ${chosen}`))
			return
		}
		if (name === "reasoning") {
			if (arg) {
				this.appendLine(theme.dim(`use /reasoning to choose interactively; reasoning=${reasoningLevelLabel(this.snapshot?.thinkingLevel)}`))
				return
			}
			const level = await pickReasoningLevel(this.tui, "Session reasoning", "Applied only to this session") ?? undefined
			if (!level) return
			const res = await this.client.setReasoning(this.sessionId, level)
			await this.refreshAfterMutation(res)
			this.appendLine(theme.dim(`session reasoning → ${level}`))
			return
		}
		if (name === "fast") {
			const res = await this.client.setFast(this.sessionId, arg)
			await this.refreshAfterMutation(res)
			if (res.message) this.appendLine(theme.dim(res.message))
			return
		}
		if (name === "compact") {
			const res = await this.withStatusLoader("Compacting…", async () => {
				const compacted = await this.client.compact(this.sessionId)
				await this.refreshAfterMutation(compacted)
				return compacted
			})
			if (res.result?.removedCount === 0) this.appendLine(theme.dim("nothing to compact yet"))
			return
		}
		if (name === "context") {
			const lines = this.client.contextReport
				? await this.client.contextReport(this.sessionId)
				: formatContextReport({
					messages: this.snapshot?.contextMessages ?? this.snapshot?.messages ?? [],
					systemPrompt: this.snapshot?.systemPrompt ?? "",
					tools: this.snapshot?.tools ?? [],
					model: this.snapshot?.model,
				})
			await this.showModal("Context", lines.join("\n"))
			return
		}
		if (name === "system") {
			const lines = this.client.systemReport
				? await this.client.systemReport(this.sessionId)
				: formatSystemReport({
					systemPrompt: this.snapshot?.systemPrompt ?? "",
					tools: this.snapshot?.tools ?? [],
					messages: this.snapshot?.contextMessages ?? this.snapshot?.messages ?? [],
				})
			await this.showModal("System prompt, tools, and project context", lines.join("\n"))
			return
		}
		if (name === "usage") {
			await showCodexUsageModal(this.tui, this.getCodexUsageBaseUrl?.(this.snapshot?.model), (payload) => this.onCodexUsage?.(payload))
			return
		}
		if (name === "settings" && !arg) {
			await showSettingsEditor(this, {
				notify: (message) => this.appendLine(theme.dim(message)),
				onSettingsChanged: (settings) => {
					this.webEnabled = settings.web === true
					this.messageRenderOptions = messageRenderOptionsFromSettings(settings)
					this.onSettingsChanged?.(settings)
					if (this.snapshot) this.update(this.snapshot, { rebuildTranscript: true })
				},
				setDefaultModel: async (model) => (await this.client.setDefaultModel?.(model))?.settings ?? updateDefaultModel(model),
				setDefaultReasoning: async (level) => (await this.client.setDefaultReasoning?.(level))?.settings ?? updateSetting("thinkingLevel", /** @type {any} */ (level)),
				refreshAuthCache: () => this.refreshAuthCache(),
			})
			return
		}
		if (name === "reload") {
			await reloadUiSettingsAndAuth({
				notify: (message) => this.appendLine(theme.dim(message)),
				onSettingsChanged: (settings) => {
					this.webEnabled = settings.web === true
					this.messageRenderOptions = messageRenderOptionsFromSettings(settings)
					this.onSettingsChanged?.(settings)
				},
				refreshAuthCache: async () => {
					await this.refreshAuthCache()
					await this.refreshGlobalAuth?.()
				},
			})
			return
		}
		this.appendLine(theme.red(`unknown service-chat command: /${name}`))
	}

	/** @param {any} msg */
	hasRenderedMessage(msg) {
		const key = transcriptMessageKey(msg)
		return this.renderedMessageKeys.includes(key)
	}

	/** @param {any} msg */
	rememberRenderedMessage(msg) {
		const key = transcriptMessageKey(msg)
		this.renderedMessageKeys.push(key)
		this.renderedMessageFingerprints.push(transcriptMessageFingerprint(msg))
	}

	/**
	 * @param {any} msg
	 * @param {{ seq?: number, viewEpoch?: number } | undefined} cursor
	 */
	rememberMessageCursor(msg, cursor) {
		if (!cursor) return
		this.messageEventCursors.set(transcriptMessageKey(msg), cursor)
	}

	/** @param {any} msg */
	beginTranscriptTurn(msg) {
		this.transcriptTurnIndex += 1
		this.currentTranscriptWorkGroupId = `turn:${this.transcriptTurnIndex}:${transcriptMessageKey(msg)}`
		this.chatContainer.setActiveCollapseGroup(this.currentTranscriptWorkGroupId)
		return this.currentTranscriptWorkGroupId
	}

	ensureTranscriptWorkGroupId() {
		if (!this.currentTranscriptWorkGroupId) {
			this.transcriptTurnIndex += 1
			this.currentTranscriptWorkGroupId = `turn:${this.transcriptTurnIndex}:prelude`
			this.chatContainer.setActiveCollapseGroup(this.currentTranscriptWorkGroupId)
		}
		return this.currentTranscriptWorkGroupId
	}

	/**
	 * @param {any} msg
	 * @param {string} [collapseGroupId]
	 */
	appendAssistantMessage(msg, collapseGroupId) {
		if (msg.compaction === true) {
			const c = new AssistantMessageComponent(msg, this.messageRenderOptions)
			if (c.hasContent()) {
				const activeGroupId = collapseGroupId ?? this.currentTranscriptWorkGroupId
				this.chatContainer.addItem(c, "assistant", activeGroupId ? { collapseGroupId: activeGroupId, collapseItemKind: "compaction" } : {})
			}
			return
		}
		if (!collapseGroupId) collapseGroupId = this.ensureTranscriptWorkGroupId()

		const progress = new AssistantMessageComponent(msg, {
			...this.messageRenderOptions,
			assistantTextMode: "progress",
		})
		if (progress.hasContent()) this.chatContainer.addItem(progress, "assistant", { collapseGroupId, collapseTailAnchor: true })
		this.appendToolCallsForMessage(msg, collapseGroupId)

		const finalAnswer = new AssistantMessageComponent(msg, {
			...this.messageRenderOptions,
			assistantTextMode: "final",
		})
		if (finalAnswer.hasContent()) {
			this.chatContainer.addItem(finalAnswer, "assistant", { completesCollapseGroupId: collapseGroupId })
			if (this.currentTranscriptWorkGroupId === collapseGroupId) this.currentTranscriptWorkGroupId = undefined
		}
	}

	/**
	 * @param {any} msg
	 * @param {{ requestRender?: boolean, remember?: boolean, cursor?: { seq?: number, viewEpoch?: number } }} [options]
	 * @returns {boolean}
	 */
	appendMessage(msg, options = {}) {
		if (!isTranscriptMessageRenderable(msg)) return false
		if (isBashShortcutMessage(msg)) {
			this.beginTranscriptTurn(msg)
			this.chatContainer.addItem(new BashShortcutComponent(msg), "tool")
		} else if (msg.role === "user") {
			this.beginTranscriptTurn(msg)
			this.chatContainer.addItem(new UserMessageComponent(msg, {
				onContextMenu: (message, event) => this.handleTranscriptMessageContextMenu(message, event),
			}), "user")
		} else if (msg.role === "contextLoad") {
			this.chatContainer.addItem(new ContextLoadComponent(msg.contextLoad, flattenContent(msg.content)), "custom", {
				collapseGroupId: this.ensureTranscriptWorkGroupId(),
			})
		} else if (msg.role === PLAN_UPDATE_MESSAGE_ROLE) {
			this.chatContainer.addItem(new CustomMessageComponent(flattenContent(msg.content), { label: "plan" }), "custom", {
				collapseGroupId: this.ensureTranscriptWorkGroupId(),
			})
		} else if (msg.role === "assistant") {
			this.appendAssistantMessage(msg, msg.compaction === true ? undefined : this.ensureTranscriptWorkGroupId())
		} else if (msg.role === "toolResult") {
			const collapseGroupId = this.ensureTranscriptWorkGroupId()
			const details = msg.toolCallId ? this.toolCallDetails.get(msg.toolCallId) : undefined
			const tc = msg.toolCallId
				? (this.toolComponents.get(msg.toolCallId) ?? this.ensureToolComponent(msg.toolCallId, msg.toolName ?? details?.name, details?.args, collapseGroupId))
				: undefined
			if (tc) {
				tc.setResult(flattenContent(msg.content), !!msg.isError, msg)
				this.toolComponents.delete(msg.toolCallId)
				this.toolCallDetails.delete(msg.toolCallId)
			} else {
				this.chatContainer.addItem(new CustomMessageComponent(flattenContent(msg.content), {
					label: msg.toolName ?? "tool",
					tone: msg.isError ? "error" : "info",
				}), "custom", { collapseGroupId })
			}
		} else {
			this.chatContainer.addItem(new CustomMessageComponent(flattenContent(msg.content), { label: msg.role }), "custom")
		}
		if (msg.role === "toolResult") this.announceContextPaths([msg], { requestRender: false })
		if (options.remember !== false) {
			this.rememberRenderedMessage(msg)
			this.rememberMessageCursor(msg, options.cursor)
		}
		if (options.requestRender !== false) this.tui.requestRender()
		return true
	}

	/**
	 * @param {any} msg
	 * @param {{ seq?: number, viewEpoch?: number } | undefined} [cursor]
	 */
	upgradeRenderedMessageKey(msg, cursor = undefined) {
		if (!msg?.entryId || !msg?.messageId) return false
		const provisional = `message:${msg.messageId}`
		const idx = this.renderedMessageKeys.indexOf(provisional)
		if (idx < 0) return false
		const nextKey = transcriptMessageKey(msg)
		const previousCursor = this.messageEventCursors.get(provisional)
		this.renderedMessageKeys[idx] = nextKey
		this.messageEventCursors.delete(provisional)
		if (cursor || previousCursor) this.messageEventCursors.set(nextKey, cursor ?? previousCursor)
		return true
	}

	/**
	 * @param {any} msg
	 * @param {{ cursor?: { seq?: number, viewEpoch?: number } }} [options]
	 */
	appendMessageOnce(msg, options = {}) {
		if (this.hasRenderedMessage(msg)) {
			this.rememberMessageCursor(msg, options.cursor)
			return
		}
		if (this.upgradeRenderedMessageKey(msg, options.cursor)) return
		this.appendMessage(msg, { cursor: options.cursor })
	}

	ensureToolComponent(id, name, args, collapseGroupId = this.ensureTranscriptWorkGroupId()) {
		if (!id) return undefined
		let tc = this.toolComponents.get(id)
		if (tc) {
			if (args !== undefined) tc.updateArgs(args)
			return tc
		}
		tc = new ToolExecutionComponent(name ?? "tool", args ?? {}, this.messageRenderOptions, { toolCallId: id })
		this.toolComponents.set(id, tc)
		this.chatContainer.addItem(tc, "tool", { collapseGroupId })
		return tc
	}

	/** @param {any} msg */
	appendToolCallsForMessage(msg, collapseGroupId = this.ensureTranscriptWorkGroupId()) {
		const blocks = Array.isArray(msg.content) ? msg.content : []
		const toolCalls = blocks.filter((b) => b.type === "toolCall")
		for (const b of toolCalls) this.ensureToolComponent(b.id, b.name, b.input ?? b.arguments, collapseGroupId)
	}

	/**
	 * @param {any} msg
	 * @param {{ requestRender?: boolean }} [options]
	 * @returns {boolean}
	 */
	startStreamingAssistant(msg, options = {}) {
		if (!isTranscriptMessageRenderable(msg)) return false
		if (this.streamingAssistant) this.streamingAssistant.update(msg, { streaming: true })
		else {
			this.streamingAssistant = new AssistantMessageComponent(msg, this.messageRenderOptions, { streaming: true })
			this.chatContainer.addItem(this.streamingAssistant, "assistant")
		}
		if (options.requestRender !== false) this.tui.requestRender()
		return true
	}

	renderedTranscriptState() {
		const messages = this.renderedMessageKeys.map((key, index) => ({
			key,
			fingerprint: this.renderedMessageFingerprints[index] ?? "",
		}))
		const streamingMessage = this.streamingAssistant?.message
			? transcriptMessageState(this.streamingAssistant.message)
			: null
		return { messages, streamingMessage }
	}

	/** @param {any} snapshot */
	snapshotMatchesRenderedTranscript(snapshot) {
		return transcriptStatesEqual(this.renderedTranscriptState(), transcriptStateFromSnapshot(snapshot))
	}

	/** @param {any} snapshot */
	rebuildTranscriptFromSnapshot(snapshot) {
		const cursor = transcriptCursor(snapshot)
		this.chatContainer.clear()
		this.toolComponents.clear()
		this.toolCallDetails.clear()
		this.announcedContextPaths.clear()
		this.streamingAssistant = undefined
		this.renderedMessageKeys = []
		this.renderedMessageFingerprints = []
		this.messageEventCursors.clear()
		this.transcriptTurnIndex = 0
		this.currentTranscriptWorkGroupId = undefined
		for (const msg of snapshot?.messages ?? []) this.appendMessage(msg, { requestRender: false, cursor })
		if (snapshot?.streamingMessage?.role === "assistant") this.startStreamingAssistant(snapshot.streamingMessage, { requestRender: false })
	}

	/**
	 * @param {any} snapshot
	 * @param {{ force?: boolean }} [options]
	 * @returns {boolean}
	 */
	syncTranscript(snapshot, options = {}) {
		if (!options.force && this.snapshotMatchesRenderedTranscript(snapshot)) return false
		this.rebuildTranscriptFromSnapshot(snapshot)
		this.tui.requestRender()
		return true
	}

	/** @param {string} message */
	showStatusLoader(message) {
		this.statusChromeVisible = true
		this.updateComposerGapSpacer()
		if (this.statusLoader) {
			this.statusLoader.setMessage(message)
			return
		}
		this.statusContainer.clear()
		this.statusLoader = new Loader(this.tui, theme.cyan, theme.dim, message)
		this.statusContainer.addChild(this.statusLoader)
	}

	hideStatusLoader() {
		if (this.statusLoader) {
			this.statusLoader.stop()
			this.statusLoader = undefined
		}
		this.statusContainer.clear()
		this.statusChromeVisible = false
		this.updateComposerGapSpacer()
	}

	clearTransientStatusNoticeTimer() {
		if (this.transientStatusNoticeTimer) clearTimeout(this.transientStatusNoticeTimer)
		this.transientStatusNoticeTimer = undefined
	}

	clearTransientStatusNotice() {
		this.clearTransientStatusNoticeTimer()
		if (this.snapshot) this.renderStatus(this.snapshot)
		else {
			this.statusContainer.clear()
			this.statusChromeVisible = false
			this.updateComposerGapSpacer()
		}
		this.tui.requestRender()
	}

	/** @param {unknown} err */
	showClipboardImagePasteNotice(err) {
		const notice = clipboardImagePasteNotice(err)
		if (!notice) return
		this.clearTransientStatusNoticeTimer()
		this.hideStatusLoader()
		this.statusContainer.addChild(new TextLine(theme.yellow(notice)))
		this.statusChromeVisible = true
		this.updateComposerGapSpacer()
		this.transientStatusNoticeTimer = setTimeout(() => this.clearTransientStatusNotice(), CLIPBOARD_IMAGE_NOTICE_MS)
		this.transientStatusNoticeTimer.unref?.()
		this.tui.requestRender()
	}

	stopStatusAgeTimer() {
		if (!this.statusAgeTimer) return
		clearInterval(this.statusAgeTimer)
		this.statusAgeTimer = undefined
	}

	updateStatusAgeTimer(snapshot) {
		if (snapshot?.isStreaming) {
			if (!this.statusAgeTimer) {
				this.statusAgeTimer = setInterval(() => {
					if (this.snapshot) this.renderStatus(this.snapshot)
				}, 1000)
			}
			return
		}
		this.stopStatusAgeTimer()
	}

	/** @param {any} snapshot */
	ensureStatusRunStart(snapshot) {
		if (!snapshot?.isStreaming) {
			this.statusRunStartedAt = undefined
			return undefined
		}
		if (!this.statusRunStartedAt) this.statusRunStartedAt = new Date().toISOString()
		return this.statusRunStartedAt
	}

	/**
	 * @template T
	 * @param {string} message
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async withStatusLoader(message, fn) {
		this.showStatusLoader(message)
		this.tui.requestRender()
		try {
			return await fn()
		} finally {
			if (this.snapshot) this.renderStatus(this.snapshot)
			else this.hideStatusLoader()
			this.tui.requestRender()
		}
	}

	/** @param {any} snapshot */
	streamingProgressMessage(snapshot) {
		const request = snapshot.currentModelRequest
		const requestKey = request?.startedAt || "no-request"
		const message = snapshot.streamingMessage?.role === "assistant" ? snapshot.streamingMessage : null
		if (!message) {
			this.statusProgress = { requestKey, chars: 0, changedAt: Date.now() }
			return request?.startedAt ? "waiting for stream" : "preparing turn"
		}
		const progress = streamingContentProgress(message)
		const now = Date.now()
		const previous = this.statusProgress
		if (!previous || previous.requestKey !== requestKey || previous.chars !== progress.chars) {
			this.statusProgress = { requestKey, chars: progress.chars, changedAt: now }
		}
		const unchangedMs = now - (this.statusProgress?.changedAt ?? now)
		const parts = [`${formatCount(progress.chars)} chars`]
		if (unchangedMs >= 2000) parts.push(`unchanged ${elapsedDuration(unchangedMs)}`)
		return parts.join(" · ")
	}

	/** @param {any} snapshot */
	streamingStatusMessage(snapshot) {
		const pendingDetails = snapshot.pendingToolCallDetails ?? []
		const pending = pendingDetails.length || snapshot.pendingToolCalls?.length || snapshot.pendingToolCalls?.size || 0
		if (pending) {
			const tools = pendingDetails.map((t) => t.name).filter(Boolean).join(", ")
			return `Running tool${pending === 1 ? "" : "s"}${tools ? `: ${tools}` : ""}…`
		}
		const base = snapshot.streamingMessage?.role === "assistant"
			? streamingStatusBase(snapshot.streamingMessage)
			: "Thinking…"
		const request = snapshot.currentModelRequest
		const age = elapsedAge(request?.startedAt || this.ensureStatusRunStart(snapshot))
		const progress = this.streamingProgressMessage(snapshot)
		return `${base}${age ? ` ${age}` : ""}${progress ? ` · ${progress}` : ""}`
	}

	/** @param {any} snapshot */
	renderPendingUserMessages(snapshot) {
		const pending = (snapshot?.pendingUserMessages ?? [])
			.map((item) => ({ behavior: item?.behavior ?? "steer", message: item?.message ?? item }))
			.filter((item) => item.message?.role === "user")
		this.pendingContainer.clear()
		if (pending.length === 0) {
			this.pendingChromeVisible = false
			this.updateComposerGapSpacer()
			return
		}
		const label = pending.length === 1 ? "Pending message" : `${pending.length} pending messages`
		const behaviorLabels = new Set(pending.map((item) => item.behavior))
		const detail = behaviorLabels.size === 1 && behaviorLabels.has("followUp")
			? "queued for after this turn"
			: "queued for the next agent step"
		this.pendingContainer.addChild(new Spacer(1))
		this.pendingContainer.addChild(new TextLine(theme.dim(`${label} — ${detail}`)))
		for (const item of pending) {
			this.pendingContainer.addChild(new Spacer(1))
			this.pendingContainer.addChild(new UserMessageComponent(item.message))
		}
		this.pendingChromeVisible = true
		this.updateComposerGapSpacer()
	}

	renderStatus(snapshot) {
		this.updateStatusAgeTimer(snapshot)
		if (this.promptCancelPromise) {
			this.showStatusLoader("Stopping…")
		} else if (this.interruptRequested && (snapshot.isStreaming || this.promptRequestInFlight || this.abortPromise)) {
			this.showStatusLoader("Interrupting…")
		} else if (snapshot.isStreaming) {
			this.showStatusLoader(this.streamingStatusMessage(snapshot))
		} else {
			this.statusProgress = undefined
			this.statusRunStartedAt = undefined
			this.hideStatusLoader()
			// Derive the banner from the *current branch's* tail message rather than session-scoped
			// run records — those don't get reset on branch navigation (rewind/switchBranchTip), so they
			// stay stale across branches. The transcript tail is the source of truth for whether the
			// branch the user is currently looking at ended cleanly.
			const messages = snapshot.messages ?? []
			const last = messages[messages.length - 1]
			let state = null
			if (last?.role === "assistant") {
				if (last.stopReason === "aborted") state = "aborted"
				else if (last.stopReason === "error" || last.errorMessage) state = "failed"
			} else if (last?.role === "toolResult" && last.isError) {
				state = /aborted/i.test(flattenContent(last.content)) ? "aborted" : null
			}
			if (state) {
				this.statusContainer.addChild(new Spacer(1))
				const message = state === "failed"
					? theme.yellow("Last run failed. Use /continue to retry/resume, or type a new message.")
					: theme.dim("Run stopped. Use /continue to resume, or type a new message.")
				this.statusContainer.addChild(new TextLine(message))
				this.statusChromeVisible = true
				this.updateComposerGapSpacer()
			}
		}
	}

	refreshFooter() {
		this.footerAgent.state = agentAdapterForSnapshot(this.snapshot).state
		this.footer.update()
	}

	/**
	 * @param {any} snapshot
	 * @param {{ rebuildTranscript?: boolean }} [options]
	 */
	update(snapshot, options = {}) {
		const next = cloneSessionSnapshot(snapshot)
		const previousSessionId = this.snapshot?.sessionId
		const firstSnapshot = !previousSessionId
		const sessionChanged = !!previousSessionId && !!next.sessionId && next.sessionId !== previousSessionId
		const cursorGenerationChanged = !sessionChanged && !!this.snapshot && sessionCursorGenerationChanged(this.snapshot, next)
		if (next.sessionId) this.setSessionId(next.sessionId)
		if (sessionChanged) this.retiredCursorGenerations.clear()
		else if (cursorGenerationChanged) this.retiredCursorGenerations.add(sessionCursorGeneration(this.snapshot))
		if (sessionChanged || cursorGenerationChanged) {
			this.lastSeq = -1
			this.viewEpoch = undefined
			this.needsSnapshotRebuild = false
			this.needsBranchSnapshotRebuild = false
			this.messageEventCursors.clear()
		}
		if (sessionChanged) {
			this.lastPromptDraftVersion = -1
			this.promptImages = []
			this.promptImageCounter = 0
			this.clearSubmittedPrompt()
			this.clearSessionWorktrees()
		}
		this.snapshot = next
		if (next.promptDraft) this.applyPromptDraft(next.promptDraft, { force: firstSnapshot || sessionChanged })
		if (!next.isStreaming && !this.promptRequestInFlight) this.interruptRequested = false
		if (!next.isStreaming && !this.promptRequestInFlight && !this.promptCancelPromise) this.clearSubmittedPrompt()
		if (typeof next.seq === "number") this.lastSeq = sessionChanged || cursorGenerationChanged ? next.seq : Math.max(this.lastSeq, next.seq)
		if (next.viewEpoch !== undefined) this.viewEpoch = next.viewEpoch
		this.syncTranscript(next, { force: options.rebuildTranscript === true || sessionChanged || cursorGenerationChanged })
		this.renderStatus(next)
		this.renderPendingUserMessages(next)
		this.refreshFooter()
		void this.refreshSessionWorktrees({ force: firstSnapshot || sessionChanged })
		this.tui.requestRender()
	}

	/** @param {any} snapshot */
	updateFromEventSnapshot(snapshot) {
		if (
			this.snapshot?.sessionId === snapshot?.sessionId
			&& this.retiredCursorGenerations.has(sessionCursorGeneration(snapshot))
		) return
		const cursorGenerationChanged = !!this.snapshot && sessionCursorGenerationChanged(this.snapshot, snapshot)
		const rebuildTranscript = this.needsSnapshotRebuild
		const branchSnapshotRebuild = this.needsBranchSnapshotRebuild
		this.needsSnapshotRebuild = false
		this.needsBranchSnapshotRebuild = false
		const restoreSnapshotRebuild = () => {
			this.needsSnapshotRebuild = true
			this.needsBranchSnapshotRebuild = branchSnapshotRebuild
		}
		if (!cursorGenerationChanged && typeof snapshot?.seq === "number" && snapshot.seq < this.lastSeq) {
			const matchesCurrentTranscript = this.snapshot && transcriptStatesEqual(transcriptStateFromSnapshot(snapshot), transcriptStateFromSnapshot(this.snapshot))
			if (matchesCurrentTranscript) {
				this.syncTranscript(snapshot, { force: rebuildTranscript })
				if (rebuildTranscript && !branchSnapshotRebuild) restoreSnapshotRebuild()
			}
			else if (
				this.snapshot
				&& (!snapshot.sessionId || !this.snapshot.sessionId || snapshot.sessionId === this.snapshot.sessionId)
				&& (snapshot.viewEpoch === undefined || this.viewEpoch === undefined || snapshot.viewEpoch === this.viewEpoch)
			) {
				const merged = mergeStaleSnapshotMessages(this.snapshot, snapshot, this.messageEventCursors)
				if (merged) {
					this.snapshot = merged
					this.syncTranscript(merged, { force: rebuildTranscript })
					this.renderStatus(merged)
					this.renderPendingUserMessages(merged)
					this.refreshFooter()
					this.tui.requestRender()
					if (rebuildTranscript && !branchSnapshotRebuild) restoreSnapshotRebuild()
				} else if (rebuildTranscript) {
					if (branchSnapshotRebuild) this.syncTranscript(this.snapshot, { force: true })
					else restoreSnapshotRebuild()
				}
			} else if (rebuildTranscript) restoreSnapshotRebuild()
			return
		}
		this.update(snapshot, { rebuildTranscript: rebuildTranscript || cursorGenerationChanged })
	}

	async refreshAfterMutation(result = {}, options = {}) {
		const id = this.mutationSnapshotSessionId(result, options)
		if (!id || !this.client.snapshot) {
			if (result?.snapshot) this.updateFromEventSnapshot(result.snapshot)
			return result?.snapshot
		}
		const snapshot = await this.client.snapshot(id)
		if (options.replace === true || snapshot.sessionId !== this.snapshot?.sessionId) this.update(snapshot)
		else this.updateFromEventSnapshot(snapshot)
		return snapshot
	}

	mutationSnapshotSessionId(result = {}, options = {}) {
		return options.sessionId ?? result?.sessionId ?? result?.snapshot?.sessionId ?? this.sessionId
	}

	refreshAfterMutationInBackground(result = {}, options = {}) {
		const id = this.mutationSnapshotSessionId(result, options)
		const sessionIdAtStart = this.sessionId
		if (!id || !this.client.snapshot) {
			if (result?.snapshot && !this.disposed && this.sessionId === sessionIdAtStart) this.updateFromEventSnapshot(result.snapshot)
			return undefined
		}
		const key = `${id}:${options.replace === true ? "replace" : "update"}`
		const promise = this.client.snapshot(id)
			.then((snapshot) => {
				if (this.disposed || this.sessionId !== sessionIdAtStart) return snapshot
				if (options.replace === true || snapshot.sessionId !== this.snapshot?.sessionId) this.update(snapshot)
				else this.updateFromEventSnapshot(snapshot)
				return snapshot
			})
			.catch((err) => {
				if (isTransientServiceTransportError(err)) return
				if (!this.disposed && this.sessionId === sessionIdAtStart) this.reportClientError(err, options.errorLabel ?? "snapshot refresh error")
			})
			.finally(() => {
				if (this.backgroundMutationRefreshes.get(key) === promise) this.backgroundMutationRefreshes.delete(key)
			})
		this.backgroundMutationRefreshes.set(key, promise)
		promise.catch(() => {})
		return promise
	}

	settleInterruptLocally() {
		if (!this.snapshot) {
			this.hideStatusLoader()
			this.tui.requestRender()
			return
		}
		this.snapshot = cloneSessionSnapshot({
			...this.snapshot,
			isStreaming: false,
			currentModelRequest: undefined,
			pendingToolCalls: [],
			pendingToolCallDetails: [],
			streamingMessage: null,
		})
		this.syncTranscript(this.snapshot)
		this.renderStatus(this.snapshot)
		this.renderPendingUserMessages(this.snapshot)
		this.refreshFooter()
		this.tui.requestRender()
	}

	/** @param {any} event */
	handleEvent(event) {
		if (event.sessionId && event.sessionId !== this.sessionId) return
		if (event.type === "session_activity") return
		if (this.snapshot && sessionCursorGenerationChanged(this.snapshot, event)) {
			this.needsSnapshotRebuild = true
			this.needsBranchSnapshotRebuild = false
			return
		}
		if (typeof event.seq === "number" && event.seq <= this.lastSeq) return
		if (this.viewEpoch !== undefined && event.viewEpoch !== undefined && event.viewEpoch < this.viewEpoch) return
		const next = applySessionEvent(this.snapshot, event)
		const eventCursor = transcriptCursor(event)
		let nextNeedsSnapshotRebuild = this.needsSnapshotRebuild
		let nextNeedsBranchSnapshotRebuild = this.needsBranchSnapshotRebuild
		if (this.viewEpoch !== undefined && event.viewEpoch !== undefined && event.viewEpoch > this.viewEpoch) {
			nextNeedsSnapshotRebuild = true
			nextNeedsBranchSnapshotRebuild = true
		}
		try {
			switch (event.type) {
				case "agent_start":
					this.renderStatus(next)
					break
				case "message_start":
					if (event.message?.role === "assistant") {
						this.startStreamingAssistant(event.message)
						this.renderStatus(next)
					} else if (event.message?.role === "user") this.appendMessageOnce(event.message, { cursor: eventCursor })
					break
				case "message_update":
					if (event.message?.role === "assistant") {
						if (this.streamingAssistant) this.streamingAssistant.update(event.message, { streaming: true })
						else this.startStreamingAssistant(event.message, { requestRender: false })
						this.renderStatus(next)
						this.tui.requestRender()
					}
					break
				case "message_end":
					if (event.message?.role === "assistant") {
						if (this.streamingAssistant) {
							this.chatContainer.removeChild(this.streamingAssistant)
							this.streamingAssistant = undefined
							this.appendMessage(event.message, { requestRender: false, remember: false })
							if (!this.upgradeRenderedMessageKey(event.message, eventCursor) && !this.hasRenderedMessage(event.message)) {
								this.rememberRenderedMessage(event.message)
								this.rememberMessageCursor(event.message, eventCursor)
							}
							this.tui.requestRender()
						} else this.appendMessageOnce(event.message, { cursor: eventCursor })
						this.renderStatus(next)
					} else if (event.message) this.appendMessageOnce(event.message, { cursor: eventCursor })
					break
				case "tool_execution_start":
					if (event.toolCallId) this.toolCallDetails.set(event.toolCallId, { name: event.toolName, args: event.args })
					this.renderStatus(next)
					break
				case "tool_execution_update":
					if (event.toolCallId) this.toolCallDetails.set(event.toolCallId, { name: event.toolName, args: event.args })
					this.toolComponents.get(event.toolCallId)?.updateArgs(event.args)
					this.renderStatus(next)
					break
				case "tool_execution_end": {
					const tc = this.toolComponents.get(event.toolCallId)
					if (tc) tc.setResult(flattenContent(event.result?.content), !!event.isError, {
						role: "toolResult",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						content: event.result?.content,
						details: event.result?.details,
						isError: !!event.isError,
					})
					this.renderStatus(next)
					break
				}
				case "context_load":
					if (event.message) this.appendMessageOnce(event.message, { cursor: eventCursor })
					break
				case "plan_update":
					if (event.message) this.appendMessageOnce(event.message, { cursor: eventCursor })
					break
				case "agent_end":
					this.interruptRequested = false
					this.renderStatus(next)
					break
				case "model_retry_scheduled":
					this.appendChatNote(modelRetryScheduledText(event), { label: "model", tone: "warn" })
					break
				case "model_retry_exhausted":
					this.appendChatNote(modelRetryExhaustedText(event), { label: "model", tone: "warn" })
					break
				case "unknown_tool_recovery_scheduled":
					this.appendChatNote(`Tool outcome is unknown; continuing with recovery (${event.attempt}/${event.maxAttempts}).`, { label: "tool", tone: "warn" })
					break
				case "unknown_tool_recovery_exhausted":
					this.appendChatNote(`Tool result recovery stopped after ${event.maxAttempts} attempts.`, { label: "tool", tone: "warn" })
					break
				case "prompt_draft_update":
					this.applyPromptDraft(event.draft)
					break
				case "error":
					this.renderStatus(next)
					break
				case "compaction":
					nextNeedsSnapshotRebuild = true
					nextNeedsBranchSnapshotRebuild = false
					break
			}
			this.snapshot = next
			if (typeof event.seq === "number") this.lastSeq = event.seq
			if (event.viewEpoch !== undefined) this.viewEpoch = event.viewEpoch
			this.needsSnapshotRebuild = nextNeedsSnapshotRebuild
			this.needsBranchSnapshotRebuild = nextNeedsBranchSnapshotRebuild
			this.renderPendingUserMessages(next)
			this.refreshFooter()
			this.tui.requestRender()
		} catch (err) {
			this.needsSnapshotRebuild = true
			this.needsBranchSnapshotRebuild = false
			throw err
		}
	}
}
