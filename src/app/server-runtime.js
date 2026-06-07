// Pinano server runtime manager. Each opened session gets its own live Agent
// runtime, mirroring separate TUI processes inside one backend process.

import { randomUUID } from "node:crypto"
import { basename } from "node:path"

import { messageHasRetryableModelError } from "../ai-apis/model-errors.js"
import { contextLoadDisplayMessage } from "../session-manager/context-display.js"
import { normalizeReasoningLevel } from "../reasoning.js"
import { isModelIoLogEnabled } from "../ai-apis/model-io-log.js"
import { contextFileIdentity } from "../session-manager/context-identity.js"
import { ensureProjectContextMessage, isProjectContextMessage, loadProjectContextForCwd } from "./project-context.js"
import { compact, summarizeMessages } from "./compaction.js"
import { systemPromptFor } from "./agent-factory.js"
import { toolProfileForModel } from "./model-instructions.js"
import { modelRef, refreshModelFromRegistry, refreshModelWithProviderMetadata, resolveModel, resolveModelWithProviderMetadata } from "./models.js"
import { branchSession, createSession, createSessionId, loadSessionPreview, openSession, sessionPreviewFromMessages } from "./session-store.js"
import { sessionActivityAt } from "./session-activity.js"
import { deriveSessionRunState, startedToolsWithoutDurableResult, synthesizeUnknownToolResultsForStartedTools } from "./session-run-state.js"
import { completeEnvironmentPatch, getEnvironment, initialSessionEnvironment, loadEnvironmentRegistry, resolveConfiguredEnvironmentId } from "./environments.js"
import { handleFastCommand } from "./fast-mode.js"
import { createPinanoJsApi } from "./pinano-js-api.js"
import { restoreFilesToCheckpoint, appendFileRestoreEntry, deleteFileCheckpoints, fileCheckpointsForRestore } from "./file-checkpoints.js"
import { messageKey } from "./session-state.js"
import { activeContextFiles, buildModelMessagesForSession, contextFilesDisabledForAgent, conversationEntriesForModel } from "./session-context.js"
import { environmentContextFor, prependEnvironmentContext, sessionWorkspaceToolPathForEnvironment } from "./environment-context.js"
import { summarizeContext } from "./context-summary.js"
import { formatContextReport } from "./context-report.js"
import { formatSystemReport } from "./project-context-display.js"
import { sessionWorkspacePath } from "./paths.js"
import { pinanoStateMountFromSettings } from "./settings.js"
import { branchNoticeMessage, branchSessionWorkspace } from "./session-workspaces.js"
import { DOCKER_PROXY_ROUTE, handleDockerProxyRequest } from "../proxy-tools/docker/host.js"
import { GIT_WORKTREE_CUSTOM_TYPE, normalizeGitWorktreeEventPayload, sessionGitWorktreeStatuses } from "./git-worktree-events.js"
import { internalHttpJsonResponse, internalHttpRequestBodyText } from "./worker-internal-http.js"
import { isPromptImageMarkerText, promptContentWithImages, promptImageLabel, promptImagePlaceholders } from "../prompt-images.js"
import {
	SESSION_CUSTOM_TYPE_PROPERTIES,
	SESSION_MODEL_WRITABLE_STATES,
	SESSION_PROPERTY_STATES,
	SESSION_READY_FOR_REVIEW_STATE,
	SESSION_SET_TOOL_NAME,
	createMaintenancePromptMessage,
	getEffectiveSessionProperties,
	hasSessionPropertyEntries,
	isAutomatedMaintenanceMessage,
	isHumanUserEntry,
	normalizeSessionPropertyPatch,
	patchIsMeaningful,
	sessionPropertiesToAgentView,
} from "./session-properties.js"
import {
	SESSION_CUSTOM_TYPE_BRANCH_SWITCH,
	SESSION_CUSTOM_TYPE_FILE_RESTORE,
	SESSION_CUSTOM_TYPE_REWIND,
	isBranchSwitchCustomType,
	isRewindCustomType,
} from "./session-custom-types.js"
/** @typedef {import("./agent-runtime.js").AgentRuntime} Agent */
/** @typedef {import("../session-manager/index.js").Session} Session */
/** @typedef {import("./server-db.js").ServerDb} ServerDb */

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_IDLE_RUNTIMES = 64
const LEGACY_AGENT_VIEW_COMPLETION_WINDOW_MS = 48 * 60 * 60 * 1000
const MODEL_RETRY_MAX_ATTEMPTS = 3
const MODEL_RETRY_BASE_DELAY_MS = 1000

function parseInternalJsonBody(request) {
	try {
		return JSON.parse(internalHttpRequestBodyText(request) || "{}")
	} catch {
		throw Object.assign(new Error("Invalid JSON body"), { status: 400 })
	}
}

/**
 * @param {any} message
 * @param {{ retainedMaintenanceToolCallIds?: Set<string> }} [options]
 */
export function projectVisibleMessage(message, options = {}) {
	if (!message || message.pinanoHidden || isProjectContextMessage(message) || message.pinanoCompactionMemento || message.pinanoCompactionSummary) return undefined
	if (!message.pinanoAutomated && !message.pinanoMaintenance) return message
	const retainedToolCallIds = options.retainedMaintenanceToolCallIds
	if (message.role === "assistant") {
		const sessionWrites = Array.isArray(message.content)
			? message.content.filter((block) => block?.type === "toolCall" && block.name === SESSION_SET_TOOL_NAME && block.id)
			: []
		if (sessionWrites.length === 0) return undefined
		for (const block of sessionWrites) retainedToolCallIds?.add(block.id)
		const projected = { ...message, content: sessionWrites, pinanoMaintenanceAudit: true }
		delete projected.pinanoAutomated
		delete projected.pinanoMaintenance
		return projected
	}
	if (message.role === "toolResult" && retainedToolCallIds?.has(message.toolCallId)) {
		const projected = { ...message }
		delete projected.pinanoAutomated
		delete projected.pinanoMaintenance
		return projected
	}
	return undefined
}

/** @param {any} message */
export function visibleMessage(message) {
	return projectVisibleMessage(message) !== undefined
}

/** @param {any[]} messages */
export function visibleMessages(messages) {
	const retainedMaintenanceToolCallIds = new Set()
	return messages.map((message) => projectVisibleMessage(message, { retainedMaintenanceToolCallIds })).filter(Boolean)
}

/** @param {Array<{ message: any, entryId: string }>} entries */
function projectVisibleEntries(entries) {
	const retainedMaintenanceToolCallIds = new Set()
	return entries.flatMap((entry) => {
		const message = projectVisibleMessage(entry.message, { retainedMaintenanceToolCallIds })
		return message ? [{ ...entry, message }] : []
	})
}

/** @param {unknown} content */
export function textFromContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return /** @type {any[]} */ (content)
		.filter((block) => block?.type === "text")
		.filter((block) => !isPromptImageMarkerText(block.text ?? ""))
		.map((block) => block.text || "")
		.join("")
}

/** @param {unknown} content */
export function imageBlocksFromContent(content) {
	if (!Array.isArray(content)) return []
	return /** @type {any[]} */ (content)
		.filter((block) => block?.type === "image")
		.map((block) => ({ ...block }))
}

const PROMPT_IMAGE_LABEL_RE = /\[Image #\d+\]/g

/** @param {string} text */
function uniquePromptImageLabels(text) {
	const seen = new Set()
	return promptImagePlaceholders(text)
		.map((item) => item.placeholder)
		.filter((label) => {
			if (seen.has(label)) return false
			seen.add(label)
			return true
		})
}

/** @param {string} text @param {Map<string, string>} replacements */
function replacePromptImageLabels(text, replacements) {
	if (replacements.size === 0) return text
	return text.replace(PROMPT_IMAGE_LABEL_RE, (label) => replacements.get(label) ?? label)
}

/** @param {any} message */
function promptDraftPartFromMessage(message) {
	return {
		text: textFromContent(message?.content),
		images: imageBlocksFromContent(message?.content),
	}
}

/** @param {{ text: string, images: any[] }[]} parts */
function promptDraftFromParts(parts) {
	let nextImageNumber = 1
	const textParts = []
	const images = []
	for (const part of parts) {
		const labels = uniquePromptImageLabels(part.text)
		const replacements = new Map()
		const generatedLabels = []
		for (let i = 0; i < part.images.length; i += 1) {
			const nextLabel = promptImageLabel(nextImageNumber)
			nextImageNumber += 1
			if (labels[i]) replacements.set(labels[i], nextLabel)
			else generatedLabels.push(nextLabel)
			images.push(part.images[i])
		}
		const text = replacePromptImageLabels(part.text, replacements)
		const generatedPrefix = generatedLabels.join("\n")
		let restoredText = text
		if (generatedPrefix) {
			if (!text) restoredText = generatedPrefix
			else if (labels.length > 0) restoredText = `${text}\n\n${generatedPrefix}`
			else restoredText = `${generatedPrefix}\n\n${text}`
		}
		if (restoredText) textParts.push(restoredText)
	}
	return { text: textParts.join("\n\n"), images }
}

/** @param {any} message */
function isCancellableUserMessage(message) {
	return message?.role === "user" && !isAutomatedMaintenanceMessage(message) && !isProjectContextMessage(message)
}

/** @param {Agent} agent */
function queuedCancellableUserMessages(agent) {
	return (agent.getQueuedMessages?.() ?? [])
		.map((item) => item?.message ?? item)
		.filter(isCancellableUserMessage)
}

/** @param {Session} session @param {any} promptEntry */
function cancellableBranchUserMessages(session, promptEntry) {
	const branch = session.getBranch()
	const promptIndex = branch.findIndex((entry) => entry.id === promptEntry.id)
	const entries = promptIndex >= 0 ? branch.slice(promptIndex) : [promptEntry]
	return entries
		.filter((entry) => isHumanUserEntry(entry) && !isProjectContextMessage(entry.message))
		.map((entry) => entry.message)
}

/** @param {any[]} messages */
function promptDraftFromMessages(messages) {
	return promptDraftFromParts(messages.map(promptDraftPartFromMessage))
}

/** @param {string} value @param {number} max */
function cleanText(value, max = 160) {
	return String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
}

/** @param {string | undefined} text */
export function isShortCompletionConfirmation(text) {
	const normalized = String(text || "").replace(/\s+/g, " ").trim().toLowerCase()
	if (!normalized) return false
	const wordCount = normalized.split(/\s+/).length
	return wordCount < 20 && (/\bdone\b/.test(normalized) || /\ball set\b/.test(normalized))
}

/** @param {any[]} messages */
function sessionPropertiesMaintenanceExchangeActive(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === "user") return isAutomatedMaintenanceMessage(message) && message.pinanoMaintenance === SESSION_CUSTOM_TYPE_PROPERTIES
	}
	return false
}

