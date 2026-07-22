// Service-backed agent view TUI: one screen for dispatching, monitoring,
// peeking, and opening Pinano sessions.

import { homedir } from "node:os"
import { resolve } from "node:path"

import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	LOADER_SPINNER_FRAMES,
	LOADER_SPINNER_INTERVAL_MS,
	ProcessTerminal,
	Spacer,
	TUI,
	isKeyRelease,
	matchesKey,
	showContextMenu,
} from "../../tui/index.js"
import { reasoningLevelLabel } from "../../../../protocol/src/reasoning.js"
import { pickModel, rowsForModels } from "../components/model-selector.js"
import { showTextModal } from "../components/text-modal.js"
import { hasConfiguredProviderCredentials } from "../../../../server/src/app/auth.js"
import { availableModelEntries } from "../../../../server/src/app/models.js"
import { overviewModelLabel, overviewModelStatusText } from "../../../../server/src/app/overview-model-status.js"
import { loadSettings, messageRenderOptionsFromSettings, updateSetting } from "../../../../server/src/app/settings.js"
import { showSubscriptionUsageStatusFromSettings } from "../../../../server/src/app/subscription-usage-display.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"
import { clipboardImagePasteNotice, readClipboardImage } from "../../../../server/src/app/clipboard-image.js"
import {
	codexUsageBaseUrlForModel,
	codexUsageBaseUrlFromSettings,
	codexUsageStatusTone,
	codexUsageThresholdMessages,
	fetchCodexUsage,
	formatCodexUsageInlineSummary,
	formatCodexUsageLowStatus,
} from "../../../../server/src/app/codex-usage.js"
import { editorTheme, theme } from "../theme.js"
import { eventInvalidatesSessionSnapshot, eventNeedsSessionListRefresh } from "../../../../server/src/app/session-state.js"
import { overviewRouteForCwd, routeCwd, routeSelectedSessionId, routeToArg, routeToCliArgs, sessionRoute, settingsCredentialsRoute } from "../../../../server/src/app/routes.js"
import { RouteHistory } from "../../../../server/src/app/navigation-history.js"
import { reexecRuntime, staleRuntimeReexecEnvPatch } from "../../../../server/src/app/reexec-runtime.js"
import { NativeSandboxStartupPage, nativeSandboxStartupIssue } from "../native-sandbox-onboarding.js"
import { UPDATE_CHECK_NOTICE_MS, checkForUpdateNotice } from "../../../../server/src/app/update-check.js"
import { overviewDirectoryFilterEnabled, setOverviewDirectoryFilterEnabled } from "../../../../server/src/app/ui-state.js"
import { projectInfoForCwd } from "../../../../server/src/app/project-labels.js"
import { createPresenceUpdateGate } from "../../../../server/src/app/presence-updates.js"
import { createBackgroundReconciler, DEFAULT_BACKGROUND_RECONCILE_INTERVAL_MS, sessionStatusIndicatesSnapshotStale, sessionsStatusIndicatesListStale } from "../../../../server/src/app/live/reconciliation.js"
import { OVERVIEW_WORKTREE_STATUS_CONCURRENCY, OVERVIEW_WORKTREE_STATUS_REFRESH_INTERVAL_MS, overviewWorktreeRefreshCandidates } from "../../../../server/src/app/overview-worktree-refresh.js"
import { terminalFocusPresence } from "../../tui/terminal-presence.js"


import { tuiRuntimeOptions } from "./diagnostics.js"
import { DoubleEscapeTracker, isEditorTextInput, matchesRouteBackShortcut, matchesRouteForwardShortcut, routeHistoryShortcutAllowed, sessionPageBackShortcutAllowed } from "./shortcuts.js"
import { clearPromptImageAttachmentsForText, colorUsageStatus, insertPromptImageAttachment, modelLineDivider, promptAttachmentsForText } from "./format.js"
import { flattenContent } from "./session/transcript-state.js"
import { createCurrentChatSnapshotRefresher } from "./session/snapshot-refresh.js"
import { AgentTable, isRunningAgentStateActionRejection, overviewContextMenuTheme, overviewSessionContextMenuItems, selectedAgentStateActionTask } from "./overview/session-table.js"
import { commandHelpBody, isWebSlashCommand, overviewCommandLine, overviewCommands, showCodexUsageModal, showDebugLogModal, webForOpening, webUrlForRoute } from "./slash-commands.js"
import { openUrlInBrowser, webOpenNotice } from "./browser-open.js"
import { loadSubscriptionProviders, showCredentialsSettings } from "./settings/credentials-modal.js"
import { currentDefaultModelRef, pickReasoningLevel, reloadUiSettingsAndAuth, updateDefaultModel } from "./settings/model-preferences.js"
import { showSettingsEditor } from "./settings/settings-editor.js"
import { Chat } from "./session/chat.js"
import { OverviewKeyHints, OverviewModelLine, OverviewNoticeLine, PromptLabel, RouteLoadingShell, StaleRuntimeOverlay } from "./chrome.js"
import { eventIsServiceLiveRecovery, eventNeedsServiceChatSnapshot, eventNeedsServiceSessionRefresh, isConnectionReset, isStaleRuntimeError, isTransientServiceTransportError } from "./service-events.js"
export { DoubleEscapeTracker, routeHistoryShortcutAllowed, sessionPageBackShortcutAllowed } from "./shortcuts.js"
export { streamingContentProgress, streamingStatusBase } from "./session/streaming-status.js"
export { renderSessionCwdStatusLine, sessionCwdStatus, sessionCwdStatusText, sessionInfoBody } from "./session/status.js"
export { AgentTable, isRunningAgentStateActionRejection, overviewSessionContextMenuItems, selectedAgentStateActionTask } from "./overview/session-table.js"
export { overviewCommandLine, rewindPromptActionItems, serviceChatCommandLine, sessionOpenCommand, webUrlForRoute } from "./slash-commands.js"
export { CredentialsSettingsModal } from "./settings/credentials-modal.js"
/** @typedef {import("../../../../server/src/app/stderr-capture.js").StderrCapture} StderrCapture */
/** @typedef {import("../../../../server/src/app/routes.js").PinanoRoute} PinanoRoute */

const OVERVIEW_AGE_WIDTH = 3
const TRANSIENT_RUNNING_ACTIVITY_RE = /^(Thinking|Generating|Running)/
const CLIPBOARD_IMAGE_NOTICE_MS = 4000
const SESSION_WORKTREE_STATUS_REFRESH_INTERVAL_MS = 10 * 1000
const OVERVIEW_REFRESH_ERROR_NOTICE_PREFIX = "refresh error:"
const OVERVIEW_WORKTREE_STATUS_ERROR_NOTICE_PREFIX = "worktree status error:"

export { overviewModelLabel, overviewModelStatusText }

/** @param {import("../../../../server/src/app/settings.js").Settings | undefined} settings */
function overviewModelStatusLine(settings, usageStatus) {
	const label = overviewModelLabel(settings)
	if (!label) return ""
	const base = [theme.cyan(label), theme.dim(`reasoning:${reasoningLevelLabel(settings?.thinkingLevel)}`)].join(modelLineDivider(" │ "))
	const visibleUsageStatus = showSubscriptionUsageStatusFromSettings(settings) ? usageStatus : undefined
	return visibleUsageStatus?.text
		? `${base}${modelLineDivider(" | ")}${colorUsageStatus(visibleUsageStatus.text, visibleUsageStatus.tone)}`
		: base
}


export { nextStaleRuntimeReexecDepth } from "../../../../server/src/app/reexec-runtime.js"

const STALE_RUNTIME_RETRY_INITIAL_MS = 1000
const STALE_RUNTIME_RETRY_MAX_MS = 15000
const DRAFT_SYNC_RETRY_INITIAL_MS = 500
const DRAFT_SYNC_RETRY_MAX_MS = 5000
const NO_MODEL_PROVIDER_OVERVIEW_ERROR = "No model provider configured"
const NO_MODEL_PROVIDER_EMPTY_GUIDANCE = "Configure a model provider with /credentials before dispatching an agent."
const NO_MODEL_PROVIDER_CHAT_NOTICE = "No model provider configured. Open /settings and choose credentials before sending."

async function hasAvailableModelProvider() {
	return (await availableModelEntries()).length > 0
}



/**
 * @param {() => Promise<void>} run
 * @param {(err: any) => void} onError
 * @param {number} delayMs
 */
function createCoalescedRunner(run, onError, delayMs = 120) {
	let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)
	let running = false
	let queued = false
	const flush = () => {
		timer = undefined
		if (running) {
			queued = true
			return
		}
		queued = false
		running = true
		Promise.resolve()
			.then(run)
			.catch(onError)
			.finally(() => {
				running = false
				if (queued) schedule()
			})
	}
	const schedule = (immediate = false) => {
		queued = true
		if (timer || running) return
		if (immediate) flush()
		else timer = setTimeout(flush, delayMs)
	}
	schedule.cancel = () => {
		if (timer) clearTimeout(timer)
		timer = undefined
		queued = false
	}
	return schedule
}


/**
 * Run the unified service-backed TUI shell (chat view + agents overview).
 * @param {object} options
 * @param {any} options.client
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {PinanoRoute} [options.initialRoute]
 * @param {StderrCapture} [options.stderrCapture]
 */