/** @param {string} cwd */
function fallbackProjectTag(cwd) {
	const words = cleanText(basename(cwd || "").replace(/^\.+/, ""), 40).toLowerCase().split(" ").filter(Boolean).slice(0, 3)
	return words.join(" ") || undefined
}

/** @param {any[]} messages */
function firstVisibleUserText(messages) {
	const message = messages.find((m) => m?.role === "user" && visibleMessage(m))
	return cleanText(textFromContent(message?.content), 160)
}

/** @param {string | undefined} updatedAt @param {number} now */
function olderThanLegacyCompletionWindow(updatedAt, now = Date.now()) {
	const time = new Date(updatedAt || 0).getTime()
	return Number.isFinite(time) && now - time > LEGACY_AGENT_VIEW_COMPLETION_WINDOW_MS
}

/** @param {any} agentView */
function needsLegacyAgentViewFallback(agentView) {
	if (!agentView?.state) return true
	return agentView.state === "idle" || agentView.state === "failed" || agentView.state === "stopped" || agentView.state === "working" || agentView.state === "experiencing_problems" || !agentView.description || !agentView.projectTag
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {any} preview */
function hasVisibleConversation(preview) {
	return Boolean(preview?.first || preview?.lastUser)
}

/** @param {any} preview */
function hasVisibleUserPrompt(preview) {
	return Boolean(preview?.lastUser)
}

/** @param {any} entry @param {any} preview @param {boolean} liveRunning */
function lifecycleStateForSession(entry, preview, liveRunning) {
	if (liveRunning || entry.runStatus === "running" || entry.runtimeState === "running") return "running"
	if ((entry.runStatus === undefined || entry.runStatus === "idle") && !hasVisibleConversation(preview) && !entry.agentView) return "not_started"
	return "stopped"
}

/** @param {any} entry @param {any} preview @param {number} now */
function fallbackAgentViewState(entry, preview, now) {
	if (!hasVisibleUserPrompt(preview)) return undefined
	return olderThanLegacyCompletionWindow(entry.updatedAt, now) ? "completed" : "ready_for_review"
}

/** @param {any} entry */
function autoResumableWorkerCrash(entry) {
	return entry.runStatus === "failed"
		&& /Tool executor (?:closed|exited) (?:before init|during executeTool)/.test(entry.latestRunError || "")
}

/** @param {any} entry */
function autoResumeCandidate(entry) {
	return entry.runStatus === "interrupted" || entry.runtimeState === "interrupted" || autoResumableWorkerCrash(entry)
}

/** @param {any} entry @param {any} preview */
function completedLegacyMetadata(entry, preview) {
	const previous = entry.agentView
	return {
		state: "completed",
		description: previous?.description || cleanText(preview.first?.text || preview.lastUser?.text || entry.cwd, 160),
		projectTag: previous?.projectTag || fallbackProjectTag(entry.cwd),
		updatedAt: new Date().toISOString(),
	}
}

/** @param {any} entry */
export function entryMessageText(entry) {
	return textFromContent(entry?.message?.content).trim()
}

/** @param {any} entry */
function entrySummary(entry) {
	if (entry.type !== "message") {
		if (entry.customType === "compaction") return "compaction marker"
		if (isRewindCustomType(entry.customType)) return `rewind: ${entry.data?.text || entry.data?.targetEntryId || entry.id}`
		if (isBranchSwitchCustomType(entry.customType)) return `branch switch: ${entry.data?.targetEntryId || entry.id}`
		if (entry.customType === SESSION_CUSTOM_TYPE_FILE_RESTORE) return `file restore: ${(entry.data?.restored ?? []).length} file(s)`
		if (entry.customType === SESSION_CUSTOM_TYPE_PROPERTIES) return "session properties"
		return entry.type
	}
	const message = entry.message
	if (message.role === "user") return `user: ${entryMessageText(entry).slice(0, 80)}`
	if (message.role === "assistant") return `assistant: ${(textFromContent(message.content) || "(tool call)").slice(0, 80)}`
	if (message.role === "toolResult") return `tool: ${message.toolName || "result"}`
	return message.role || "message"
}

/** @param {Session} session */
export function buildRewindTargets(session) {
	const entries = /** @type {any[]} */ (session.getEntries())
	const userEntries = entries.filter((e) => isHumanUserEntry(e) && !isProjectContextMessage(e.message))
	const userIds = new Set(userEntries.map((e) => e.id))
	const entryById = new Map(entries.map((e) => [e.id, e]))
	const leafIds = new Set(buildBranchTipItems(session).map((leaf) => leaf.id))
	const userParentOf = (id) => {
		let cur = entryById.get(id)?.parentId ?? null
		while (cur !== null) {
			if (userIds.has(cur)) return cur
			cur = entryById.get(cur)?.parentId ?? null
		}
		return null
	}
	const activePath = new Set()
	let cur = session.getLeafId()
	while (cur) {
		if (userIds.has(cur)) activePath.add(cur)
		cur = entryById.get(cur)?.parentId ?? null
	}
	const userTargets = userEntries.map((e) => ({
		kind: "message",
		id: e.id,
		parentId: userParentOf(e.id),
		text: entryMessageText(e) || entrySummary(e),
		onActivePath: activePath.has(e.id),
		isLeaf: leafIds.has(e.id),
		active: e.id === session.getLeafId(),
		hasFileCheckpoints: fileCheckpointsForRestore(session, e.id).length > 0,
	}))
	const userTargetIds = new Set(userTargets.map((target) => target.id))
	const leafTargets = entries
		.filter((e) => leafIds.has(e.id) && !userTargetIds.has(e.id))
		.map((e) => {
			const displayEntry = isBranchSwitchCustomType(e.customType)
				? entryById.get(e.data?.targetEntryId) ?? e
				: e
			return {
				kind: "leaf",
				id: e.id,
				parentId: userParentOf(e.id),
				text: `tip: ${entrySummary(displayEntry)}`,
				onActivePath: false,
				isLeaf: true,
				active: e.id === session.getLeafId(),
				hasFileCheckpoints: false,
			}
		})
		.filter((target) => target.parentId !== null)
	return [...userTargets, ...leafTargets]
}

/** @param {Session} session */
export function buildBranchTipItems(session) {
	const entries = /** @type {any[]} */ (session.getEntries())
	/** @type {Map<string | null, string[]>} */
	const childrenOf = new Map()
	for (const e of entries) {
		const parentId = e.parentId ?? null
		const arr = childrenOf.get(parentId) ?? []
		arr.push(e.id)
		childrenOf.set(parentId, arr)
	}
	return entries
		.filter((e) => !childrenOf.get(e.id))
		.map((e) => ({
			id: e.id,
			label: e.id.slice(0, 8),
			description: entrySummary(e),
			active: e.id === session.getLeafId(),
		}))
}

/** @param {any} entry */
function sessionInfoFromEntry(entry) {
	if (!entry) return undefined
	return {
		id: entry.id,
		cwd: entry.cwd,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		runStatus: entry.runStatus,
		runtimeState: entry.runtimeState,
		overview: entry.agentView ?? {},
	}
}

function sessionConfigForAgent(agent, extra = {}) {
	return {
		version: 1,
		modelRef: agent.state.model ? modelRef(agent.state.model) : undefined,
		model: agent.state.model,
		baseUrl: agent.state.model?.baseUrl,
		thinkingLevel: agent.state.thinkingLevel,
		serviceTier: agent.state.serviceTier,
		toolProfile: toolProfileForModel(agent.state.model),
		noContextFiles: false,
		permissions: { mode: "default" },
		...extra,
	}
}

function sessionWorkspacePathMappingsForEnvironment(sourceId, targetId, sourceProps, sourceConfig, sourceRuntime) {
	const registry = loadEnvironmentRegistry()
	const environmentId = resolveConfiguredEnvironmentId(sourceProps.environmentId, registry)
	const environment = getEnvironment(environmentId, registry)
	const initialCwd = sourceConfig.worktree ?? sourceConfig.cwd ?? sourceRuntime.session.getMetadata?.()?.cwd ?? sourceRuntime.cwd
	const sourceDir = sessionWorkspacePath(sourceId)
	const targetDir = sessionWorkspacePath(targetId)
	const pinanoStateMount = pinanoStateMountFromSettings(sourceRuntime.getSettings?.())
	const sourceToolDir = sessionWorkspaceToolPathForEnvironment(environment, initialCwd, undefined, sourceDir, undefined, pinanoStateMount)
	const targetToolDir = sessionWorkspaceToolPathForEnvironment(environment, initialCwd, undefined, targetDir, undefined, pinanoStateMount)
	if (!sourceToolDir || !targetToolDir) return []
	if (sourceToolDir === sourceDir && targetToolDir === targetDir) return []
	return [{ sourceDir: sourceToolDir, targetDir: targetToolDir }]
}

function applyAgentModel(agent, cwd, nextModel) {
	agent.state.model = nextModel
	agent.state.systemPrompt = systemPromptFor(cwd, agent.state.model)
	agent.refreshToolsForModel?.(agent.state.model)
}

function applySessionConfig(agent, session, cwd) {
	const config = session.getSessionConfig?.() ?? {}
	let nextModel
	if (config.model) {
		nextModel = refreshModelFromRegistry(config.model, config.modelRef)
	} else if (config.modelRef) {
		nextModel = resolveModel(config.modelRef)
	}
	if (config.baseUrl && (nextModel ?? agent.state.model)) {
		nextModel = refreshModelFromRegistry({ ...(nextModel ?? agent.state.model), baseUrl: config.baseUrl }, config.modelRef)
	}
	if (nextModel) applyAgentModel(agent, cwd, nextModel)
	if (config.thinkingLevel) agent.state.thinkingLevel = normalizeReasoningLevel(config.thinkingLevel) ?? config.thinkingLevel
	if (Object.prototype.hasOwnProperty.call(config, "serviceTier")) agent.state.serviceTier = config.serviceTier ?? undefined
	if (Object.prototype.hasOwnProperty.call(config, "noContextFiles")) agent.contextFilesDisabled = config.noContextFiles === true
}

async function applySessionProviderMetadata(agent, session, cwd, settings = undefined) {
	const config = session.getSessionConfig?.() ?? {}
	let nextModel
	if (config.model) {
		nextModel = await refreshModelWithProviderMetadata(config.model, config.modelRef, { providers: settings?.providers })
	} else if (config.modelRef) {
		nextModel = await resolveModelWithProviderMetadata(config.modelRef, { providers: settings?.providers })
	}
	if (config.baseUrl && (nextModel ?? agent.state.model)) {
		nextModel = await refreshModelWithProviderMetadata({ ...(nextModel ?? agent.state.model), baseUrl: config.baseUrl }, config.modelRef, { providers: settings?.providers })
	}
	if (nextModel) applyAgentModel(agent, cwd, nextModel)
}

export class SessionRuntime {
	/**
	 * @param {object} options
	 * @param {string} options.sessionId
	 * @param {string} options.cwd
	 * @param {Session} options.session
	 * @param {Agent} options.agent
	 * @param {ServerDb} options.db
	 * @param {(event: any) => void} options.emit
	 * @param {() => Promise<any[]>} options.sessions
	 * @param {(sessionId: string) => Promise<void>} options.invalidateSnapshot
	 * @param {() => number} options.nextEventSeq
	 * @param {() => number} options.getEventSeq
	 * @param {() => number} options.getViewEpoch
	 * @param {() => number} options.bumpViewEpoch
	 * @param {() => { providers?: Record<string, any> }} [options.getSettings]
	 * @param {{ span?: (name: string, args?: Record<string, any>) => (extraArgs?: Record<string, any>) => void }} [options.diagnostics]
	 */
	constructor(options) {
		this.sessionId = options.sessionId
		this.cwd = options.cwd
		this.session = options.session
		this.agent = options.agent
		this.db = options.db
		this.emit = options.emit
		this.sessions = options.sessions
		this.invalidateSnapshot = options.invalidateSnapshot
		this.nextEventSeqValue = options.nextEventSeq
		this.getEventSeq = options.getEventSeq
		this.getViewEpoch = options.getViewEpoch
		this.bumpViewEpoch = options.bumpViewEpoch
		this.getSettings = options.getSettings
		this.diagnostics = options.diagnostics
		this.currentRunId = null
		this.finishedRunIds = new Set()
		this.activeToolCalls = new Map()
		this.nextMessageEventId = 1
		this.messageEventIds = new WeakMap()
		this.messageEventIdsByKey = new Map()
		this.streamingAssistantMessageId = null
		this.lastActiveAt = Date.now()
		this.turnStartQueue = Promise.resolve()
		this.disposed = false
		this.currentPrompt = undefined
		this.promptCancellation = undefined
		this.pinanoApiScope = undefined
		this.legacySessionProperties = hasSessionPropertyEntries(this.session) ? undefined : this.db.getAgentViewMetadata(this.sessionId)
		this.currentRunToolNames = new Set()
		this.automatedMaintenanceTurnActive = false
		this.visibleMaintenanceToolCallIds = new Set()
		this.installPinanoApi(this.agent)
		this.installAutomatedMaintenanceToolGuard(this.agent)
		const existingModelForRequest = this.agent.modelForRequest
		this.agent.modelForRequest = (ctx) => {
			const maintenanceModel = this.maintenanceModelForRequest(ctx)
			if (maintenanceModel) return maintenanceModel
			return existingModelForRequest?.call(this.agent, ctx)
		}
		this.agent.automatedFollowUp = (ctx) => this.automatedMaintenanceFollowUp(ctx)
		this.agent.onContextLoad = (entry) => this.handleContextLoad(entry)
		this.agent.pinanoEnvironmentContext = () => this.environmentContext()
		this.hydrateAgentFromSession()
		this.unsubscribe = this.agent.subscribe(async (event) => {
			const end = this.diagnostics?.span?.("SessionRuntime.handleAgentEvent", {
				sessionId: this.sessionId,
				eventType: event.type,
				role: event.message?.role,
				toolName: event.toolName,
			})
			try {
				await this.handleAgentEvent(event)
			} finally {
				end?.()
			}
		})
		this.unsubscribeCompaction = this.agent.subscribeCompaction(async (message) => {
			const end = this.diagnostics?.span?.("SessionRuntime.handleCompaction", { sessionId: this.sessionId })
			try {
				await this.handleCompaction(message)
			} finally {
				end?.()
			}
		})
	}

	touch() {
		this.lastActiveAt = Date.now()
	}

	hydrateAgentFromSession() {
		const entries = conversationEntriesForModel(this.session)
		this.agent.state.messages = /** @type {any} */ (entries.map((e) => e.message))
		this.agent.msgToEntryId = new WeakMap()
		for (const e of entries) this.agent.msgToEntryId.set(e.message, e.entryId)
		this.agent.session = this.session
		this.agent.sessionId = this.sessionId
		this.touch()
	}

	installPinanoApi(agent = this.agent, fixedScope = undefined) {
		const handler = (request) => this.handlePinanoApiRequest(request)
		const apiForScope = (scope) => createPinanoJsApi({
			getSession: (sessionId) => handler({ op: "session.get", sessionId, scope }),
			setSession: (sessionId, patch) => handler({ op: "sessionWrite", sessionId, patch, scope }),
		})
		agent.pinanoApi = apiForScope(fixedScope)
		agent.pinanoApiForTool = () => apiForScope(fixedScope ?? this.pinanoApiScope)
		agent.pinanoApiScopeForTool = () => fixedScope ?? this.pinanoApiScope
		agent.pinanoApiRequest = handler
	}

	installAutomatedMaintenanceToolGuard(agent = this.agent) {
		const previous = agent.beforeToolCall
		agent.beforeToolCall = async (ctx, signal) => {
			if (this.automatedMaintenanceTurnActive && ctx.toolCall?.name !== SESSION_SET_TOOL_NAME) {
				return {
					block: true,
					reason: `Automated session metadata maintenance may only use ${SESSION_SET_TOOL_NAME}`,
				}
			}
			return previous?.call(agent, ctx, signal)
		}
	}

	/** @param {string | undefined} sessionId */
	resolvePinanoSessionId(sessionId) {
		return sessionId || this.sessionId
	}

	/** @param {string} id */
	pinanoSessionInfo(id) {
		const info = sessionInfoFromEntry(this.db.listSessions().find((entry) => entry.id === id))
		if (!info) return undefined
		if (id === this.sessionId) info.properties = this.effectiveSessionProperties()
		return info
	}

	effectiveSessionProperties() {
		this.session.legacySessionProperties = this.legacySessionProperties
		return getEffectiveSessionProperties(this.session)
	}

	environmentContext() {
		const props = this.effectiveSessionProperties()
		const config = this.session.getSessionConfig?.() ?? {}
		return environmentContextFor({
			cwd: props.cwd ?? this.cwd,
			initialCwd: config.worktree ?? config.cwd ?? this.session.getMetadata?.()?.cwd ?? this.cwd,
			environmentId: props.environmentId,
			sessionWorkspacePath: sessionWorkspacePath(this.sessionId),
			pinanoStateMount: pinanoStateMountFromSettings(this.getSettings?.()),
		})
	}

	refreshSessionPropertyCache(options = {}) {
		const props = this.effectiveSessionProperties()
		if (props.cwd && props.cwd !== this.cwd) {
			this.cwd = props.cwd
			this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
		}
		const metadata = sessionPropertiesToAgentView(props) ?? {}
		this.db.setAgentViewMetadata(this.sessionId, metadata)
		this.emitRuntimeEvent({ type: "agent_view_metadata", metadata, source: options.source })
		return props
	}

	async appendCwdContextLoad(cwd) {
		if (!cwd || contextFilesDisabledForAgent(this.agent)) return
		const loadedContextFiles = new Set(activeContextFiles(this.session).map(contextFileIdentity))
		const files = loadProjectContextForCwd(cwd).filter((file) => !loadedContextFiles.has(contextFileIdentity(file)))
		if (files.length === 0) return
		const load = { source: "cwd", cwd, loadedAt: new Date().toISOString(), files }
		const entryId = await this.session.appendContextLoad(load)
		this.handleContextLoad({ entryId, timestamp: load.loadedAt, contextLoad: load })
	}

	async appendSessionPropertyPatch(patch, source = undefined) {
		const normalizeOptions = source?.kind === "user_mark" || source?.kind === "run_reset"
			? { allowedStates: SESSION_PROPERTY_STATES }
			: source?.kind === "tool"
				? { allowedStates: SESSION_MODEL_WRITABLE_STATES, allowNullState: false }
				: undefined
		let normalized = normalizeSessionPropertyPatch(patch, normalizeOptions)
		const registry = loadEnvironmentRegistry()
		if (normalized.environmentId) getEnvironment(normalized.environmentId, registry)
		const before = this.effectiveSessionProperties()
		normalized = completeEnvironmentPatch(normalized, before, registry)
		const environmentChangeBlocked = this.automatedMaintenanceTurnActive
			&& Object.prototype.hasOwnProperty.call(normalized, "environmentId")
			&& (before.environmentId ?? null) !== (normalized.environmentId ?? null)
		if (environmentChangeBlocked) throw new Error("Automated session metadata maintenance may not change environmentId")

		const changed = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => (before[key] ?? null) !== (value ?? null)))
		const unchanged = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => (before[key] ?? null) === (value ?? null)))
		const writeResult = (properties) => ({
			properties,
			patch: normalized,
			changed,
			unchanged,
			noChange: Object.keys(changed).length === 0,
		})
		if (!patchIsMeaningful(normalized)) return writeResult(before)
		if (Object.keys(changed).length === 0) return writeResult(before)
		const after = { ...before, ...normalized }
		const updatedAt = new Date().toISOString()
		await this.session.appendCustomEntry(SESSION_CUSTOM_TYPE_PROPERTIES, {
			version: 1,
			patch: normalized,
			before,
			after: { ...after, updatedAt },
			updatedAt,
			source,
		})
		const properties = this.refreshSessionPropertyCache({ source })
		if (Object.prototype.hasOwnProperty.call(changed, "cwd")) await this.appendCwdContextLoad(properties.cwd)
		return writeResult(properties)
	}

	/** @param {any} scope @param {string} id */
	assertPinanoScopeCurrent(scope, id) {
		if (!scope?.anchorEntryId) return
		if (id !== this.sessionId) throw new Error("Automated session maintenance can only update its current session")
		if (this.session.getLeafId() !== scope.anchorEntryId) throw new Error("Session changed since automated maintenance started")
	}

	async handleInternalGitEvent(request, workerContext = undefined) {
		if (request.method !== "POST") return internalHttpJsonResponse({ error: "Method Not Allowed" }, 405)
		const event = normalizeGitWorktreeEventPayload(parseInternalJsonBody(request), { workerContext })
		if (!event) return internalHttpJsonResponse({ ok: true, recorded: false })
		const entryId = await this.session.appendCustomEntry(GIT_WORKTREE_CUSTOM_TYPE, event)
		return internalHttpJsonResponse({ ok: true, recorded: true, entryId }, 201)
	}

	async handleInternalHttpRequest(request, workerContext = undefined) {
		const url = new URL(request.path || "/", "http://pinano.internal")
		if (url.pathname === "/internal/git/events") return this.handleInternalGitEvent(request, workerContext)
		if (url.pathname === DOCKER_PROXY_ROUTE) return handleDockerProxyRequest(request, workerContext, { sessionId: this.sessionId })
		return internalHttpJsonResponse({ error: "Not Found" }, 404)
	}

	/** @param {{ op: string, sessionId?: string, patch?: any, scope?: any, request?: any, workerContext?: any }} request */
	async handlePinanoApiRequest(request) {
		const id = this.resolvePinanoSessionId(request.sessionId)
		if (request.op === "session.get") {
			const info = this.pinanoSessionInfo(id)
			if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
			return info
		}
		if (request.op === "sessionWrite") {
			this.assertPinanoScopeCurrent(request.scope, id)
			if (id !== this.sessionId) throw new Error("sessionWrite can currently only update the active session")
			let patch = request.patch
			if (request.patch?.overview) {
				patch = {}
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "state")) patch.state = request.patch.overview.state
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "description")) patch.descriptionInUi = request.patch.overview.description
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "projectTag")) patch.projectTag = request.patch.overview.projectTag
			}
			const write = await this.appendSessionPropertyPatch(patch, request.source ?? { kind: "api" })
			await this.invalidateSnapshot(this.sessionId)
			const info = this.pinanoSessionInfo(id)
			if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
			return { ...info, sessionWrite: write }
		}
		if (request.op === "internalHttp") return this.handleInternalHttpRequest(request.request ?? {}, request.workerContext)
		throw new Error(`Unknown Pinano JS API operation: ${request.op}`)
	}

	/** @param {any} event */
	emitRuntimeEvent(event) {
		this.emit({
			...event,
			sessionId: this.sessionId,
			runId: this.currentRunId,
			seq: this.nextEventSeqValue(),
			viewEpoch: this.getViewEpoch(),
		})
	}

	handleContextLoad(entry) {
		if (this.disposed) return
		this.touch()
		const message = contextLoadDisplayMessage(entry)
		if (!message) return
		const entryId = entry?.entryId
		const displayMessage = entryId ? { ...message, entryId } : message
		this.emitRuntimeEvent({
			type: "context_load",
			entryId,
			contextLoad: message.contextLoad,
			message: displayMessage,
		})
	}

	nextMessageId() {
		const id = `run-${this.currentRunId ?? "unknown"}-message-${this.nextMessageEventId}`
		this.nextMessageEventId += 1
		return id
	}

	/** @param {any} message */
	assignMessageEventId(message) {
		let messageId = this.messageEventIds.get(message)
		if (!messageId) {
			messageId = this.nextMessageId()
			this.messageEventIds.set(message, messageId)
		}
		return messageId
	}

	/** @param {any} event */
	decorateMessageEvent(event) {
		if (!event.message) return event
		let messageId
		if (event.message.role === "assistant" && (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")) {
			if (!this.streamingAssistantMessageId) this.streamingAssistantMessageId = this.nextMessageId()
			messageId = this.streamingAssistantMessageId
		} else {
			messageId = this.messageEventIds.get(event.message)
			const key = messageKey(event.message)
			if (!messageId && key) messageId = this.messageEventIdsByKey.get(key)
			if (!messageId) messageId = this.assignMessageEventId(event.message)
			else this.messageEventIds.set(event.message, messageId)
			if (key) this.messageEventIdsByKey.set(key, messageId)
		}
		return { ...event, messageId, message: { ...event.message, messageId } }
	}

	internalPromptCancellationActive() {
		return this.promptCancellation?.runId === this.currentRunId && this.promptCancellation.sawToolStart !== true
	}

	/** @param {any} event */
	shouldSuppressPromptCancellationEvent(event) {
		if (!this.internalPromptCancellationActive()) return false
		return event.type === "agent_end"
			|| (event.message?.role === "assistant" && ["message_start", "message_update", "message_end", "turn_end"].includes(event.type))
	}

	async handleAgentEvent(event) {
		this.touch()
		if (event.type === "agent_start") {
			this.automatedMaintenanceTurnActive = false
			this.visibleMaintenanceToolCallIds = new Set()
		}
		if (event.type === "message_start" && event.message?.role === "user") {
			this.automatedMaintenanceTurnActive = isAutomatedMaintenanceMessage(event.message)
		}
		if (event.message && this.automatedMaintenanceTurnActive) event.message.pinanoAutomated = true
		if (event.type === "tool_execution_start") {
			this.currentRunToolNames.add(event.toolName)
			if (this.promptCancellation?.runId === this.currentRunId) this.promptCancellation.sawToolStart = true
		}
		if (this.shouldSuppressPromptCancellationEvent(event)) return
		let emitEvent = this.decorateMessageEvent(event)
		if (event.type === "tool_execution_start") {
			const end = this.diagnostics?.span?.("SessionRuntime.appendCustomEntry", {
				sessionId: this.sessionId,
				customType: "tool_execution",
				phase: "started",
				toolName: event.toolName,
			})
			try {
				await this.session.appendCustomEntry("tool_execution", {
					version: 1,
					phase: "started",
					runId: this.currentRunId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				})
			} finally {
				end?.()
			}
		}
		if (event.type === "message_end") {
			const endAppend = this.diagnostics?.span?.("SessionRuntime.appendMessage", {
				sessionId: this.sessionId,
				role: event.message?.role,
			})
			let id
			try {
				id = await this.session.appendMessage(/** @type {any} */ (event.message))
			} finally {
				endAppend?.()
			}
			if (id) this.agent.msgToEntryId.set(/** @type {any} */ (event.message), id)
			emitEvent = { ...emitEvent, entryId: id, message: id ? { ...emitEvent.message, entryId: id } : emitEvent.message }
			if (event.message?.role === "toolResult" && event.message.toolCallId) {
				const end = this.diagnostics?.span?.("SessionRuntime.appendCustomEntry", {
					sessionId: this.sessionId,
					customType: "tool_execution",
					phase: "ended",
					toolName: event.message.toolName,
					isError: event.message.isError,
				})
				try {
					await this.session.appendCustomEntry("tool_execution", {
						version: 2,
						phase: "ended",
						runId: this.currentRunId,
						toolCallId: event.message.toolCallId,
						toolName: event.message.toolName,
						isError: event.message.isError,
						messageEntryId: id,
						hasDurableMessage: true,
					})
				} finally {
					end?.()
				}
			}
			if (event.message?.role === "user" || event.message?.role === "assistant") {
				const endActivity = this.diagnostics?.span?.("SessionRuntime.sessionActivityAt", {
					sessionId: this.sessionId,
					role: event.message.role,
				})
				let activityAt
				try {
					activityAt = sessionActivityAt(this.session)
				} finally {
					endActivity?.()
				}
				const endTouch = this.diagnostics?.span?.("SessionRuntime.db.touchSession", {
					sessionId: this.sessionId,
					role: event.message.role,
				})
				try {
					this.db.touchSession(this.sessionId, this.cwd, activityAt)
				} finally {
					endTouch?.()
				}
			}
		}
		if (event.type === "tool_execution_start" && !this.automatedMaintenanceTurnActive) this.activeToolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, args: event.args })
		if (event.type === "tool_execution_end") this.activeToolCalls.delete(event.toolCallId)
		if (event.type === "message_end" && event.message?.role === "user" && this.currentPrompt?.runId === this.currentRunId) {
			const text = textFromContent(event.message.content)
			if (!this.currentPrompt.userEntryId && text === this.currentPrompt.text) this.currentPrompt.userEntryId = emitEvent.entryId
			if (!isAutomatedMaintenanceMessage(event.message)) {
				const props = this.effectiveSessionProperties()
				if (props.state !== SESSION_READY_FOR_REVIEW_STATE) await this.appendSessionPropertyPatch({ state: SESSION_READY_FOR_REVIEW_STATE }, { kind: "run_reset", runId: this.currentRunId })
				else this.refreshSessionPropertyCache({ source: { kind: "run_reset", runId: this.currentRunId } })
			}
		}
		if (event.type === "agent_end") {
			this.activeToolCalls.clear()
			const endTouch = this.diagnostics?.span?.("SessionRuntime.db.touchSession", {
				sessionId: this.sessionId,
				eventType: "agent_end",
			})
			try {
				this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
			} finally {
				endTouch?.()
			}
			this.finishRunFromAgentEnd(event)
			this.refreshSessionPropertyCache({ source: { kind: "agent_end" } })
		}
		if (!event.message) {
			if (!(this.automatedMaintenanceTurnActive && event.type?.startsWith?.("tool_execution_"))) this.emitRuntimeEvent(emitEvent)
		} else {
			const visible = projectVisibleMessage(emitEvent.message, { retainedMaintenanceToolCallIds: this.visibleMaintenanceToolCallIds })
			if (visible) this.emitRuntimeEvent({ ...emitEvent, message: visible })
		}
		if (event.type === "message_end" && event.message?.role === "assistant") this.streamingAssistantMessageId = null
		if (event.type === "agent_end") {
			const endInvalidation = this.diagnostics?.span?.("SessionRuntime.invalidateSnapshot", {
				sessionId: this.sessionId,
				reason: "agent_end",
			})
			try {
				await this.invalidateSnapshot(this.sessionId)
			} finally {
				endInvalidation?.()
			}
		}
	}

	maintenanceModelForRequest(ctx) {
		if (!sessionPropertiesMaintenanceExchangeActive(ctx?.context?.messages ?? [])) return undefined
		const ref = this.agent.state.model?.maintenanceModelRef
		if (!ref) return undefined
		return resolveModel(ref, { providers: this.getSettings?.()?.providers })
	}

	automatedMaintenanceFollowUp(ctx) {
		if (this.agent.state.model?.provider === "mock") return []
		if (ctx.newMessages?.some(isAutomatedMaintenanceMessage)) return []
		const blocks = Array.isArray(ctx.message?.content) ? ctx.message.content : []
		if (blocks.some((block) => block?.type === "toolCall")) return []
		if (!this.agent.state.tools?.some((tool) => tool.name === SESSION_SET_TOOL_NAME)) return []
		const props = this.effectiveSessionProperties()
		const missingRequiredUi = !props.descriptionInUi || !props.projectTag
		const usedMeaningfulTool = [...this.currentRunToolNames].some((name) => name !== SESSION_SET_TOOL_NAME)
		const completionConfirmation = isShortCompletionConfirmation(this.currentPrompt?.text)
		if (!missingRequiredUi && !usedMeaningfulTool && !completionConfirmation) return []
		return [createMaintenancePromptMessage(props)]
	}

	async handleCompaction(message) {
		this.touch()
		if (!visibleMessage(message)) return
		this.bumpViewEpoch()
		this.emitRuntimeEvent({ type: "compaction", message })
		await this.invalidateSnapshot(this.sessionId)
	}

	finishRunFromAgentEnd(event) {
		const runId = this.currentRunId
		if (!runId || this.finishedRunIds.has(runId)) return
		const messages = Array.isArray(event.messages) ? event.messages : []
		const lastMessage = messages[messages.length - 1]
		const finalMessage = [...messages].reverse().find((message) => !message?.pinanoAutomated && !message?.pinanoMaintenance) ?? lastMessage
		if (lastMessage?.pinanoAutomated && lastMessage?.errorMessage) this.agent.state.errorMessage = undefined
		const stopReason = event.interrupted ? "interrupted" : finalMessage?.stopReason
		const errorMessage = finalMessage?.errorMessage
		const status = event.interrupted ? "interrupted" : stopReason === "aborted" ? "aborted" : errorMessage ? "failed" : "completed"
		this.db.finishRun(runId, { status, error: errorMessage, stopReason })
		this.finishedRunIds.add(runId)
		this.currentRunId = null
		this.session.clearMutationRunId(runId)
	}

	finishRunFromFailure(runId, err) {
		if (this.finishedRunIds.has(runId)) return
		this.db.finishRun(runId, {
			status: "failed",
			error: /** @type {any} */ (err)?.message ?? String(err),
			stopReason: "error",
		})
		this.finishedRunIds.add(runId)
		if (this.currentRunId === runId) this.currentRunId = null
		this.session.clearMutationRunId(runId)
	}

	isStreaming() {
		return this.agent.state.isStreaming
	}

	waitingInfo() {
		return {
			sessionId: this.sessionId,
			isStreaming: this.isStreaming(),
			pendingToolCalls: [...this.activeToolCalls.values()],
		}
	}

	pendingUserMessages() {
		return (this.agent.getQueuedMessages?.() ?? [])
			.map((item) => {
				const message = projectVisibleMessage(item.message)
				const messageId = item.message ? this.messageEventIds.get(item.message) : undefined
				return message ? { behavior: item.behavior, message: messageId ? { ...message, messageId } : message } : undefined
			})
			.filter(Boolean)
	}

	contextMessages(logicalEntries = conversationEntriesForModel(this.session)) {
		const messages = logicalEntries.map((entry) => entry.message)
		const contextMessages = contextFilesDisabledForAgent(this.agent)
			? messages
			: buildModelMessagesForSession(this.session, messages)
		return prependEnvironmentContext(this.environmentContext(), contextMessages)
	}

	contextStats(contextMessages) {
		return summarizeContext({
			messages: contextMessages,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
		})
	}

	contextReport() {
		const messages = this.contextMessages()
		return formatContextReport({
			messages,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			model: this.agent.state.model,
		})
	}

	systemReport() {
		return formatSystemReport({
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			messages: this.contextMessages(),
		})
	}

	async worktrees() {
		return sessionGitWorktreeStatuses(this.session)
	}

	async snapshot(options = {}) {
		this.touch()
		let logicalEntries
		const endLogical = this.diagnostics?.span?.("SessionRuntime.snapshot.logicalEntries", { sessionId: this.sessionId })
		try {
			logicalEntries = conversationEntriesForModel(this.session)
		} finally {
			endLogical?.({ count: logicalEntries?.length ?? 0 })
		}
		let displayEntries
		let visibleDisplayEntries
		const endDisplay = this.diagnostics?.span?.("SessionRuntime.snapshot.displayEntries", { sessionId: this.sessionId })
		try {
			displayEntries = this.session.getDisplayEntries()
			visibleDisplayEntries = projectVisibleEntries(displayEntries)
		} finally {
			endDisplay?.({ count: displayEntries?.length ?? 0, visibleCount: visibleDisplayEntries?.length ?? 0 })
		}
		let contextMessages
		const endContext = this.diagnostics?.span?.("SessionRuntime.snapshot.contextMessages", { sessionId: this.sessionId })
		try {
			contextMessages = this.contextMessages(logicalEntries)
		} finally {
			endContext?.({ count: contextMessages?.length ?? 0 })
		}
		const contextStats = this.contextStats(contextMessages)
		const endPayload = this.diagnostics?.span?.("SessionRuntime.snapshot.payload", { sessionId: this.sessionId })
		const properties = this.effectiveSessionProperties()
		const streamingMessage = projectVisibleMessage(this.agent.state.streamingMessage)
		const snapshot = {
			cwd: properties.cwd ?? this.cwd,
			sessionId: this.sessionId,
			seq: this.getEventSeq(),
			viewEpoch: this.getViewEpoch(),
			viewLeafId: this.session.getLeafId(),
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
			serviceTier: this.agent.state.serviceTier,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			modelIoLogEnabled: isModelIoLogEnabled(),
			isStreaming: this.agent.state.isStreaming,
			currentModelRequest: this.agent.state.currentModelRequest,
			pendingToolCalls: [...this.agent.state.pendingToolCalls],
			pendingToolCallDetails: [...this.activeToolCalls.values()],
			pendingUserMessages: this.pendingUserMessages(),
			errorMessage: this.agent.state.errorMessage,
			agentView: sessionPropertiesToAgentView(properties),
			sessionProperties: properties,
			promptDraft: this.db.getPromptDraft(this.sessionId),
			messages: visibleDisplayEntries.map((entry) => ({ ...entry.message, entryId: entry.entryId })),
			contextStats,
			streamingMessage: streamingMessage
				? { ...streamingMessage, messageId: this.streamingAssistantMessageId }
				: null,
		}
		if (options.includeContextMessages) snapshot.contextMessages = contextMessages.map((message) => ({ ...message, entryId: message.entryId ?? "context" }))
		endPayload?.({ messages: snapshot.messages.length, contextMessages: contextStats.messageCount, includeContextMessages: options.includeContextMessages === true })
		if (options.includeSessions) snapshot.sessions = await this.sessions()
		return snapshot
	}

	snapshotCursor() {
		return {
			seq: this.getEventSeq(),
			viewEpoch: this.getViewEpoch(),
		}
	}

	startRunRecord() {
		const runId = randomUUID()
		this.db.startRun({
			id: runId,
			sessionId: this.sessionId,
			expectedMutationVersion: this.session.getMutationVersion(),
		})
		this.finishedRunIds.delete(runId)
		this.currentRunId = runId
		this.session.setMutationRunId(runId)
		return runId
	}

	modelRetryDelay(attempt) {
		return MODEL_RETRY_BASE_DELAY_MS * 2 ** attempt
	}

	lastAssistantMessage() {
		const messages = this.agent.state.messages
		const last = messages[messages.length - 1]
		return last?.role === "assistant" ? last : undefined
	}

	async monitorRunForModelRetry(run, retry = {}) {
		try {
			await run
		} catch (err) {
			this.finishRunFromFailure(retry.runId, err)
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
			return
		}

		const attempt = retry.attempt ?? 0
		const maxAttempts = retry.maxAttempts ?? MODEL_RETRY_MAX_ATTEMPTS
		const failed = this.lastAssistantMessage()
		if (!failed || failed.stopReason !== "error" || !messageHasRetryableModelError(failed)) return
		if (attempt >= maxAttempts) {
			this.emitRuntimeEvent({
				type: "model_retry_exhausted",
				attempt,
				maxAttempts,
				error: failed.errorMessage,
			})
			return
		}

		const delayMs = this.modelRetryDelay(attempt)
		this.emitRuntimeEvent({
			type: "model_retry_scheduled",
			attempt: attempt + 1,
			maxAttempts,
			delayMs,
			error: failed.errorMessage,
		})
		await sleep(delayMs)
		if (this.disposed || this.agent.state.isStreaming || this.lastAssistantMessage() !== failed) return

		try {
			await this.continueRun({
				waitForCompletion: true,
				retry: { attempt: attempt + 1, maxAttempts },
			})
		} catch (err) {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		}
	}

	enqueueTurnStart(operation) {
		const previous = this.turnStartQueue.catch(() => {})
		const current = previous.then(operation)
		this.turnStartQueue = current.then(() => undefined, () => undefined)
		return current
	}

	startStreamingPrompt(userMessage, streamingBehavior) {
		if (streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
			throw Object.assign(new Error("Session is streaming. Use streamingBehavior:'steer'|'followUp'."), { status: 409 })
		}
		this.assignMessageEventId(userMessage)
		const accepted = this.agent.waitForMessagesAccepted([userMessage], this.agent.waitForIdle())
		if (streamingBehavior === "steer") this.agent.steer(userMessage)
		else this.agent.followUp(userMessage)
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
		return { accepted, streamingBehavior }
	}

	startPromptRun(message, userMessage) {
		this.currentRunToolNames = new Set()
		const endStartRun = this.diagnostics?.span?.("SessionRuntime.prompt.startRunRecord", { sessionId: this.sessionId })
		let runId
		try {
			runId = this.startRunRecord()
		} finally {
			endStartRun?.()
		}
		this.currentPrompt = {
			runId,
			text: message,
			preAgentView: this.db.getAgentViewMetadata(this.sessionId),
			userEntryId: undefined,
		}

		const endStartPrompt = this.diagnostics?.span?.("SessionRuntime.prompt.startPrompt", { sessionId: this.sessionId })
		let accepted
		let run
		try {
			;({ accepted, run } = this.agent.startPrompt(userMessage))
		} catch (err) {
			this.finishRunFromFailure(runId, err)
			if (this.currentPrompt?.runId === runId) this.currentPrompt = undefined
			throw err
		} finally {
			endStartPrompt?.()
		}
		this.monitorRunForModelRetry(run, { runId }).catch((err) => {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		})
		return { accepted }
	}

	async prompt(message, streamingBehavior, images = []) {
		this.touch()
		const content = promptContentWithImages(message, images)
		const userMessage = { role: "user", content, timestamp: Date.now() }
		const { accepted, streamingBehavior: acceptedStreamingBehavior } = await this.enqueueTurnStart(async () => {
			if (this.agent.state.isStreaming) return this.startStreamingPrompt(userMessage, streamingBehavior)
			await this.agent.waitForIdle()
			if (this.agent.state.isStreaming) return this.startStreamingPrompt(userMessage, streamingBehavior)
			this.hydrateAgentFromSession()
			return this.startPromptRun(message, userMessage)
		})
		const endAccepted = this.diagnostics?.span?.("SessionRuntime.prompt.awaitAccepted", {
			sessionId: this.sessionId,
			streamingBehavior: acceptedStreamingBehavior,
		})
		try {
			await accepted
		} finally {
			endAccepted?.()
		}
	}

	async reconcileUnknownToolExecutions() {
		const pending = startedToolsWithoutDurableResult(this.session)
		if (pending.length === 0) return []
		const latestStartedEntryId = pending[pending.length - 1]?.entryId
		if (latestStartedEntryId && this.session.getLeafId() !== latestStartedEntryId) {
			// Drop any tail produced after the harness lost a tool outcome (usually an
			// error assistant from the crash) and recover from the durable tool-start
			// boundary. Repeating the tool would be unsafe; keeping the failure tail in
			// the model context would put a non-tool message between the assistant tool
			// call and its recovered tool result.
			this.session.moveTo(latestStartedEntryId)
		}
		const synthesized = await synthesizeUnknownToolResultsForStartedTools(this.session)
		if (synthesized.length === 0) return synthesized
		this.hydrateAgentFromSession()
		this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
		return synthesized
	}

	rewindFailedAssistantTail() {
		// If the last attempted turn ended with an aborted/errored assistant, rewind the session
		// leaf to its parent so the next continuation can re-stream the turn. Without this,
		// agent.continue() throws "Cannot continue from message role: assistant" — which the
		// run.catch below would record as another failed run, making manual and automatic
		// continuation feel like a no-op after Esc or a service upgrade.
		const messages = this.agent.state.messages
		const last = messages[messages.length - 1]
		const isFailedAssistant = last?.role === "assistant" && (
			last.stopReason === "aborted" || last.stopReason === "error" || last.errorMessage
		)
		if (!isFailedAssistant || messages.length < 2) return false
		const parentMessage = messages[messages.length - 2]
		const parentEntryId = this.agent.msgToEntryId.get(parentMessage)
		if (!parentEntryId) return false
		this.session.moveTo(parentEntryId)
		this.hydrateAgentFromSession()
		return true
	}

	async prepareContinuationState() {
		await this.reconcileUnknownToolExecutions()
		if (this.rewindFailedAssistantTail()) {
			this.bumpViewEpoch()
			this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
			await this.invalidateSnapshot(this.sessionId)
		}
		return deriveSessionRunState(this.session)
	}

	async startContinuationRun(options = {}) {
		if (this.agent.state.isStreaming) throw Object.assign(new Error("Session is already streaming."), { status: 409 })
		const state = await this.prepareContinuationState()
		if (state.type === "blocked") {
			const toolNames = state.pendingToolCalls?.map((tool) => tool.toolName || tool.toolCallId).join(", ") || "tool execution"
			throw Object.assign(new Error(`Cannot continue safely: ${state.reason} (${toolNames})`), { status: 409 })
		}
		if (state.type !== "runnable") throw Object.assign(new Error(`Cannot continue: ${state.reason}`), { status: 409 })

		this.currentRunToolNames = new Set()
		const runId = this.startRunRecord()
		let run
		try {
			run = this.agent.continue()
		} catch (err) {
			this.finishRunFromFailure(runId, err)
			throw err
		}
		const monitored = this.monitorRunForModelRetry(run, { runId, ...(options.retry ?? {}) })
		if (!options.waitForCompletion) monitored.catch((err) => {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		})
		return { monitored }
	}

	async continueRun(options = {}) {
		this.touch()
		const { monitored } = await this.enqueueTurnStart(() => this.startContinuationRun(options))
		if (options.waitForCompletion) await monitored
	}

	toolStartedForRun(runId) {
		if (!runId) return this.activeToolCalls.size > 0
		return this.activeToolCalls.size > 0 || this.session.getEntries().some((entry) =>
			entry.type === "custom" &&
			entry.customType === "tool_execution" &&
			entry.data?.runId === runId &&
			entry.data?.phase === "started",
		)
	}

	async abort() {
		this.touch()
		this.agent.abort()
		await this.agent.waitForIdle()
	}

	async cancelCurrentPrompt() {
		this.touch()
		const prompt = this.currentPrompt
		if (!this.agent.state.isStreaming) {
			return { ok: true, cancelled: false, reason: "not_streaming" }
		}
		if (!prompt) {
			await this.abort()
			return { ok: true, cancelled: false, reason: "no_current_prompt" }
		}
		const toolStartedBeforeAbort = this.toolStartedForRun(prompt.runId)
		if (!toolStartedBeforeAbort) this.promptCancellation = { runId: prompt.runId, sawToolStart: false }
		try {
			this.agent.abort()
			await this.agent.waitForIdle()
		} finally {
			if (this.promptCancellation?.runId === prompt.runId && (toolStartedBeforeAbort || this.promptCancellation.sawToolStart)) {
				this.promptCancellation = undefined
			}
		}
		const toolStarted = toolStartedBeforeAbort || this.toolStartedForRun(prompt.runId) || this.promptCancellation?.sawToolStart === true
		if (toolStarted) return { ok: true, cancelled: false, reason: "tool_started" }

		const entry = prompt.userEntryId ? this.session.getEntry(prompt.userEntryId) : undefined
		if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
			if (this.promptCancellation?.runId === prompt.runId) this.promptCancellation = undefined
			return { ok: true, cancelled: false, reason: "prompt_entry_not_found" }
		}

		const draft = promptDraftFromMessages([
			...cancellableBranchUserMessages(this.session, entry),
			...queuedCancellableUserMessages(this.agent),
		])
		this.session.moveTo(entry.parentId ?? null, { runId: prompt.runId })
		this.hydrateAgentFromSession()
		this.agent.clearAllQueues?.()
		this.agent.state.errorMessage = undefined
		this.refreshSessionPropertyCache({ source: { kind: "cancel_prompt" } })
		this.db.finishRun(prompt.runId, { status: "completed", stopReason: "cancelled" })
		this.finishedRunIds.add(prompt.runId)
		if (this.currentRunId === prompt.runId) this.currentRunId = null
		this.session.clearMutationRunId(prompt.runId)
		this.currentPrompt = undefined
		this.streamingAssistantMessageId = null
		if (this.promptCancellation?.runId === prompt.runId) this.promptCancellation = undefined
		this.bumpViewEpoch()
		this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
		await this.invalidateSnapshot(this.sessionId)
		return { ok: true, cancelled: true, text: draft.text, images: draft.images }
	}

	softInterrupt() {
		this.touch()
		return this.agent.softInterrupt()
	}

	async waitForIdle() {
		await this.agent.waitForIdle()
	}

	hasBackgroundWork() {
		return false
	}

	async waitForBackgroundWork() {}

	rewindTargets() {
		this.touch()
		return buildRewindTargets(this.session)
	}

	async rewind(id, options = {}) {
		this.touch()
		if (this.agent.state.isStreaming) throw Object.assign(new Error("Abort this session's running turn before rewinding."), { status: 409 })
		const entry = this.session.getEntry(id)
		if (!entry || !isHumanUserEntry(entry) || isProjectContextMessage(entry.message)) {
			throw Object.assign(new Error(`Rewind target not found: ${id}`), { status: 404 })
		}
		const editorText = entryMessageText(entry)
		const restoreConversation = options.restoreConversation !== false
		const oldBranch = this.session.getBranch()
		const idx = oldBranch.findIndex((e) => e.id === id)
		const discardedMessages = idx >= 0
			? oldBranch.slice(idx).filter((e) => e.type === "message").map((e) => e.message)
			: []
		let branchSummary = ""
		if (restoreConversation && options.summary && discardedMessages.length > 0) {
			try {
				const result = await summarizeMessages(this.agent, discardedMessages, {
					systemPrompt:
						"You are summarizing a conversation branch that the user has just discarded by rewinding earlier in the session. Capture the user's goals, what was attempted, what worked, and what didn't — so the next attempt can avoid repeating mistakes. Reply with the summary text only.",
					userPreamble: "Summarize this discarded conversation branch:",
				})
				branchSummary = result.summary
			} catch (err) {
				branchSummary = `Summary failed: ${/** @type {any} */ (err)?.message ?? err}`
			}
		}
		let fileRestoreResult
		if (options.restoreFiles === true) fileRestoreResult = await restoreFilesToCheckpoint(this.session, id)
		if (restoreConversation) this.session.moveTo(entry.parentId ?? null)
		await this.session.appendCustomEntry(SESSION_CUSTOM_TYPE_REWIND, { targetEntryId: id, text: editorText, summary: restoreConversation && !!options.summary, restoreFiles: options.restoreFiles === true, restoreConversation })
		if (fileRestoreResult) await appendFileRestoreEntry(this.session, id, fileRestoreResult)
		if (branchSummary) {
			await this.session.appendMessage({
				role: "user",
				content: [{ type: "text", text: `[branch summary — earlier branch from this point was discarded by /rewind]\n${branchSummary}` }],
				timestamp: Date.now(),
				branchSummary: true,
			})
		}
		this.hydrateAgentFromSession()
		this.bumpViewEpoch()
		this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
		this.refreshSessionPropertyCache({ source: { kind: "rewind" } })
		await this.invalidateSnapshot(this.sessionId)
		return editorText
	}

	async setFastMode(args) {
		this.touch()
		return handleFastCommand(this.agent, this.session, args)
	}

	async compact() {
		this.touch()
		if (this.agent.compact) return this.agent.compact()
		return compact(this.agent)
	}

	async switchBranchTip(id) {
		this.touch()
		if (this.agent.state.isStreaming) throw Object.assign(new Error("Abort this session's running turn before switching branches."), { status: 409 })
		const branchTips = buildBranchTipItems(this.session)
		if (!branchTips.some((tip) => tip.id === id)) throw Object.assign(new Error(`Branch tip not found: ${id}`), { status: 404 })
		let switched = false
		if (id !== this.session.getLeafId()) {
			this.session.moveTo(id)
			await this.session.appendCustomEntry(SESSION_CUSTOM_TYPE_BRANCH_SWITCH, { targetEntryId: id })
			switched = true
		}
		this.hydrateAgentFromSession()
		this.bumpViewEpoch()
		this.db.touchSession(this.sessionId, this.cwd, sessionActivityAt(this.session))
		this.refreshSessionPropertyCache({ source: { kind: "branch_switch" } })
		await this.invalidateSnapshot(this.sessionId)
	}

	dispose() {
		this.disposed = true
		this.unsubscribe?.()
		this.unsubscribeCompaction?.()
		this.agent.dispose?.()
	}
}