export async function runServiceTuiMode(options) {
	const runtimeOptions = tuiRuntimeOptions(options.stderrCapture)
	const terminal = new ProcessTerminal(runtimeOptions.terminal)
	const tui = new TUI(terminal, runtimeOptions.tui)
	const root = new Container()
	const editor = new Editor(tui, /** @type {any} */ (editorTheme), { paddingX: 1 })
	let settings = await loadSettings()
	let showHiddenSessions = false
	const baseOverviewCwd = resolve(options.cwd ?? process.cwd())
	const normalizedRouteCwd = (route) => {
		const cwd = routeCwd(route)
		return cwd ? resolve(cwd) : undefined
	}
	const routeWithNormalizedCwd = (route) => {
		const cwd = normalizedRouteCwd(route) ?? baseOverviewCwd
		if (route?.type === "overview") return overviewRouteForCwd(cwd, routeSelectedSessionId(route))
		if (route?.type === "session") return sessionRoute(route.id, cwd)
		return route
	}
	let overviewRouteCwd = normalizedRouteCwd(options.initialRoute) ?? baseOverviewCwd
	const overviewCwd = () => overviewRouteCwd ?? baseOverviewCwd
	const overviewRouteForCurrentScope = (selectedSessionId = undefined) => overviewRouteForCwd(overviewCwd(), selectedSessionId)
	const sessionRouteForCurrentScope = (id) => sessionRoute(id, overviewCwd())
	const initialDirectoryFilterEnabled = await overviewDirectoryFilterEnabled(options.client, overviewCwd()).catch(() => false)
	let webEnabled = settings.web === true
	let hasModelProvider = await hasAvailableModelProvider()
	let highlightEmptyCredentialsGuidance = false
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(() => overviewCommands({ web: webEnabled }), overviewCwd(), null))
	const overviewSpacerLines = 1
	const overviewKeyHintLines = 1
	let promptLabel = /** @type {PromptLabel | undefined} */ (undefined)
	let overviewModelLine = /** @type {OverviewModelLine | undefined} */ (undefined)
	let overviewUsageStatus = /** @type {{ text: string, tone: "normal" | "warn" | "error" } | undefined} */ (undefined)
	let overviewBottomNotice = /** @type {{ text: string, tone?: "normal" | "warn" | "error" } | undefined} */ (undefined)
	let overviewSpinnerFrameIndex = 0
	const overviewSpinnerFrame = () => LOADER_SPINNER_FRAMES[overviewSpinnerFrameIndex] ?? "✽"
	const overviewNoticeLine = new OverviewNoticeLine(() => overviewBottomNotice)
	const overviewProject = await projectInfoForCwd(overviewCwd()).catch(() => undefined)
	const table = new AgentTable({
		cwd: overviewCwd(),
		project: overviewProject,
		directoryFilterEnabled: initialDirectoryFilterEnabled,
		spinnerFrame: overviewSpinnerFrame,
		getMaxLines: (width) => tui.terminal.rows
			- overviewSpacerLines
			- overviewKeyHintLines
			- (promptLabel?.lineCount() ?? 0)
			- editor.getRenderedLineCount(width)
			- (overviewModelLine?.lineCount() ?? 0)
			- overviewNoticeLine.lineCount(),
		getEmptyLines: () => hasModelProvider ? [
			"No sessions yet.",
		] : [
			"No sessions yet.",
			{ text: NO_MODEL_PROVIDER_EMPTY_GUIDANCE, highlight: highlightEmptyCredentialsGuidance },
		],
	})
	let filterMode = false
	let filterBeforeEdit = ""
	let overviewPromptImages = []
	let overviewPromptImageCounter = 0
	promptLabel = new PromptLabel(() => {
		if (filterMode) return "Filter agents:"
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return `Reply to ${selected.id.slice(0, 8)}:`
		if (!hasModelProvider) return "Configure model provider with /credentials:"
		return ""
	})
	overviewModelLine = new OverviewModelLine(() => {
		if (!hasModelProvider || filterMode) return ""
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return ""
		return overviewModelStatusLine(settings, overviewUsageStatus)
	})
	editor.setPlaceholder(() => {
		if (filterMode) return "filter sessions"
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return "type to reply"
		if (!hasModelProvider) return ""
		return "type to dispatch new agent session"
	})
	const overviewKeyHints = new OverviewKeyHints(() => ({
		filterMode,
		peeking: Boolean(table.peekSessionId && table.selected()?.id === table.peekSessionId),
		hasText: editor.getText().trim().length > 0,
	}), {
		onHelp: () => {
			void handleOverviewCommand("help").catch((err) => {
				if (showStaleRuntime(err)) return
				setOverviewNotice(`/help error: ${err?.message ?? err}`)
			})
		},
	})
	let staleRuntimeActive = false
	let overviewMounted = false
	let overviewSpinnerTimer = undefined
	const stopOverviewSpinner = () => {
		if (!overviewSpinnerTimer) return
		clearInterval(overviewSpinnerTimer)
		overviewSpinnerTimer = undefined
	}
	const canAnimateOverviewSpinner = () => overviewMounted && !staleRuntimeActive && LOADER_SPINNER_FRAMES.length > 1
	const shouldAnimateOverviewSpinner = () => canAnimateOverviewSpinner() && table.hasVisibleRunningSession()
	const startOverviewSpinner = () => {
		if (overviewSpinnerTimer || !shouldAnimateOverviewSpinner()) return
		overviewSpinnerTimer = setInterval(() => {
			if (!canAnimateOverviewSpinner()) {
				stopOverviewSpinner()
				return
			}
			overviewSpinnerFrameIndex = (overviewSpinnerFrameIndex + 1) % LOADER_SPINNER_FRAMES.length
			tui.requestRender()
		}, LOADER_SPINNER_INTERVAL_MS)
		overviewSpinnerTimer.unref?.()
	}
	const syncOverviewSpinner = () => {
		if (shouldAnimateOverviewSpinner()) startOverviewSpinner()
		else stopOverviewSpinner()
	}
	let overviewWorktreeStatusTimer = undefined
	const stopOverviewWorktreeStatusTimer = () => {
		if (!overviewWorktreeStatusTimer) return
		clearInterval(overviewWorktreeStatusTimer)
		overviewWorktreeStatusTimer = undefined
	}
	const startOverviewWorktreeStatusTimer = () => {
		if (overviewWorktreeStatusTimer || !overviewMounted || staleRuntimeActive || !liveUpdatesAllowed()) return
		overviewWorktreeStatusTimer = setInterval(() => {
			if (!overviewMounted || staleRuntimeActive || !liveUpdatesAllowed()) {
				stopOverviewWorktreeStatusTimer()
				return
			}
			scheduleOverviewWorktreeLoads()
		}, OVERVIEW_WORKTREE_STATUS_REFRESH_INTERVAL_MS)
		overviewWorktreeStatusTimer.unref?.()
	}
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let overviewBottomNoticeTimer = undefined
	const clearOverviewBottomNoticeTimer = () => {
		if (overviewBottomNoticeTimer) clearTimeout(overviewBottomNoticeTimer)
		overviewBottomNoticeTimer = undefined
	}
	const requestShellRender = (force = false) => {
		editor.invalidate()
		syncOverviewSpinner()
		tui.requestRender(force)
	}
	/** @type {import("../tui/tui.js").OverlayHandle | undefined} */
	let overviewContextMenuHandle = undefined
	const closeOverviewContextMenu = () => {
		const handle = overviewContextMenuHandle
		overviewContextMenuHandle = undefined
		handle?.hide()
	}
	let overviewProjectLoadSeq = 0
	const setOverviewAutocompleteCwd = (cwd) => {
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(() => overviewCommands({ web: webEnabled }), cwd, null))
	}
	const refreshOverviewProjectForCwd = (cwd) => {
		const seq = ++overviewProjectLoadSeq
		void projectInfoForCwd(cwd)
			.then((project) => {
				if (seq !== overviewProjectLoadSeq || table.cwd !== cwd) return
				table.project = project
				requestShellRender()
			})
			.catch(() => {})
	}
	const setOverviewTableCwd = (cwd) => {
		const nextCwd = resolve(cwd || baseOverviewCwd)
		const changed = table.cwd !== nextCwd
		table.cwd = nextCwd
		setOverviewAutocompleteCwd(nextCwd)
		if (changed) {
			table.project = undefined
			refreshOverviewProjectForCwd(nextCwd)
		}
	}
	const setOverviewBottomNotice = (notice, { timeoutMs } = {}) => {
		clearOverviewBottomNoticeTimer()
		overviewBottomNotice = notice
		if (notice?.text && timeoutMs) {
			overviewBottomNoticeTimer = setTimeout(() => {
				overviewBottomNotice = undefined
				overviewBottomNoticeTimer = undefined
				requestShellRender()
			}, timeoutMs)
			overviewBottomNoticeTimer.unref?.()
		}
		requestShellRender()
	}
	const overviewPromptAttachmentsForText = (text) => promptAttachmentsForText(overviewPromptImages, text)
	const clearOverviewPromptImagesForText = (text) => {
		overviewPromptImages = clearPromptImageAttachmentsForText(overviewPromptImages, text)
	}
	const clearOverviewPromptImages = () => {
		overviewPromptImages = []
	}
	const pasteOverviewClipboardImage = async () => {
		try {
			const image = await readClipboardImage()
			overviewPromptImageCounter = insertPromptImageAttachment(editor, overviewPromptImages, overviewPromptImageCounter, image)
			requestShellRender()
		} catch (err) {
			const notice = clipboardImagePasteNotice(err)
			if (notice) setOverviewBottomNotice({ text: notice, tone: "warn" }, { timeoutMs: CLIPBOARD_IMAGE_NOTICE_MS })
			requestShellRender()
		}
	}
	let currentChat = /** @type {Chat | undefined} */ (undefined)
	const routeHistory = new RouteHistory(options.initialRoute ? routeWithNormalizedCwd(options.initialRoute) : overviewRouteForCurrentScope())
	let currentRoute = routeHistory.current
	const routeLoadingShell = new RouteLoadingShell()
	let subscriptionProviders = new Set()
	let latestCodexUsage = /** @type {import("../../../../server/src/app/codex-usage.js").CodexUsagePayload | undefined} */ (undefined)
	const codexUsageWarningsSeen = new Set()
	let overviewUnsubscribe = /** @type {undefined | (() => void | Promise<void>)} */ (undefined)
	let activeSessionUnsubscribe = /** @type {undefined | (() => void | Promise<void>)} */ (undefined)
	let liveUpdatePresence = /** @type {ReturnType<typeof createPresenceUpdateGate> | undefined} */ (undefined)
	let backgroundReconciler = /** @type {ReturnType<typeof createBackgroundReconciler> | undefined} */ (undefined)
	const closeServiceSubscription = (unsubscribe) => {
		if (!unsubscribe) return
		try {
			Promise.resolve(unsubscribe()).catch(() => {})
		} catch {}
	}
	const liveUpdatesAllowed = () => !liveUpdatePresence || liveUpdatePresence.allowsLiveUpdates()
	let messageRenderOptions = messageRenderOptionsFromSettings(settings)
	const doubleEscape = new DoubleEscapeTracker()
	const textDoubleEscape = new DoubleEscapeTracker()
	const overviewTextDoubleEscape = new DoubleEscapeTracker()
	let staleRuntimeDesired = /** @type {any} */ (null)
	let staleRuntimeRouteArgs = /** @type {string[]} */ ([])
	let staleRuntimeRoute = ""
	let reexecInProgress = false
	let staleRuntimeRetryTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
	let staleRuntimeRetryScheduled = false
	let staleRuntimeRetryDelayMs = STALE_RUNTIME_RETRY_INITIAL_MS
	let staleRuntimeReexecError = ""
	let staleRuntimeRetryable = true
	let tuiStderrForwardingRestore = /** @type {boolean | undefined} */ (undefined)
	const enterTuiTerminal = () => {
		if (tuiStderrForwardingRestore !== undefined || !options.stderrCapture || !process.stderr.isTTY) return
		tuiStderrForwardingRestore = options.stderrCapture.isForwarding()
		options.stderrCapture.setForwarding(false)
	}
	const leaveTuiTerminal = () => {
		if (tuiStderrForwardingRestore === undefined || !options.stderrCapture) return
		options.stderrCapture.setForwarding(tuiStderrForwardingRestore)
		tuiStderrForwardingRestore = undefined
	}
	const stopTui = () => {
		try {
			tui.stop()
		} finally {
			leaveTuiTerminal()
		}
	}
	const staleRuntimeOverlay = new StaleRuntimeOverlay(() => ({
		route: staleRuntimeRoute,
		reopening: reexecInProgress,
		retryScheduled: staleRuntimeRetryScheduled,
		error: staleRuntimeReexecError,
		retryable: staleRuntimeRetryable,
		height: tui.terminal.rows,
	}))
	const currentRouteArgs = () => {
		const args = []
		if (options.noContextFiles) args.push("--no-context-files")
		args.push(...routeToCliArgs(currentRoute))
		return args
	}
	const clearStaleRuntimeRetryTimer = () => {
		if (!staleRuntimeRetryTimer) return
		clearTimeout(staleRuntimeRetryTimer)
		staleRuntimeRetryTimer = undefined
		staleRuntimeRetryScheduled = false
	}
	const staleRuntimeReexecErrorMessage = (err) => {
		const text = `${err?.message ?? err}`.replace(/\s+/g, " ").trim()
		return text || "unknown error"
	}
	const staleRuntimeReexecErrorIsRetryable = (err) => !/\bstale runtime reexec depth exceeded\b/i.test(staleRuntimeReexecErrorMessage(err))
	const scheduleStaleRuntimeReexec = (delayMs = 0) => {
		if (!staleRuntimeActive || reexecInProgress || staleRuntimeRetryTimer || !staleRuntimeRetryable) return
		staleRuntimeRetryScheduled = delayMs > 0
		requestShellRender()
		staleRuntimeRetryTimer = setTimeout(() => {
			staleRuntimeRetryTimer = undefined
			staleRuntimeRetryScheduled = false
			void reexecStaleRuntime()
		}, delayMs)
		staleRuntimeRetryTimer.unref?.()
	}

	const reexecStaleRuntime = async () => {
		if (reexecInProgress) return
		clearStaleRuntimeRetryTimer()
		reexecInProgress = true
		staleRuntimeRetryable = true
		staleRuntimeReexecError = ""
		requestShellRender(true)
		await new Promise((resolve) => setTimeout(resolve, 50))
		let tuiStopped = false
		try {
			staleRuntimeDesired = await options.client.desiredRuntime?.() || staleRuntimeDesired
			const runtime = staleRuntimeDesired?.execPath ?? process.execPath
			const target = staleRuntimeDesired?.mainPath
			if (!target) throw new Error("desired runtime path unavailable")
			const envPatch = staleRuntimeReexecEnvPatch()
			const runtimeArgs = runtime === process.execPath
				? [...(process.execArgv ?? []), target, ...staleRuntimeRouteArgs]
				: [target, ...staleRuntimeRouteArgs]
			stopTui()
			tuiStopped = true
			await reexecRuntime({
				command: runtime,
				args: runtimeArgs,
				cwd: options.cwd,
				envPatch,
			})
		} catch (err) {
			if (tuiStopped) {
				console.error(`pinano update failed: ${err?.message ?? err}`)
				process.exit(1)
			}
			staleRuntimeRetryable = staleRuntimeReexecErrorIsRetryable(err)
			staleRuntimeReexecError = staleRuntimeReexecErrorMessage(err)
			reexecInProgress = false
			if (staleRuntimeRetryable) {
				const delayMs = staleRuntimeRetryDelayMs
				staleRuntimeRetryDelayMs = Math.min(staleRuntimeRetryDelayMs * 2, STALE_RUNTIME_RETRY_MAX_MS)
				scheduleStaleRuntimeReexec(delayMs)
			}
			requestShellRender()
		}
	}

	let scheduleOverviewWorktreeLoads = () => {}
	let syncCurrentOverviewRouteSelection = () => {}
	table.onSelectionChange = () => {
		scheduleOverviewWorktreeLoads()
		syncCurrentOverviewRouteSelection()
	}
	const overviewSessionListCwd = () => table.directoryFilterEnabled ? table.cwd : undefined
	const overviewSessionListOptions = () => ({
		...(settings.showDeletedSessions === true ? { includeDeleted: true } : {}),
		...(showHiddenSessions ? { includeHidden: true } : {}),
	})
	const refreshRows = async (refreshOptions = {}) => {
		if (!overviewMounted || staleRuntimeActive) return
		table.setSessions(await options.client.sessions(overviewSessionListCwd(), overviewSessionListOptions()))
		const selectedSessionId = currentRoute.type === "overview" && refreshOptions.selectRouteTarget !== false
			? routeSelectedSessionId(currentRoute)
			: undefined
		if (selectedSessionId) table.selectRouteTargetSession(selectedSessionId)
		syncCurrentOverviewRouteSelection()
		scheduleOverviewWorktreeLoads()
		requestShellRender()
	}
	const refreshRowsAndSelect = async (sessionId) => {
		if (!overviewMounted || staleRuntimeActive) return
		table.setSessions(await options.client.sessions(overviewSessionListCwd(), overviewSessionListOptions()))
		table.selectSession(sessionId)
		syncCurrentOverviewRouteSelection()
		scheduleOverviewWorktreeLoads()
		requestShellRender()
	}
	const overviewWorktreeLoads = new Set()
	const overviewWorktreeForceRefreshes = new Set()
	const handleRefreshError = (err) => {
		if (showStaleRuntime(err)) return
		if (!overviewMounted) return
		if (isTransientServiceTransportError(err)) return
		table.setNotice(`${OVERVIEW_REFRESH_ERROR_NOTICE_PREFIX} ${err?.message ?? err}`)
		requestShellRender()
	}
	const scheduleRowsRefreshRunner = createCoalescedRunner(refreshRows, handleRefreshError)
	const scheduleRowsRefresh = (immediate = false) => {
		if (!overviewMounted || staleRuntimeActive) return
		scheduleRowsRefreshRunner(immediate)
	}
	scheduleRowsRefresh.cancel = () => scheduleRowsRefreshRunner.cancel()
	const showStaleRuntime = (err) => {
		if (!isStaleRuntimeError(err)) return false
		if (!staleRuntimeActive) {
			staleRuntimeRouteArgs = currentRouteArgs()
			staleRuntimeRoute = routeToArg(currentRoute)
			staleRuntimeDesired = null
			staleRuntimeRetryDelayMs = STALE_RUNTIME_RETRY_INITIAL_MS
			staleRuntimeReexecError = ""
			staleRuntimeRetryable = true
			staleRuntimeActive = true
			backgroundReconciler?.stop()
			scheduleRowsRefresh.cancel()
			stopOverviewWorktreeStatusTimer()
			closeServiceSubscription(overviewUnsubscribe)
			overviewUnsubscribe = undefined
			closeServiceSubscription(activeSessionUnsubscribe)
			activeSessionUnsubscribe = undefined
			tui.showOverlay(staleRuntimeOverlay, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				row: 0,
				col: 0,
				margin: 0,
				backdrop: true,
			})
		}
		scheduleStaleRuntimeReexec(0)
		requestShellRender(true)
		return true
	}
	const loadOverviewWorktrees = async (sessionId, loadOptions = {}) => {
		if (!sessionId || typeof options.client.worktrees !== "function") return
		if (overviewWorktreeLoads.has(sessionId)) {
			if (loadOptions.refresh === true) overviewWorktreeForceRefreshes.add(sessionId)
			return
		}
		if (loadOptions.refresh !== true && table.hasFreshWorktreeInfo(sessionId)) return
		const sessionVersion = table.worktreeSessionVersions.get(sessionId)
		overviewWorktreeLoads.add(sessionId)
		try {
			const worktrees = await options.client.worktrees(sessionId)
			if (table.worktreeSessionVersions.get(sessionId) === sessionVersion) {
				table.setWorktrees(sessionId, worktrees)
				table.clearNotice((notice) => notice.startsWith(OVERVIEW_WORKTREE_STATUS_ERROR_NOTICE_PREFIX))
			}
		} catch (err) {
			if (showStaleRuntime(err)) return
			if (!isTransientServiceTransportError(err)) {
				if (loadOptions.showError === true) table.setNotice(`${OVERVIEW_WORKTREE_STATUS_ERROR_NOTICE_PREFIX} ${err?.message ?? err}`)
				else if (table.worktreeSessionVersions.get(sessionId) === sessionVersion && !table.hasWorktreeInfo(sessionId)) table.setWorktrees(sessionId, [])
			}
		} finally {
			overviewWorktreeLoads.delete(sessionId)
			requestShellRender()
			if (overviewWorktreeForceRefreshes.has(sessionId)) scheduleOverviewWorktreeLoads()
		}
	}
	const loadPeekWorktrees = (sessionId, loadOptions = {}) => loadOverviewWorktrees(sessionId, { ...loadOptions, showError: true })
	const overviewWorktreeLoadCandidates = () => {
		const selected = table.selected()
		const selectedId = selected?.deletedAt ? undefined : selected?.id
		const peekId = selected?.deletedAt && selected.id === table.peekSessionId ? undefined : table.peekSessionId
		return overviewWorktreeRefreshCandidates(table.rows(), { selectedId, peekId })
	}
	scheduleOverviewWorktreeLoads = (loadOptions = {}) => {
		if (!overviewMounted || staleRuntimeActive || typeof options.client.worktrees !== "function") return
		const candidates = overviewWorktreeLoadCandidates()
		const candidateSet = new Set(candidates)
		for (const sessionId of overviewWorktreeForceRefreshes) {
			if (!candidateSet.has(sessionId)) overviewWorktreeForceRefreshes.delete(sessionId)
		}
		if (loadOptions.force === true) {
			for (const sessionId of candidates) overviewWorktreeForceRefreshes.add(sessionId)
		}
		const available = OVERVIEW_WORKTREE_STATUS_CONCURRENCY - overviewWorktreeLoads.size
		if (available <= 0) return
		const sessionIds = candidates
			.filter((sessionId) => {
				if (overviewWorktreeLoads.has(sessionId)) return false
				return overviewWorktreeForceRefreshes.has(sessionId) || !table.hasFreshWorktreeInfo(sessionId)
			})
			.slice(0, available)
		for (const sessionId of sessionIds) {
			const refresh = overviewWorktreeForceRefreshes.delete(sessionId)
			void loadOverviewWorktrees(sessionId, { refresh }).finally(() => scheduleOverviewWorktreeLoads())
		}
	}

	const clearCodexUsageStatus = () => {
		latestCodexUsage = undefined
		overviewUsageStatus = undefined
		currentChat?.setCodexUsageStatus(undefined)
		requestShellRender()
	}
	const syncCodexUsageStatusDisplay = () => {
		if (!latestCodexUsage || !showSubscriptionUsageStatusFromSettings(settings)) {
			overviewUsageStatus = undefined
			currentChat?.setCodexUsageStatus(undefined)
			return
		}
		const summary = formatCodexUsageInlineSummary(latestCodexUsage)
		overviewUsageStatus = summary ? { text: summary, tone: codexUsageStatusTone(latestCodexUsage) } : undefined
		currentChat?.setCodexUsageStatus(formatCodexUsageLowStatus(latestCodexUsage))
	}
	const applyCodexUsage = (payload, options = {}) => {
		latestCodexUsage = payload
		syncCodexUsageStatusDisplay()
		if (options.emitWarnings && currentChat && showSubscriptionUsageStatusFromSettings(settings)) {
			for (const message of codexUsageThresholdMessages(payload, codexUsageWarningsSeen)) {
				currentChat.appendChatNote(message.text, { label: "usage", tone: message.tone })
			}
		}
		requestShellRender()
	}
	const refreshCodexUsage = async (usageOptions = {}) => {
		if (!subscriptionProviders.has("openai-codex")) {
			clearCodexUsageStatus()
			return
		}
		const payload = await fetchCodexUsage({ baseUrl: codexUsageBaseUrlForModel(currentChat?.snapshot?.model, settings) })
		applyCodexUsage(payload, { emitWarnings: usageOptions.emitWarnings === true })
	}
	const handleCodexUsageRefreshError = (err) => {
		if (isConnectionReset(err)) return
	}
	const scheduleCodexUsageRefresh = createCoalescedRunner(() => refreshCodexUsage({ emitWarnings: true }), handleCodexUsageRefreshError, 750)

	const disposeCurrentChat = () => {
		currentChat?.flushPromptDraft()
		currentChat?.dispose()
		currentChat = undefined
	}

	let exiting = false
	const exit = async () => {
		if (exiting) return
		exiting = true
		liveUpdatePresence?.stop()
		backgroundReconciler?.dispose()
		clearStaleRuntimeRetryTimer()
		scheduleRowsRefresh.cancel()
		scheduleCodexUsageRefresh.cancel()
		clearOverviewBottomNoticeTimer()
		closeOverviewContextMenu()
		stopOverviewSpinner()
		stopOverviewWorktreeStatusTimer()
		disposeCurrentChat()
		const unsubscribers = [activeSessionUnsubscribe, overviewUnsubscribe].filter(Boolean)
		activeSessionUnsubscribe = undefined
		overviewUnsubscribe = undefined
		if (unsubscribers.length > 0) {
			let detachTimer
			try {
				await Promise.race([
					Promise.all(unsubscribers.map((unsubscribe) => unsubscribe())),
					new Promise((resolve) => {
						detachTimer = setTimeout(resolve, 250)
						detachTimer.unref?.()
					}),
				])
			} finally {
				if (detachTimer) clearTimeout(detachTimer)
			}
		}
		stopTui()
		process.exit(0)
	}

	function startOverviewSubscription() {
		if (overviewUnsubscribe || staleRuntimeActive || !liveUpdatesAllowed()) return
		overviewUnsubscribe = subscribeToServiceEvents(overviewSessionListOptions())
	}

	function stopOverviewSubscription() {
		closeServiceSubscription(overviewUnsubscribe)
		overviewUnsubscribe = undefined
	}

	const mountOverview = () => {
		overviewMounted = true
		startOverviewSubscription()
		root.addChild(table)
		root.addChild(new Spacer(1))
		root.addChild(overviewKeyHints)
		root.addChild(promptLabel)
		root.addChild(editor)
		root.addChild(overviewModelLine)
		root.addChild(overviewNoticeLine)
		syncOverviewSpinner()
		startOverviewWorktreeStatusTimer()
		scheduleOverviewWorktreeLoads()
	}

	const unmountOverview = () => {
		overviewMounted = false
		closeOverviewContextMenu()
		stopOverviewSubscription()
		stopOverviewSpinner()
		stopOverviewWorktreeStatusTimer()
	}

	const mountRouteLoading = (route, routeOptions = {}) => {
		unmountOverview()
		root.clear()
		routeLoadingShell.setRoute(route, routeOptions)
		root.addChild(routeLoadingShell)
		tui.setFocus(null)
	}

	const mountCurrentRouteSurface = () => {
		if (currentRoute.type === "overview") mountOverview()
		else mountRouteLoading(currentRoute)
	}

	const setCurrentRoute = (route, { history = "record" } = {}) => {
		const previousRoute = currentRoute
		if (history === "record") routeHistory.navigate(route)
		else if (history === "replace") routeHistory.replace(route)
		currentRoute = history === "none" ? route : routeHistory.current
		if (routeToArg(previousRoute) !== routeToArg(currentRoute)) {
			doubleEscape.reset()
			textDoubleEscape.reset()
			overviewTextDoubleEscape.reset()
		}
	}
	syncCurrentOverviewRouteSelection = () => {
		if (currentRoute.type !== "overview") return
		const selectedId = table.selected()?.id
		const route = overviewRouteForCurrentScope(selectedId)
		if (routeToArg(route) === routeToArg(currentRoute)) return
		setCurrentRoute(route, { history: "replace" })
	}

	let overviewDirectoryFilterLoadSeq = 0
	const refreshOverviewDirectoryFilterForCwd = (cwd) => {
		const seq = ++overviewDirectoryFilterLoadSeq
		void overviewDirectoryFilterEnabled(options.client, cwd)
			.then((enabled) => {
				if (seq !== overviewDirectoryFilterLoadSeq || table.cwd !== cwd) return
				const changed = table.directoryFilterEnabled !== enabled
				table.setDirectoryFilterEnabled(enabled)
				requestShellRender()
				if (changed && overviewMounted) void refreshRows().catch(handleRefreshError)
			})
			.catch(() => {})
	}

	const applyOverviewRouteScope = (route) => {
		const cwd = normalizedRouteCwd(route) ?? baseOverviewCwd
		const changed = overviewRouteCwd !== cwd || table.cwd !== cwd
		overviewRouteCwd = cwd
		setOverviewTableCwd(cwd)
		if (changed) refreshOverviewDirectoryFilterForCwd(cwd)
	}

	const showAgents = (showOptions = {}) => {
		const baseRoute = routeWithNormalizedCwd(showOptions.route ?? overviewRouteForCurrentScope())
		const selectSessionId = showOptions.selectSessionId ?? routeSelectedSessionId(baseRoute) ?? currentChat?.sessionId
		const route = baseRoute.type === "overview"
			? overviewRouteForCwd(routeCwd(baseRoute), selectSessionId)
			: baseRoute
		applyOverviewRouteScope(route)
		setCurrentRoute(route, { history: showOptions.routeHistory ?? "record" })
		closeServiceSubscription(activeSessionUnsubscribe)
		activeSessionUnsubscribe = undefined
		disposeCurrentChat()
		unmountOverview()
		root.clear()
		mountOverview()
		if (selectSessionId) table.selectSession(selectSessionId)
		tui.setFocus(null)
		requestShellRender(true)
		void (selectSessionId ? refreshRowsAndSelect(selectSessionId) : refreshRows()).catch(handleRefreshError)
	}

	const resolveRouteSessionId = async (id) => {
		if (typeof options.client.resolveSessionId !== "function") return id
		const resolved = await options.client.resolveSessionId(id)
		return resolved?.sessionId || id
	}
	const assertSnapshotSessionId = (snapshot, expectedId) => {
		const id = typeof snapshot?.sessionId === "string" && snapshot.sessionId ? snapshot.sessionId : ""
		if (!id) throw new Error("Session snapshot is missing a session id.")
		if (id !== expectedId) throw new Error(`Session snapshot id mismatch: expected ${expectedId}, got ${id}`)
		return id
	}
	const openSession = async (id, openOptions = {}) => {
		clearOverviewSearch()
		const route = sessionRouteForCurrentScope(id)
		setCurrentRoute(route, { history: openOptions.routeHistory ?? "record" })
		closeServiceSubscription(activeSessionUnsubscribe)
		activeSessionUnsubscribe = undefined
		disposeCurrentChat()
		mountRouteLoading(currentRoute)
		requestShellRender(true)
		let nextSettings
		let snapshot
		let resolvedId = id
		try {
			resolvedId = await resolveRouteSessionId(id)
			if (currentRoute.type !== "session" || (currentRoute.id !== id && currentRoute.id !== resolvedId)) return
			if (resolvedId !== id) {
				setCurrentRoute(sessionRouteForCurrentScope(resolvedId), { history: "replace" })
				mountRouteLoading(currentRoute)
				requestShellRender(true)
			}
			const loaded = await Promise.all([
				loadSettings(),
				options.client.snapshot(resolvedId),
			])
			nextSettings = loaded[0]
			snapshot = loaded[1]
		} catch (err) {
			if (showStaleRuntime(err)) return
			if (currentRoute.type === "session" && (currentRoute.id === id || currentRoute.id === resolvedId)) {
				mountRouteLoading(currentRoute, { error: err })
				requestShellRender(true)
			}
			return
		}
		if (currentRoute.type !== "session" || currentRoute.id !== resolvedId) return
		const sessionId = assertSnapshotSessionId(snapshot, resolvedId)
		settings = nextSettings
		webEnabled = settings.web === true
		messageRenderOptions = messageRenderOptionsFromSettings(settings)
		let chat
		chat = new Chat({
			tui,
			client: options.client,
			sessionId,
			detach: () => showAgents({ selectSessionId: chat?.sessionId ?? sessionId }),
			exit,
			stderrCapture: options.stderrCapture,
			onClientError: showStaleRuntime,
			messageRenderOptions,
			webEnabled,
			onSettingsChanged: applyOverviewSettings,
			onCodexUsage: (payload) => applyCodexUsage(payload),
			getCodexUsageBaseUrl: (model) => codexUsageBaseUrlForModel(model, settings),
			refreshGlobalAuth: refreshOverviewAuth,
			onSessionIdChanged: (sessionId, changeOptions = {}) => {
				if (currentChat !== chat) return
				setCurrentRoute(sessionRouteForCurrentScope(sessionId), { history: changeOptions.routeHistory ?? "replace" })
				table.selectSession(sessionId)
				openActiveSessionSubscription(sessionId)
				requestShellRender()
			},
		})
		currentChat = chat
		unmountOverview()
		root.clear()
		root.addChild(chat.root)
		tui.setFocus(null)
		if (chat.disposed || currentChat !== chat || currentRoute.type !== "session" || currentRoute.id !== sessionId) return
		chat.update(snapshot)
		openActiveSessionSubscription(sessionId)
		syncCodexUsageStatusDisplay()
		requestShellRender(true)
	}
	const openOverviewSession = (session) => {
		if (session.deletedAt) {
			table.setNotice("deleted session; press Ctrl+X to restore")
			requestShellRender()
			return
		}
		openSession(session.id).catch((err) => {
			if (showStaleRuntime(err)) return
			table.setActivity(session.id, `error: ${err?.message ?? err}`)
		})
	}
	const openRouteFromHistory = (route) => {
		if (route.type === "overview") {
			showAgents({ routeHistory: "none", route })
			return
		}
		if (route.type === "session") {
			applyOverviewRouteScope(route)
			openSession(route.id, { routeHistory: "none" }).catch((err) => {
				if (showStaleRuntime(err)) return
				table.setNotice(`navigation error: ${err?.message ?? err}`)
				requestShellRender()
			})
			return
		}
	}
	const goRouteBack = () => {
		const route = routeHistory.back()
		if (!route) return false
		currentRoute = routeHistory.current
		openRouteFromHistory(route)
		return true
	}
	const goRouteForward = () => {
		const route = routeHistory.forward()
		if (!route) return false
		currentRoute = routeHistory.current
		openRouteFromHistory(route)
		return true
	}
	table.onActivate = (action) => {
		if (action.type === "more") {
			scheduleOverviewWorktreeLoads()
			requestShellRender()
			return
		}
		openOverviewSession(action.session)
	}

	const dispatchNew = async (text, images = []) => {
		hasModelProvider = await hasAvailableModelProvider()
		if (!hasModelProvider) throw new Error(NO_MODEL_PROVIDER_OVERVIEW_ERROR)
		const created = await options.client.createSession({ cwd: table.cwd })
		table.setActivity(created.sessionId, "queued")
		await refreshRowsAndSelect(created.sessionId)
		void options.client.prompt(created.sessionId, text, undefined, { images })
			.then(() => clearOverviewPromptImagesForText(text))
			.catch((err) => {
				if (showStaleRuntime(err)) return
				table.setActivity(created.sessionId, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
	}

	const applySelectedStateAction = (selected, targetState) => {
		const task = selectedAgentStateActionTask(table, options.client, selected, targetState)
		if (!task) return
		const moveSelectionAfterSuccess = table.stateFor(selected) !== targetState
		const previousSelectedIndex = table.selectedIndex
		task.then(async () => {
			table.clearActivity(selected.id)
			await refreshRows({ selectRouteTarget: !moveSelectionAfterSuccess })
			if (moveSelectionAfterSuccess) {
				table.selectFallback(previousSelectedIndex, { excludeSessionId: selected.id })
				syncCurrentOverviewRouteSelection()
				scheduleOverviewWorktreeLoads()
				requestShellRender()
			}
		})
			.catch((err) => {
				if (isRunningAgentStateActionRejection(err)) {
					void refreshRows().catch(handleRefreshError)
					return
				}
				if (showStaleRuntime(err)) return
				table.setActivity(selected.id, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
	}

	const applySessionLifecycleAction = (selected) => {
		if (!selected) return
		const restoreSession = options.client.restoreSession ?? options.client.restoreDeletedSession
		const selectedIsRunning = table.isRunningSession(selected)
		const task = selected.deletedAt
			? restoreSession?.(selected.id) ?? Promise.reject(new Error("restore is not supported by this client"))
			: selectedIsRunning
				? options.client.abort(selected.id)
				: options.client.deleteSession(selected.id)
		const moveSelectionAfterSuccess = !selected.deletedAt && !selectedIsRunning
		const previousSelectedIndex = table.selectedIndex
		task.then(async () => {
			await refreshRows({ selectRouteTarget: !moveSelectionAfterSuccess })
			if (moveSelectionAfterSuccess) {
				table.selectFallback(previousSelectedIndex, { excludeSessionId: selected.id })
				syncCurrentOverviewRouteSelection()
				scheduleOverviewWorktreeLoads()
				requestShellRender()
			}
		})
			.catch((err) => {
				if (showStaleRuntime(err)) return
				if (selected.deletedAt) table.setNotice(`restore error: ${err?.message ?? err}`)
				else table.setActivity(selected.id, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
	}

	const showOverviewSessionContextMenu = (session, event) => {
		closeOverviewContextMenu()
		const items = overviewSessionContextMenuItems(table, session, {
			open: () => openOverviewSession(session),
			markCompleted: () => applySelectedStateAction(session, "completed"),
			markDeferred: () => applySelectedStateAction(session, "deferred"),
			lifecycle: () => applySessionLifecycleAction(session),
		})
		const shown = showContextMenu(tui, items, {
			terminalRow: event.row,
			terminalCol: event.col,
			theme: overviewContextMenuTheme,
			onClose: () => {
				overviewContextMenuHandle = undefined
			},
		})
		overviewContextMenuHandle = shown.handle
	}
	table.onContextMenu = (action) => {
		if (action.type === "session") showOverviewSessionContextMenu(action.session, action.event)
	}

	const openWebOverview = async () => {
		const web = await webForOpening(options.client)
		const url = webUrlForRoute(web, overviewRouteForCwd(table.cwd, table.selected()?.id))
		await openUrlInBrowser(url)
		table.setNotice(webOpenNotice(url))
		requestShellRender()
	}
	const setOverviewNotice = (message) => {
		table.setNotice(message)
		requestShellRender()
	}
	const toggleOverviewDirectoryFilter = () => {
		const previousCwd = table.cwd
		const enabled = !table.directoryFilterEnabled
		overviewDirectoryFilterLoadSeq++
		table.setDirectoryFilterEnabled(enabled)
		requestShellRender()
		void refreshRows().catch(handleRefreshError)
		void setOverviewDirectoryFilterEnabled(options.client, previousCwd, enabled).catch((err) => {
			table.setNotice(`directory filter state error: ${err?.message ?? err}`)
			requestShellRender()
		})
	}
	const toggleHiddenSessions = () => {
		showHiddenSessions = !showHiddenSessions
		table.selectFallback(0)
		requestShellRender()
		stopOverviewSubscription()
		startOverviewSubscription()
		void refreshRows().catch(handleRefreshError)
	}
	const overviewCommandCtx = {
		tui,
		showSelector(create, opts = {}) {
			if (opts.fullscreen) {
				let handle
				const done = () => {
					handle?.hide()
					tui.setFocus(editor)
					requestShellRender()
				}
				const { component } = create(done)
				handle = tui.showOverlay(component, {
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					row: 0,
					col: 0,
					margin: 0,
				})
				tui.setFocus(component)
				requestShellRender()
				return
			}
			const done = () => showAgents()
			const { component, focus } = create(done)
			unmountOverview()
			root.clear()
			root.addChild(component)
			tui.setFocus(focus)
			requestShellRender()
		},
	}
	const refreshOverviewAuth = async () => {
		subscriptionProviders = await loadSubscriptionProviders()
		hasModelProvider = await hasAvailableModelProvider()
		if (hasModelProvider) highlightEmptyCredentialsGuidance = false
		await currentChat?.refreshAuthCache?.()
		if (!subscriptionProviders.has("openai-codex")) clearCodexUsageStatus()
		else {
			try {
				await refreshCodexUsage()
			} catch {}
		}
		requestShellRender()
	}
	const applyOverviewSettings = (nextSettings) => {
		const showDeletedChanged = (settings.showDeletedSessions === true) !== (nextSettings.showDeletedSessions === true)
		settings = nextSettings
		webEnabled = nextSettings.web === true
		messageRenderOptions = messageRenderOptionsFromSettings(nextSettings)
		if (nextSettings.updateCheck !== true) setOverviewBottomNotice(undefined)
		if (currentChat) currentChat.webEnabled = webEnabled
		syncCodexUsageStatusDisplay()
		if (showDeletedChanged && overviewMounted) {
			stopOverviewSubscription()
			startOverviewSubscription()
			void refreshRows().catch(handleRefreshError)
		}
		requestShellRender()
	}
	const setOverviewDefaultModel = async (model) => (await options.client.setDefaultModel?.(model))?.settings ?? updateDefaultModel(model, settings)
	const openCredentialsSettingsPage = async (credentialsOptions = {}) => {
		const previousRoute = currentRoute
		setCurrentRoute(settingsCredentialsRoute, { history: "none" })
		try {
			await showCredentialsSettings(tui, {
				...credentialsOptions,
				loginCodex: options.loginCodex,
				refreshAuthCache: refreshOverviewAuth,
				onSettingsChanged: applyOverviewSettings,
				setDefaultModel: setOverviewDefaultModel,
			})
		} finally {
			if (currentRoute.type === "settings-credentials") {
				const fallbackRoute = previousRoute.type === "settings-credentials" ? overviewRouteForCurrentScope() : previousRoute
				const restoredRoute = currentChat ? sessionRouteForCurrentScope(currentChat.sessionId) : routeWithNormalizedCwd(fallbackRoute)
				const restoredHistory = previousRoute.type === "settings-credentials" ? "replace" : "none"
				setCurrentRoute(restoredRoute, { history: restoredHistory })
				if (currentRoute.type === "overview" && !overviewMounted && !currentChat) {
					root.clear()
					mountOverview()
					tui.setFocus(null)
					requestShellRender(true)
					void refreshRows().catch(handleRefreshError)
				}
			}
		}
	}
	const selectOverviewModel = async () => {
		const response = options.client.models
			? await options.client.models()
			: { models: await availableModelEntries(settings), currentModel: currentDefaultModelRef(settings) }
		if (response.models.length === 0) {
			setOverviewNotice("no authenticated models available; open /credentials first")
			return
		}
		const current = response.currentModel || currentDefaultModelRef(settings)
		const rows = rowsForModels(response.models, { currentId: current })
		const chosen = await pickModel(overviewCommandCtx, rows, {
			initialSelectedValue: current,
			title: "Default model",
			subtitle: "Pick the default model for new sessions.",
		}) ?? ""
		if (!chosen) return
		const updated = await setOverviewDefaultModel(chosen)
		await applyOverviewSettings(updated)
		setOverviewNotice(`default model → ${chosen}`)
	}
	const handleOverviewCommand = async (commandLine) => {
		const [name, ...rest] = commandLine.trim().split(/\s+/)
		const arg = rest.join(" ").trim()
		if (name === "help") {
			await showTextModal(tui, "Overview commands", commandHelpBody(overviewCommands({ web: webEnabled }), ["", "Type anything else to dispatch a new background agent."]))
			return
		}
		if (name === "hotkeys") {
			await showTextModal(tui, "Overview hotkeys", [
				"Enter/Right   open selected session",
				"Space         peek/reply to selected session",
				"Up/Down       move selection",
				"PgUp/PgDn     move by page",
				"Ctrl+F        filter sessions",
				"Ctrl+S        toggle directory filter",
				"Ctrl+Shift+S  toggle hidden sessions",
				"Ctrl+V        paste image",
				"Ctrl+D        mark selected session completed",
				"Ctrl+E        mark selected session deferred",
				"Ctrl+X        abort running, delete idle, or restore deleted session",
				"Esc Esc       clear typed text",
				"Ctrl+C        exit this frontend without stopping service sessions",
			].join("\n"))
			return
		}
		if (name === "web") {
			if (!webEnabled) {
				setOverviewNotice(`${WEB_BROWSER_UI_NAME} is disabled; set web: true in settings.json to enable /web.`)
				return
			}
			await openWebOverview()
			return
		}
		if (name === "usage") {
			await showCodexUsageModal(tui, codexUsageBaseUrlFromSettings(settings), (payload) => applyCodexUsage(payload))
			return
		}
		if (name === "debug-log") {
			await showDebugLogModal(tui, options.stderrCapture, arg)
			requestShellRender()
			return
		}
		if (name === "model") {
			if (arg) {
				setOverviewNotice("use /model to choose interactively")
				return
			}
			await selectOverviewModel()
			return
		}
		if (name === "credentials") {
			await openCredentialsSettingsPage()
			return
		}
		if (name === "settings" && !arg) {
			await showSettingsEditor(overviewCommandCtx, {
				notify: setOverviewNotice,
				onSettingsChanged: applyOverviewSettings,
				setDefaultModel: setOverviewDefaultModel,
				setDefaultReasoning: async (level) => (await options.client.setDefaultReasoning?.(level))?.settings ?? updateSetting("thinkingLevel", /** @type {any} */ (level)),
				refreshAuthCache: refreshOverviewAuth,
			})
			return
		}
		if (name === "reasoning") {
			if (arg) {
				setOverviewNotice(`use /reasoning to choose interactively; reasoning=${reasoningLevelLabel(settings.thinkingLevel)}`)
				return
			}
			const level = await pickReasoningLevel(tui, "Default reasoning", "Applied to new sessions") ?? undefined
			if (!level) return
			const result = await options.client.setDefaultReasoning?.(level)
			const updated = result?.settings ?? await updateSetting("thinkingLevel", /** @type {any} */ (level))
			await applyOverviewSettings(updated)
			setOverviewNotice(`default reasoning → ${level}`)
			return
		}
		if (name === "reload") {
			await reloadUiSettingsAndAuth({ notify: setOverviewNotice, onSettingsChanged: applyOverviewSettings, refreshAuthCache: refreshOverviewAuth })
			return
		}
	}

	const enterFilterMode = () => {
		clearOverviewPromptImages()
		filterBeforeEdit = table.filter
		filterMode = true
		editor.setText(table.filter)
		requestShellRender()
	}
	const acceptFilterMode = () => {
		filterMode = false
		filterBeforeEdit = table.filter
		editor.setText("")
		requestShellRender()
	}
	const cancelFilterMode = () => {
		filterMode = false
		table.setFilter(filterBeforeEdit)
		syncCurrentOverviewRouteSelection()
		editor.setText("")
		scheduleOverviewWorktreeLoads()
		requestShellRender()
	}
	const clearOverviewSearch = () => {
		const wasFilterMode = filterMode
		filterMode = false
		filterBeforeEdit = ""
		if (table.filter) table.setFilter("")
		syncCurrentOverviewRouteSelection()
		if (wasFilterMode) editor.setText("")
	}

	editor.onSubmit = (text) => {
		const trimmed = text.trim()
		if (filterMode) {
			table.setFilter(text)
			syncCurrentOverviewRouteSelection()
			scheduleOverviewWorktreeLoads()
			acceptFilterMode()
			return
		}
		if (!trimmed) return
		const overviewCommand = overviewCommandLine(trimmed, { web: webEnabled })
		if (overviewCommand) {
			clearOverviewPromptImages()
			void handleOverviewCommand(overviewCommand).catch((err) => {
				if (showStaleRuntime(err)) return
				table.setNotice(`/${overviewCommand.trim().split(/\s+/, 1)[0]} error: ${err?.message ?? err}`)
				requestShellRender()
			})
			return
		}
		if (!webEnabled && isWebSlashCommand(trimmed)) {
			clearOverviewPromptImages()
			setOverviewNotice(`${WEB_BROWSER_UI_NAME} is disabled; set web: true in settings.json to enable /web.`)
			return
		}
		const attachments = overviewPromptAttachmentsForText(trimmed)
		const images = attachments.map((attachment) => attachment.image)
		const selected = table.peekSessionId ? table.selected() : undefined
		const targetId = selected && selected.id === table.peekSessionId ? selected.id : undefined
		if (targetId) {
			void (async () => {
				hasModelProvider = await hasAvailableModelProvider()
				if (!hasModelProvider) throw new Error(NO_MODEL_PROVIDER_OVERVIEW_ERROR)
				const streaming = selected.runStatus === "running"
				await options.client.prompt(targetId, trimmed, streaming ? "steer" : undefined, { images })
				clearOverviewPromptImagesForText(trimmed)
				scheduleRowsRefresh()
			})().catch((err) => {
				if (showStaleRuntime(err)) return
				if (err?.message === NO_MODEL_PROVIDER_OVERVIEW_ERROR) {
					highlightEmptyCredentialsGuidance = table.rows().length === 0
					if (!highlightEmptyCredentialsGuidance) table.setNotice(NO_MODEL_PROVIDER_EMPTY_GUIDANCE)
					editor.setText(trimmed)
				} else table.setActivity(targetId, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
		} else {
			void dispatchNew(trimmed, images).catch((err) => {
				if (showStaleRuntime(err)) return
				if (err?.message === NO_MODEL_PROVIDER_OVERVIEW_ERROR) {
					highlightEmptyCredentialsGuidance = table.rows().length === 0
					if (!highlightEmptyCredentialsGuidance) table.setNotice(NO_MODEL_PROVIDER_EMPTY_GUIDANCE)
				} else table.setNotice(`error: ${err?.message ?? err}`)
				editor.setText(trimmed)
				requestShellRender()
			})
		}
	}
	editor.onChange = (text) => {
		if (filterMode) {
			table.setFilter(text)
			syncCurrentOverviewRouteSelection()
			scheduleOverviewWorktreeLoads()
		}
		requestShellRender()
	}

	const refreshCurrentChatSnapshot = createCurrentChatSnapshotRefresher({
		getCurrentChat: () => currentChat,
		snapshot: (sessionId) => options.client.snapshot(sessionId),
		clearNotice: (predicate) => table.clearNotice(predicate),
		setNotice: (notice) => table.setNotice(notice),
		requestRender: requestShellRender,
		showStaleRuntime,
	})
	const applyOverviewSessionEvent = (event) => {
		if (event.type === "session_activity") {
			if (event.clear) table.clearActivity(event.sessionId)
			else if (event.text) table.setActivity(event.sessionId, event.text)
		}
		else if (event.type === "agent_start") table.setActivity(event.sessionId, "Thinking…")
		else if (event.type === "message_start" && event.message?.role === "assistant") table.setActivity(event.sessionId, "Generating…")
		else if (event.type === "message_update" && event.message?.role === "assistant") {
			const text = flattenContent(event.message.content).trim()
			if (text) table.setActivity(event.sessionId, text.slice(0, 120))
		}
		else if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = flattenContent(event.message.content).trim()
			if (text) table.setActivity(event.sessionId, `result: ${text.slice(0, 110)}`)
		}
		else if (event.type === "tool_execution_start") table.setActivity(event.sessionId, `Running ${event.toolName}…`)
		else if (event.type === "agent_end") {
			const activity = table.activity.get(event.sessionId) || ""
			if (/^(Thinking|Generating|Running)/.test(activity)) table.clearActivity(event.sessionId)
		}
	}
	const handleServiceEventError = (event, err) => {
		if (showStaleRuntime(err)) return
		const message = err?.message ?? String(err)
		let needsRender = false
		if (event?.sessionId) {
			if (overviewMounted) {
				table.setActivity(event.sessionId, `event error: ${message}`)
				needsRender = true
			}
			if (currentChat?.sessionId === event.sessionId) {
				refreshCurrentChatSnapshot(event.sessionId)
				needsRender = true
			}
		} else if (overviewMounted) {
			table.setNotice(`service event error: ${message}`)
			needsRender = true
		}
		if (needsRender) requestShellRender()
	}
	const handleServiceEvent = (event) => {
		let needsRender = false
		if (event.type === "sessions") {
			if (overviewMounted) {
				if (settings.showDeletedSessions === true || showHiddenSessions) scheduleRowsRefresh(true)
				else {
					table.setSessions(event.sessions)
					scheduleRowsRefresh(false)
					scheduleOverviewWorktreeLoads()
				}
				needsRender = true
			}
		}
		else if (event.sessionId) {
			if (event.type === "worktree_status") {
				if (overviewMounted) {
					table.setWorktrees(event.sessionId, event.worktrees, { loadedAt: event.loadedAt })
					table.clearNotice((notice) => notice.startsWith(OVERVIEW_WORKTREE_STATUS_ERROR_NOTICE_PREFIX))
					needsRender = true
				}
				if (currentChat?.sessionId === event.sessionId) {
					currentChat.updateSessionWorktrees(event.sessionId, event.worktrees, event.loadedAt)
					needsRender = true
				}
			}
			else {
				if (overviewMounted) {
					applyOverviewSessionEvent(event)
					needsRender = true
				}
				if (currentChat?.sessionId === event.sessionId) {
					if (event.type === "snapshot" && event.snapshot) currentChat.updateFromEventSnapshot(event.snapshot)
					else if (event.type === "session_activity") {}
					else {
						if (!eventInvalidatesSessionSnapshot(event, currentChat.sessionId)) currentChat.handleEvent(event)
						if (eventNeedsServiceChatSnapshot(event)) refreshCurrentChatSnapshot(event.sessionId)
					}
					needsRender = true
				}
				const finishedTurn = event.type === "agent_end" || (event.type === "session_activity" && event.sourceEventType === "agent_end")
				if (finishedTurn && subscriptionProviders.has("openai-codex")) scheduleCodexUsageRefresh()
				if (overviewMounted && eventNeedsServiceSessionRefresh(event)) scheduleRowsRefresh(finishedTurn)
			}
		} else if (eventIsServiceLiveRecovery(event)) {
			if (currentChat?.sessionId) {
				refreshCurrentChatSnapshot(currentChat.sessionId)
				needsRender = true
			}
			if (overviewMounted) {
				scheduleRowsRefresh(false)
				scheduleOverviewWorktreeLoads({ force: true })
				needsRender = true
			}
		} else if (event.type === "error") {
			if (showStaleRuntime(event.error)) return
			if (overviewMounted) {
				table.setNotice(`service event error: ${event.error}`)
				needsRender = true
			}
		}
		if (needsRender) requestShellRender()
	}

	const subscribeToServiceEvents = (subscribeOptions = {}) => options.client.subscribe((event) => {
		try {
			handleServiceEvent(event)
		} catch (err) {
			handleServiceEventError(event, err)
		}
	}, subscribeOptions)

	const openActiveSessionSubscription = (sessionId) => {
		closeServiceSubscription(activeSessionUnsubscribe)
		activeSessionUnsubscribe = undefined
		if (staleRuntimeActive || !liveUpdatesAllowed()) return
		activeSessionUnsubscribe = subscribeToServiceEvents({ sessionId })
	}

	const reconcileSuspendedLiveUpdates = async () => {
		if (staleRuntimeActive) return
		let changed = false
		if (overviewMounted && typeof options.client.sessionsStatus === "function") {
			const status = await options.client.sessionsStatus(overviewSessionListCwd(), overviewSessionListOptions())
			if (sessionsStatusIndicatesListStale(status, table.sessions)) {
				table.setSessions(await options.client.sessions(overviewSessionListCwd(), overviewSessionListOptions()))
				scheduleOverviewWorktreeLoads({ force: true })
				changed = true
			}
		}
		if (currentChat?.sessionId && typeof options.client.sessionStatus === "function") {
			const sessionId = currentChat.sessionId
			const status = await options.client.sessionStatus(sessionId)
			if (currentChat?.sessionId === sessionId && sessionStatusIndicatesSnapshotStale(status, currentChat.snapshot)) {
				refreshCurrentChatSnapshot(sessionId)
				void currentChat.refreshSessionWorktrees({ force: true })
				changed = true
			}
		}
		if (changed) requestShellRender()
	}
	backgroundReconciler = createBackgroundReconciler(reconcileSuspendedLiveUpdates, {
		intervalMs: DEFAULT_BACKGROUND_RECONCILE_INTERVAL_MS,
		onError: handleRefreshError,
	})

	const suspendLiveUpdates = () => {
		currentChat?.flushPromptDraft()
		scheduleRowsRefresh.cancel()
		scheduleCodexUsageRefresh.cancel()
		stopOverviewWorktreeStatusTimer()
		closeServiceSubscription(overviewUnsubscribe)
		overviewUnsubscribe = undefined
		closeServiceSubscription(activeSessionUnsubscribe)
		activeSessionUnsubscribe = undefined
		backgroundReconciler?.start({ immediate: true })
	}

	const resumeLiveUpdates = ({ missedUpdates }) => {
		backgroundReconciler?.stop()
		if (staleRuntimeActive) return
		if (overviewMounted) {
			startOverviewSubscription()
			startOverviewWorktreeStatusTimer()
		}
		if (currentChat?.sessionId) openActiveSessionSubscription(currentChat.sessionId)
		if (missedUpdates) {
			if (overviewMounted) void refreshRows().then(() => scheduleOverviewWorktreeLoads({ force: true })).catch(handleRefreshError)
			if (currentChat?.sessionId) {
				refreshCurrentChatSnapshot(currentChat.sessionId)
				void currentChat.refreshSessionWorktrees({ force: true })
			}
			if (subscriptionProviders.has("openai-codex")) scheduleCodexUsageRefresh(true)
		}
		requestShellRender()
	}

	liveUpdatePresence = createPresenceUpdateGate({
		onSuspend: suspendLiveUpdates,
		onResume: resumeLiveUpdates,
		onError: (err) => handleServiceEventError(undefined, err),
	})

	tui.addMouseListener((event) => {
		if (tui.hasOverlay()) return undefined
		if (currentChat?.handleMouseEvent(event)) return { consume: true }
		return undefined
	})

	const focusEditorAndHandleInput = (targetEditor, data) => {
		tui.setFocus(targetEditor)
		targetEditor.handleInput(data)
		requestShellRender()
		return { consume: true }
	}

	tui.addInputListener((data) => {
		const terminalPresent = terminalFocusPresence(data)
		if (terminalPresent !== undefined) {
			liveUpdatePresence?.setPresent(terminalPresent, terminalPresent ? "terminal-focus-in" : "terminal-focus-out")
			return { consume: true }
		}
		if (staleRuntimeActive) {
			if (matchesKey(data, "ctrl+c")) void exit()
			else if (staleRuntimeRetryable && !isKeyRelease(data) && matchesKey(data, "enter")) void reexecStaleRuntime()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+c")) {
			void exit()
			return { consume: true }
		}
		if (tui.hasOverlay()) return undefined
		if (currentChat) {
			if (currentChat.handleTranscriptScrollInput(data)) return { consume: true }
			if (isKeyRelease(data)) return undefined
			const promptText = currentChat.editor.getText()
			const routeShortcutsActive = routeHistoryShortcutAllowed({ focused: currentChat.editor.focused })
			const pageBackShortcutActive = sessionPageBackShortcutAllowed({ text: promptText })
			if (routeShortcutsActive && matchesRouteBackShortcut(data)) {
				goRouteBack()
				return { consume: true }
			}
			if (routeShortcutsActive && matchesRouteForwardShortcut(data)) {
				goRouteForward()
				return { consume: true }
			}
			if ((matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+alt+v"))) {
				tui.setFocus(currentChat.editor)
				void currentChat.pasteClipboardImage()
				return { consume: true }
			}
			if (matchesKey(data, "ctrl+g") && currentChat.editor.focused) {
				showAgents({ selectSessionId: currentChat.sessionId })
				return { consume: true }
			}
			if (matchesKey(data, "left") && pageBackShortcutActive) {
				showAgents({ selectSessionId: currentChat.sessionId })
				return { consume: true }
			}
			if (matchesKey(data, "escape")) {
				if (promptText.trim() !== "") {
					doubleEscape.reset()
					if (currentChat.editor.focused && currentChat.editor.isShowingAutocomplete()) {
						textDoubleEscape.reset()
						return undefined
					}
					if (textDoubleEscape.press()) {
						currentChat.clearPromptImagesForText(promptText)
						currentChat.editor.setText("")
						currentChat.tui.requestRender()
						return { consume: true }
					}
					if (currentChat.editor.focused && !currentChat.editor.isShowingAutocomplete()) {
						tui.setFocus(null)
						requestShellRender()
						return { consume: true }
					}
					return { consume: true }
				}
				textDoubleEscape.reset()
				if (currentChat.hasInterruptibleTurn()) {
					doubleEscape.reset()
					currentChat.requestEscapeInterrupt()
					return { consume: true }
				}
				if (doubleEscape.press()) {
					currentChat?.handleSlash("rewind")
						.catch((err) => {
							if (showStaleRuntime(err)) return
							currentChat?.appendLine(theme.red(`[escape error] ${err?.message ?? err}`))
						})
				}
				return { consume: true }
			}
			if (!currentChat.editor.focused && isEditorTextInput(data)) {
				textDoubleEscape.reset()
				return focusEditorAndHandleInput(currentChat.editor, data)
			}
			return undefined
		}
		if (isKeyRelease(data)) return undefined
		if (currentRoute.type === "session") {
			if (matchesRouteBackShortcut(data)) {
				goRouteBack()
				return { consume: true }
			}
			if (matchesRouteForwardShortcut(data)) {
				goRouteForward()
				return { consume: true }
			}
			if (matchesKey(data, "ctrl+g") || matchesKey(data, "left") || matchesKey(data, "escape")) {
				showAgents({ selectSessionId: currentRoute.id })
				return { consume: true }
			}
			if (routeLoadingShell.error && matchesKey(data, "enter")) {
				void openSession(currentRoute.id, { routeHistory: "none" })
				return { consume: true }
			}
			return { consume: true }
		}
		const overviewText = editor.getText()
		const overviewEmpty = overviewText.trim() === ""
		const overviewRouteShortcutsActive = !filterMode && routeHistoryShortcutAllowed({ focused: editor.focused })
		const overviewPageKeysActive = !filterMode && (!editor.focused || overviewEmpty)
		if (overviewRouteShortcutsActive && matchesRouteBackShortcut(data)) {
			goRouteBack()
			return { consume: true }
		}
		if (overviewRouteShortcutsActive && matchesRouteForwardShortcut(data)) {
			goRouteForward()
			return { consume: true }
		}
		if (!filterMode && (matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+alt+v"))) {
			tui.setFocus(editor)
			void pasteOverviewClipboardImage()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "shift+ctrl+s")) {
			toggleHiddenSessions()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+s")) {
			toggleOverviewDirectoryFilter()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+f")) {
			if (filterMode) acceptFilterMode()
			else {
				tui.setFocus(editor)
				enterFilterMode()
			}
			return { consume: true }
		}
		if (filterMode && matchesKey(data, "enter")) {
			acceptFilterMode()
			return { consume: true }
		}
		if (filterMode && matchesKey(data, "escape")) {
			cancelFilterMode()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "escape")) {
			if (editor.isShowingAutocomplete()) return undefined
			if (overviewText.length > 0) {
				if (overviewTextDoubleEscape.press()) {
					clearOverviewPromptImages()
					editor.setText("")
					requestShellRender()
					return { consume: true }
				}
				if (editor.focused) {
					tui.setFocus(null)
					requestShellRender()
					return { consume: true }
				}
				return { consume: true }
			}
			overviewTextDoubleEscape.reset()
			if (editor.focused) {
				tui.setFocus(null)
				requestShellRender()
			}
			return { consume: true }
		}
		if (!editor.focused && isEditorTextInput(data)) {
			overviewTextDoubleEscape.reset()
			return focusEditorAndHandleInput(editor, data)
		}
		if (matchesKey(data, "up") && overviewPageKeysActive) {
			table.move(-1)
			scheduleOverviewWorktreeLoads()
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "down") && overviewPageKeysActive) {
			table.move(1)
			scheduleOverviewWorktreeLoads()
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "pageup") && overviewPageKeysActive) {
			table.page(-1)
			scheduleOverviewWorktreeLoads()
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "pagedown") && overviewPageKeysActive) {
			table.page(1)
			scheduleOverviewWorktreeLoads()
			requestShellRender()
			return { consume: true }
		}
		if (!filterMode && (matchesKey(data, "right") || matchesKey(data, "enter")) && overviewPageKeysActive) {
			table.activateSelected()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "space") && overviewPageKeysActive) {
			if (table.activateMore()) {
				scheduleOverviewWorktreeLoads()
				requestShellRender()
				return { consume: true }
			}
			const previousPeekSessionId = table.peekSessionId
			table.togglePeek()
			scheduleOverviewWorktreeLoads()
			const selected = table.selected()
			if (selected && !selected.deletedAt && table.peekSessionId === selected.id && table.peekSessionId !== previousPeekSessionId) {
				void loadPeekWorktrees(selected.id, { refresh: true })
			}
			requestShellRender()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+e") && overviewPageKeysActive) {
			const selected = table.selected()
			if (selected) applySelectedStateAction(selected, "deferred")
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+d") && overviewPageKeysActive) {
			const selected = table.selected()
			if (selected) applySelectedStateAction(selected, "completed")
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+x") && overviewPageKeysActive) {
			const selected = table.selected()
			if (selected) applySessionLifecycleAction(selected)
			return { consume: true }
		}
		return undefined
	})

	let startupIssue
	let startupCheckNotice
	try {
		startupIssue = await nativeSandboxStartupIssue()
	} catch (err) {
		startupCheckNotice = `native sandbox startup check skipped: ${err?.message ?? err}`
	}
	const startupPage = startupIssue
		? new NativeSandboxStartupPage({
			issue: startupIssue,
			requestRender: () => tui.requestRender(),
		})
		: undefined
	const startupDone = startupPage?.start()
	liveUpdatePresence.start()
	if (startupPage) root.addChild(startupPage)
	else mountCurrentRouteSurface()
	tui.addChild(root)
	tui.setFocus(startupPage ?? null)
	let tuiStarted = false
	enterTuiTerminal()
	try {
		tui.start()
		tui.setMouseReporting(true)
		tui.setFocusReporting(true)
		tuiStarted = true
		if (startupDone && startupPage) {
			await startupDone
			startupPage.dispose()
			unmountOverview()
			root.clear()
			mountCurrentRouteSurface()
			tui.setFocus(null)
			requestShellRender(true)
		}
		if (startupCheckNotice) {
			table.setNotice(startupCheckNotice)
			requestShellRender()
		}
		void refreshOverviewAuth().catch(() => {})
		if (currentRoute.type === "overview") {
			try {
				await refreshRows()
			} catch (err) {
				if (!showStaleRuntime(err)) throw err
			}
		}
		if (currentRoute.type === "session" && !staleRuntimeActive) {
			try {
				await openSession(currentRoute.id)
			} catch (err) {
				if (!showStaleRuntime(err)) throw err
			}
		}
		if (currentRoute.type === "settings-credentials" && !staleRuntimeActive) {
			await openCredentialsSettingsPage()
		} else if (!staleRuntimeActive && !(await hasConfiguredProviderCredentials())) {
			await openCredentialsSettingsPage({ onboarding: true })
		}
		if (!staleRuntimeActive && currentRoute.type === "overview") {
			void checkForUpdateNotice(settings)
				.then((notice) => {
					if (!notice || staleRuntimeActive || currentRoute.type !== "overview") return
					setOverviewBottomNotice({ text: notice.message, tone: "warn" }, { timeoutMs: UPDATE_CHECK_NOTICE_MS })
				})
				.catch(() => {})
		}

		await new Promise(() => {})
	} catch (err) {
		if (tuiStarted && !exiting) {
			try {
				stopTui()
			} catch {
				leaveTuiTerminal()
			}
		} else {
			leaveTuiTerminal()
		}
		throw err
	}
}