export class RuntimeManager {
	/**
	 * @param {object} opts
	 * @param {Session} [opts.session]
	 * @param {string} [opts.sessionId]
	 * @param {string} opts.cwd
	 * @param {(info: { sessionId: string, session: Session, cwd: string, getSettings?: () => any }) => Agent} [opts.createAgent]
	 * @param {() => { model?: string, thinkingLevel?: string, models?: Record<string, any> }} [opts.getSettings]
	 * @param {number} [opts.idleRuntimeTtlMs]
	 * @param {number} [opts.maxIdleRuntimes]
	 * @param {boolean} [opts.snapshotIncludesSessions]
	 * @param {{ span?: (name: string, args?: Record<string, any>) => (extraArgs?: Record<string, any>) => void }} [opts.diagnostics]
	 * @param {ServerDb} db
	 * @param {{ send: (event: any) => void }} hub
	 */
	constructor(opts, db, hub) {
		this.opts = opts
		this.db = db
		this.hub = hub
		this.cwd = opts.cwd
		this.initialSessionId = opts.sessionId ?? null
		this.idleRuntimeTtlMs = opts.idleRuntimeTtlMs ?? DEFAULT_IDLE_TTL_MS
		this.maxIdleRuntimes = opts.maxIdleRuntimes ?? DEFAULT_MAX_IDLE_RUNTIMES
		this.snapshotOptions = opts.snapshotIncludesSessions ? { includeSessions: true } : {}
		this.diagnostics = opts.diagnostics
		/** @type {Map<string, SessionRuntime>} */
		this.runtimes = new Map()
		/** @type {Map<string, number>} */
		this.eventSeqs = new Map()
		/** @type {Map<string, number>} */
		this.viewEpochs = new Map()
		this.createAgent = opts.createAgent ?? (() => {
			throw new Error("server runtime needs createAgent to open live sessions")
		})
	}

	static async create(opts, db, hub) {
		const manager = new RuntimeManager(opts, db, hub)
		if (opts.session && opts.sessionId) {
			manager.upsertSession(opts.session, opts.sessionId)
			await manager.createRuntime(opts.session, opts.sessionId)
		}
		manager.applyLegacyAgentViewFallbacks().catch(() => {})
		return manager
	}

	upsertSession(session, id) {
		const meta = session.getMetadata()
		this.db.upsertSession({
			id,
			cwd: meta.cwd ?? this.cwd,
			createdAt: meta.createdAt,
			updatedAt: sessionActivityAt(session),
		})
	}

	nextEventSeq(id) {
		const next = (this.eventSeqs.get(id) ?? 0) + 1
		this.eventSeqs.set(id, next)
		return next
	}

	getEventSeq(id) {
		return this.eventSeqs.get(id) ?? 0
	}

	getViewEpoch(id) {
		return this.viewEpochs.get(id) ?? 0
	}

	bumpViewEpoch(id) {
		const next = this.getViewEpoch(id) + 1
		this.viewEpochs.set(id, next)
		return next
	}

	async createRuntime(session, id) {
		const existing = this.runtimes.get(id)
		if (existing) {
			if (existing.agent.isDead) {
				existing.dispose()
				this.runtimes.delete(id)
			} else {
				existing.touch()
				return existing
			}
		}
		const cwd = session.getMetadata().cwd ?? this.cwd
		const agent = this.createAgent({ sessionId: id, session, cwd, getSettings: this.opts.getSettings })
		applySessionConfig(agent, session, cwd)
		const runtime = new SessionRuntime({
			sessionId: id,
			cwd,
			session,
			agent,
			db: this.db,
			emit: (event) => this.hub.send(event),
			sessions: () => this.sessions(),
			invalidateSnapshot: (sessionId) => this.invalidateSnapshot(sessionId),
			nextEventSeq: () => this.nextEventSeq(id),
			getEventSeq: () => this.getEventSeq(id),
			getViewEpoch: () => this.getViewEpoch(id),
			bumpViewEpoch: () => this.bumpViewEpoch(id),
			getSettings: this.opts.getSettings,
			diagnostics: this.diagnostics,
		})
		await applySessionProviderMetadata(agent, session, cwd, this.opts.getSettings?.())
		this.runtimes.set(id, runtime)
		runtime.refreshSessionPropertyCache({ source: { kind: "runtime_create" } })
		this.pruneIdleRuntimes()
		return runtime
	}

	async getRuntime(id) {
		const end = this.diagnostics?.span?.("RuntimeManager.getRuntime", { sessionId: id })
		let ended = false
		const endGetRuntime = (args) => {
			if (ended) return
			ended = true
			end?.(args)
		}
		try {
			const existing = this.runtimes.get(id)
			if (existing) {
				if (existing.agent.isDead) {
					existing.dispose()
					this.runtimes.delete(id)
				} else {
					existing.touch()
					endGetRuntime({ cache: "hit" })
					return existing
				}
			}
			let opened
			try {
				const endOpen = this.diagnostics?.span?.("RuntimeManager.openSession", { sessionId: id })
				try {
					opened = await openSession(id)
				} finally {
					endOpen?.()
				}
			} catch (/** @type {any} */ err) {
				if (err?.code === "ENOENT" || /Session not found/.test(err?.message ?? "")) {
					this.db.markSessionDeleted(id)
					throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
				}
				throw err
			}
			const cwd = opened.session.getMetadata().cwd ?? this.cwd
			if (this.opts.noContextFiles !== true && opened.session.getSessionConfig?.().noContextFiles !== true) await ensureProjectContextMessage(opened.session, cwd)
			this.upsertSession(opened.session, opened.id)
			const runtime = await this.createRuntime(opened.session, opened.id)
			endGetRuntime({ cache: "miss" })
			return runtime
		} finally {
			endGetRuntime({ error: true })
		}
	}

	async createSession(cwd = this.cwd) {
		const initial = initialSessionEnvironment(cwd)
		const opened = await createSession(initial.cwd)
		if (this.opts.noContextFiles !== true) await ensureProjectContextMessage(opened.session, initial.cwd)
		this.upsertSession(opened.session, opened.id)
		const runtime = await this.createRuntime(opened.session, opened.id)
		const settings = this.opts.getSettings?.()
		if (settings?.defaultModel) {
			const previousModel = runtime.agent.state.model
			const previousPrompt = runtime.agent.state.systemPrompt
			runtime.agent.state.model = await resolveModelWithProviderMetadata(settings.defaultModel, { providers: settings.providers })
			if (previousPrompt === systemPromptFor(initial.cwd, previousModel)) runtime.agent.state.systemPrompt = systemPromptFor(initial.cwd, runtime.agent.state.model)
		}
		const thinkingLevel = normalizeReasoningLevel(settings?.thinkingLevel)
		if (thinkingLevel) runtime.agent.state.thinkingLevel = /** @type {any} */ (thinkingLevel)
		await opened.session.appendConfigPatch(sessionConfigForAgent(runtime.agent, {
			cwd: initial.cwd,
			worktree: initial.cwd,
			environmentId: initial.environmentId,
			noContextFiles: this.opts.noContextFiles === true,
		}))
		runtime.refreshSessionPropertyCache({ source: { kind: "session_create" } })
		return runtime
	}

	async branchSession(sourceId, options = {}) {
		const sourceRuntime = await this.getRuntime(sourceId)
		if (sourceRuntime.agent.state.isStreaming) throw Object.assign(new Error("Abort this session's running turn before branching."), { status: 409 })
		const sourceProps = sourceRuntime.effectiveSessionProperties()
		const sourceConfig = sourceRuntime.session.getSessionConfig?.() ?? {}
		const targetId = await createSessionId()
		const sourceCwd = options.cwd ?? sourceProps.cwd ?? sourceRuntime.cwd ?? this.cwd
		const workspaceBranch = await branchSessionWorkspace({
			sourceSessionId: sourceId,
			targetSessionId: targetId,
			cwd: sourceCwd,
			pathMappings: sessionWorkspacePathMappingsForEnvironment(sourceId, targetId, sourceProps, sourceConfig, sourceRuntime),
		})
		const cwd = workspaceBranch.cwd?.newPath ?? sourceCwd
		const fallbackDescription = firstVisibleUserText(sourceRuntime.agent.state.messages)
		const opened = await branchSession(sourceId, { cwd, sessionId: targetId })
		this.upsertSession(opened.session, opened.id)
		const runtime = await this.createRuntime(opened.session, opened.id)
		const sourceDescription = cleanText(sourceProps.descriptionInUi || fallbackDescription || "Session branch", 148)
		const remappedWorktree = workspaceBranch.remapPath(sourceConfig.worktree)
		await opened.session.appendConfigPatch(sessionConfigForAgent(runtime.agent, {
			...sourceConfig,
			cwd,
			worktree: remappedWorktree ?? sourceConfig.worktree,
		}))
		const propertyPatch = {
			state: sourceProps.state === "needs_input" ? "needs_input" : null,
			descriptionInUi: sourceDescription.startsWith("(branched)") ? sourceDescription : `(branched) ${sourceDescription}`,
			...(workspaceBranch.cwd?.changed ? { cwd } : {}),
		}
		await runtime.appendSessionPropertyPatch(propertyPatch, { kind: "branch" })
		const notice = branchNoticeMessage(workspaceBranch)
		const noticeEntryId = await runtime.session.appendMessage(notice)
		runtime.agent.state.messages.push(notice)
		runtime.agent.msgToEntryId.set(notice, noticeEntryId)
		await this.invalidateSnapshot(opened.id)
		return runtime
	}

	async resumeRunnableInterruptedRuns() {
		const candidates = this.db.listSessions().filter(autoResumeCandidate)
		const resumed = []
		const reconciled = []
		const blocked = []
		for (const entry of candidates) {
			try {
				const runtime = await this.getRuntime(entry.id)
				const state = await runtime.prepareContinuationState()
				if (state.type === "idle" && state.reason === "assistant_complete") {
					if (this.db.finishLatestInterruptedRunForSession(entry.id, { status: "completed", stopReason: "stop" })) {
						reconciled.push(entry.id)
						continue
					}
				}
				if (state.type !== "runnable") {
					blocked.push({ sessionId: entry.id, state })
					continue
				}
				await runtime.continueRun({ waitForCompletion: false })
				resumed.push(entry.id)
			} catch (err) {
				blocked.push({ sessionId: entry.id, error: /** @type {any} */ (err)?.message ?? String(err) })
			}
		}
		if (resumed.length > 0 || reconciled.length > 0 || blocked.length > 0) this.hub.send({ type: "auto_resume", resumed, reconciled, blocked })
		return { resumed, reconciled, blocked }
	}

	async applyLegacyAgentViewFallbacks() {
		const now = Date.now()
		for (const entry of this.db.listSessions()) {
			if (entry.agentView?.state === "legacy") {
				const preview = await loadSessionPreview(entry.id)
				const metadata = completedLegacyMetadata(entry, preview)
				this.db.setAgentViewMetadata(entry.id, metadata)
				this.hub.send({ type: "agent_view_metadata", sessionId: entry.id, metadata })
				continue
			}
			if (!needsLegacyAgentViewFallback(entry.agentView)) continue
			const preview = await loadSessionPreview(entry.id)
			if (!hasVisibleUserPrompt(preview)) continue
			if (olderThanLegacyCompletionWindow(entry.updatedAt, now)) {
				const metadata = completedLegacyMetadata(entry, preview)
				this.db.setAgentViewMetadata(entry.id, metadata)
				this.hub.send({ type: "agent_view_metadata", sessionId: entry.id, metadata })
				continue
			}
		}
	}

	findSessionEntry(id) {
		return this.db.listSessions().find((entry) => entry.id === id)
	}

	async markAgentViewState(id, state, _result, runningMessage) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		if (this.runtimes.get(id)?.isStreaming() || entry.runStatus === "running") throw Object.assign(new Error(runningMessage), { status: 409 })
		const runtime = await this.getRuntime(id)
		const write = await runtime.appendSessionPropertyPatch({ state }, { kind: "user_mark" })
		await this.invalidateSnapshot(id)
		return sessionPropertiesToAgentView(write.properties) ?? {}
	}

	async markCompleted(id) {
		return this.markAgentViewState(id, "completed", "Marked completed by user.", "Cannot mark a running session completed.")
	}

	setPromptDraft(id, text, options = {}) {
		if (!this.findSessionEntry(id)) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		const draft = this.db.setPromptDraft(id, text, options)
		if (draft.applied !== false) this.hub.send({ type: "prompt_draft_update", sessionId: id, draft })
		return draft
	}

	async markDeferred(id) {
		return this.markAgentViewState(id, "deferred", "Deferred by user.", "Cannot defer a running session.")
	}

	async markReadyForReview(id) {
		return this.markAgentViewState(id, null, "Reopened by user.", "Cannot reopen a running session.")
	}

	async deleteStoppedSession(id) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		const runtime = this.runtimes.get(id)
		if (runtime?.isStreaming() || entry.runStatus === "running") throw Object.assign(new Error("Stop the session before deleting it."), { status: 409 })
		runtime?.dispose()
		this.runtimes.delete(id)
		await deleteFileCheckpoints(id)
		this.db.markSessionDeleted(id)
		this.hub.send({ type: "sessions", sessions: await this.sessions() })
		return { ok: true }
	}

	async sessions(cwd = undefined) {
		const end = this.diagnostics?.span?.("RuntimeManager.sessions", { cwd })
		let entries = []
		try {
			this.pruneIdleRuntimes()
			const now = Date.now()
			const endList = this.diagnostics?.span?.("RuntimeManager.db.listSessions", { cwd })
			try {
				entries = this.db.listSessions(cwd)
			} finally {
				endList?.({ count: entries.length })
			}
			const endPreviews = this.diagnostics?.span?.("RuntimeManager.loadSessionPreviews", { count: entries.length })
			const previewRowsBySessionId = new Map()
			try {
				const ids = entries.map((entry) => entry.id)
				for (const row of this.db.loadSessionOverviewPreviewMessagesForSessions(ids)) {
					const rows = previewRowsBySessionId.get(row.sessionId) ?? []
					rows.push(row)
					previewRowsBySessionId.set(row.sessionId, rows)
				}
			} finally {
				endPreviews?.({ count: previewRowsBySessionId.size })
			}
			return entries.map((entry) => {
				const runtime = this.runtimes.get(entry.id)
				const liveRunning = runtime?.isStreaming() === true
				const preview = sessionPreviewFromMessages(previewRowsBySessionId.get(entry.id) ?? [])
				let agentView = entry.agentView
				const lifecycleState = lifecycleStateForSession(entry, preview, liveRunning)
				const fallbackState = fallbackAgentViewState(entry, preview, now)
				if (agentView?.state === "legacy") {
					agentView = completedLegacyMetadata(entry, preview)
					this.db.setAgentViewMetadata(entry.id, agentView)
				}
				if (fallbackState === "completed" && needsLegacyAgentViewFallback(agentView)) {
					agentView = completedLegacyMetadata({ ...entry, agentView }, preview)
					this.db.setAgentViewMetadata(entry.id, agentView)
				}
				return {
					id: entry.id,
					cwd: entry.cwd,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					latestRunStartedAt: entry.latestRunStartedAt,
					runStatus: liveRunning ? "running" : entry.runStatus,
					runtimeState: liveRunning ? "running" : entry.runtimeState,
					lifecycleState,
					preview,
					agentView,
					agentViewFallbackState: fallbackState,
				}
			})
		} finally {
			end?.({ count: entries.length })
		}
	}

	async snapshot(id = this.initialSessionId, options = this.snapshotOptions) {
		if (!id) throw new Error("No session selected")
		const end = this.diagnostics?.span?.("RuntimeManager.snapshot", {
			sessionId: id,
			includeSessions: options.includeSessions === true,
		})
		try {
			return (await this.getRuntime(id)).snapshot(options)
		} finally {
			end?.()
		}
	}

	async contextReport(id = this.initialSessionId) {
		if (!id) throw new Error("No session selected")
		return (await this.getRuntime(id)).contextReport()
	}

	async systemReport(id = this.initialSessionId) {
		if (!id) throw new Error("No session selected")
		return (await this.getRuntime(id)).systemReport()
	}

	async worktrees(id = this.initialSessionId) {
		if (!id) throw new Error("No session selected")
		const existing = this.runtimes.get(id)
		if (existing && !existing.agent.isDead) return existing.worktrees()
		if (existing?.agent.isDead) {
			existing.dispose()
			this.runtimes.delete(id)
		}
		try {
			const opened = await openSession(id)
			return sessionGitWorktreeStatuses(opened.session)
		} catch (/** @type {any} */ err) {
			if (err?.code === "ENOENT" || /Session not found/.test(err?.message ?? "")) {
				this.db.markSessionDeleted(id)
				throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
			}
			throw err
		}
	}

	async invalidateSnapshot(id, options = this.snapshotOptions) {
		if (!id) throw new Error("No session selected")
		const end = this.diagnostics?.span?.("RuntimeManager.invalidateSnapshot", {
			sessionId: id,
			includeSessions: options.includeSessions === true,
		})
		try {
			const cursor = this.runtimes.get(id)?.snapshotCursor() ?? { seq: this.getEventSeq(id), viewEpoch: this.getViewEpoch(id) }
			this.hub.send({
				type: "snapshot_invalidated",
				sessionId: id,
				scopes: options.includeSessions === true ? ["session", "sessions"] : ["session"],
				cursor,
			})
		} finally {
			end?.()
		}
	}

	pruneIdleRuntimes(now = Date.now()) {
		const idle = [...this.runtimes.values()]
			.filter((runtime) => !runtime.isStreaming() && !runtime.hasBackgroundWork() && runtime.sessionId !== this.initialSessionId)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt)
		const expired = idle.filter((runtime) => now - runtime.lastActiveAt > this.idleRuntimeTtlMs)
		const overLimit = idle.slice(0, Math.max(0, idle.length - this.maxIdleRuntimes))
		for (const runtime of new Set([...expired, ...overLimit])) {
			if (runtime.isStreaming()) continue
			runtime.dispose()
			this.runtimes.delete(runtime.sessionId)
		}
	}

	dispose() {
		for (const runtime of this.runtimes.values()) runtime.dispose()
		this.runtimes.clear()
	}
}
