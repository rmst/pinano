// Live runtime for one opened Cerex session.

import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"

import { messageHasRetryableModelError } from "../../../ai-apis/model-errors.js"
import { isModelIoLogEnabled } from "../../../ai-apis/model-io-log.js"
import { closeModelSessionResources } from "../../../ai-apis/session-resources.js"
import { contextLoadDisplayMessage } from "../../../session-manager/context-display.js"
import { contextFileIdentity } from "../../../session-manager/context-identity.js"
import { transcriptManifestMessage } from "../../../session-manager/session-entry-manifest.js"
import { PLAN_UPDATE_CUSTOM_TYPE, normalizePlanUpdateEntryData, planUpdateDisplayMessage } from "../../../session-manager/plan-update-entry.js"
import { PROJECT_LOCATION_CUSTOM_TYPE, applyProjectLocationToConfig, applyProjectLocationToProperties } from "../../../session-manager/project-location-entry.js"
import { isProjectContextMessage, loadProjectContext } from "../../project/context.js"
import { compact, summarizeMessages } from "../../compaction/index.js"
import { modelRef, resolveModel, sessionModelEligibilityError } from "../../model/registry.js"
import { sessionActivityAt } from "../activity.js"
import { persistPromptImageAttachments, readPromptImageAttachmentVariant } from "../attachments.js"
import { deriveSessionRunState, startedToolsWithoutDurableResult, synthesizeUnknownToolResultsForStartedTools } from "../run-state.js"
import { completeEnvironmentPatch, getEnvironment, loadEnvironmentRegistry } from "../../environment/registry.js"
import { handleFastCommand } from "../../agent/fast-mode.js"
import { createCodeModeApi } from "../../code-mode/api.js"
import { appendFileRestoreEntry, restoreFilesToCheckpoint } from "../file-checkpoints.js"
import { messageKey } from "../state.js"
import { activeContextFiles, buildModelMessagesForSession, contextFilesDisabledForAgent, conversationEntriesForModel, projectAutomatedMaintenanceMessages } from "../context.js"
import { environmentContextFor, prependEnvironmentContext } from "../../environment/context.js"
import { previewPublicUrlFromSettings } from "../../preview/manifest.js"
import { buildWorkspaceSkillsContextForPrompt, mergeSkillsContext, prependSkillsContext } from "../../context/skills.js"
import { summarizeContext } from "../../context/summary.js"
import { formatContextReport } from "../../context/report.js"
import { formatSystemReport } from "../../project/context-display.js"
import { sessionWorkspacePath } from "../../paths.js"
import { stateMountFromSettings } from "../../settings.js"
import { sessionSandboxBaseWd, sessionSandboxMounts } from "../config.js"
import { pathIsWithin } from "../../sandbox/paths.js"
import { createModelRetryPlan, modelRetryDelayMs } from "../../model/retry-policy.js"
import { DOCKER_PROXY_ROUTE, handleDockerProxyRequest } from "../../../proxy-tools/docker/host.js"
import { GITHUB_PROXY_ROUTE, handleGithubProxyRequest } from "../../../proxy-tools/github/host.js"
import { GithubPermissionController } from "../../permissions/github.js"
import { PermissionRequestBroker } from "../../permissions/tool.js"
import { GIT_WORKTREE_CLOSE_OPERATION, GIT_WORKTREE_CUSTOM_TYPE, GIT_WORKTREE_TERMINAL_APPLIED, WORKTREE_EVENT_ROUTE, closeSessionGitWorktree, normalizeGitWorktreeEventPayload, sessionGitWorktreeStatuses, sessionOpenGitWorktreeRecords } from "../../source-control/worktree-events.js"
import { internalHttpJsonResponse } from "../../workers/internal-http.js"
import { SESSION_BRIDGE_ROUTE } from "../bridge-protocol.js"
import { PROMPT_IMAGE_CLOSE_TAG, promptImageLabel, promptImageLabelsForText, promptImageOpenTag, promptImagePlaceholders } from "../../../../../protocol/src/prompt-images.js"
import {
	SESSION_CUSTOM_TYPE_PROPERTIES,
	SESSION_COMPLETED_STATE,
	SESSION_DEFERRED_STATE,
	SESSION_DISCUSSING_STATE,
	SESSION_NEEDS_INPUT_STATE,
	SESSION_WORKTREE_LIFECYCLE_MAINTENANCE,
	createMaintenancePromptMessage,
	createWorktreeLifecyclePromptMessage,
	getEffectiveSessionProperties,
	isAutomatedMaintenanceMessage,
	isHumanUserEntry,
	normalizeSessionPropertyPatch,
	patchIsMeaningful,
	sessionPropertiesToAgentView,
} from "../properties.js"
import {
	SESSION_CUSTOM_TYPE_BRANCH_SWITCH,
	SESSION_CUSTOM_TYPE_REWIND,
} from "../custom-types.js"
import {
	formatTranscriptEntries,
	projectVisibleEntries,
	projectVisibleMessage,
	sessionMaintenanceToolAvailable,
	textFromContent,
	transcriptOptionsForPayload,
	visibleMessage,
} from "./transcript-projection.js"
import {
	cancellableBranchUserMessages,
	isCancellableUserMessage,
	normalizeQueuedMessageItem,
	promptDraftFromMessages,
	promptDraftResponseFromMessages,
	queuedAgentMessages,
} from "./prompt-drafts.js"
import { buildBranchTipItems, buildRewindTargets, entryMessageText } from "./branch-navigation.js"
import {
	PRE_TURN_MAINTENANCE_PLACEMENT,
	PRE_TURN_SESSION_PROPERTIES_MAX_TOOL_CALLS,
	activeAutomatedMaintenanceUser,
	asPreTurnMaintenanceMessage,
	automatedMaintenanceExchangeActive,
	preTurnSessionPropertiesMaintenanceActive,
} from "./maintenance.js"
/** @typedef {import("../../agent/runtime.js").AgentRuntime} Agent */
/** @typedef {import("../../../session-manager/index.js").Session} Session */
/** @typedef {import("../../../persistence/server-contract.js").ServerPersistence} ServerPersistence */
import {
	UNKNOWN_TOOL_RECOVERY_MAX_ATTEMPTS,
	parseInternalJsonBody,
	recoveryContinuationOptions,
	assistantMessageHasOutput,
	entryIsAgentOutputBoundary,
	cleanStreamingBehavior,
	sessionActivityFromRuntimeEvent,
	isWorktreeLifecycleState,
	sessionPatchNormalizeOptionsForSource,
	activeWorktreeStatusForCwd,
	sleep,
	sessionInfoFromEntry,
	projectCwdForSessionEntry,
	projectCwdForSnapshot,
	applyAgentModel,
	sessionConfigAt,
} from "./runtime-helpers.js"

const PROMPT_IMAGE_LABEL_TEXT_RE = /\[Image #\d+\]/g

export class SessionRuntime {
	/**
	 * @param {object} options
	 * @param {string} options.sessionId
	 * @param {string} options.cwd
	 * @param {Session} options.session
	 * @param {Agent} options.agent
	 * @param {ServerPersistence} options.db
	 * @param {(event: any) => void} options.emit
	 * @param {() => Promise<any[]>} options.sessions
	 * @param {(sessionId: string) => Promise<void>} options.invalidateSnapshot
	 * @param {(sessionId: string, options?: { force?: boolean, reason?: string, delayMs?: number }) => void} [options.refreshWorktrees]
	 * @param {(projectDir: string, options?: { force?: boolean }) => Promise<any>} [options.registerProjectRoot]
	 * @param {() => string | undefined} [options.getPreviewPublicUrl]
	 * @param {string} [options.cursorGeneration]
	 * @param {() => number} options.nextEventSeq
	 * @param {() => number} options.getEventSeq
	 * @param {() => number} options.getViewEpoch
	 * @param {() => number} options.bumpViewEpoch
	 * @param {() => { providers?: Record<string, any> }} [options.getSettings]
	 * @param {import("../../workspace/client.js").WorkspaceClient} options.workspace
	 * @param {string} [options.workspaceRoot]
	 * @param {(properties: any) => { version: 1, projectId: string, previousRoot: string, root: string } | undefined} [options.projectLocationChange]
	 * @param {any} [options.legacySessionProperties]
	 * @param {boolean} [options.projectMaintenanceSession]
	 * @param {any} [options.subSessions]
	 * @param {SessionBridge} [options.sessionBridge]
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
		this.refreshWorktrees = options.refreshWorktrees
		this.registerProjectRoot = options.registerProjectRoot
		this.getPreviewPublicUrl = options.getPreviewPublicUrl
		this.cursorGeneration = options.cursorGeneration
		this.workspace = options.workspace
		this.nextEventSeqValue = options.nextEventSeq
		this.getEventSeq = options.getEventSeq
		this.getViewEpoch = options.getViewEpoch
		this.bumpViewEpoch = options.bumpViewEpoch
		this.getSettings = options.getSettings
		this.workspaceRoot = options.workspaceRoot
		this.getProjectLocationChange = options.projectLocationChange
		this.subSessions = options.subSessions
		this.sessionBridge = options.sessionBridge
		this.diagnostics = options.diagnostics
		this.currentRunId = null
		this.finishedRunIds = new Set()
		this.activeToolCalls = new Map()
		this.githubPermission = new GithubPermissionController()
		this.runtimeNeedsInput = false
		this.permissionRequests = new PermissionRequestBroker({
			isGranted: (permission, context) => this.githubPermission.isGranted(permission, context),
			requestContext: (permission) => this.githubPermission.requestContext(permission),
			grant: (permission, request) => this.githubPermission.grant(permission, request),
			settle: (permission, context, granted) => this.githubPermission.settle(permission, context, granted),
			onPendingChange: (count) => {
				const runtimeNeedsInput = count > 0
				if (runtimeNeedsInput === this.runtimeNeedsInput) return
				this.runtimeNeedsInput = runtimeNeedsInput
				this.emit({ type: "session_list_changed", sessionId: this.sessionId })
			},
		})
		this.nextMessageEventId = 1
		this.messageEventIds = new WeakMap()
		this.messageEventIdsByKey = new Map()
		this.streamingAssistantMessageId = null
		this.lastActiveAt = Date.now()
		this.turnStartQueue = Promise.resolve()
		this.disposed = false
		this.pendingModelRetryCount = 0
		this.currentPrompt = undefined
		this.promptCancellation = undefined
		this.codeModeApiScope = undefined
		this.legacySessionProperties = options.legacySessionProperties
		this.projectMaintenanceSession = options.projectMaintenanceSession === true
		this.currentRunToolNames = new Set()
		this.automatedMaintenanceTurnActive = false
		this.automatedMaintenanceKind = undefined
		this.visibleMaintenanceToolCallIds = new Set()
		this.currentSkillsContext = undefined
		this.pendingProjectionTasks = new Set()
		this.nextPromptImageNumberFloor = undefined
		this.installCodeModeApi(this.agent)
		this.agent.requestPermission = (toolCallId, permission, reason, signal) => this.permissionRequests.request(toolCallId, permission, reason, signal)
		const existingModelForRequest = this.agent.modelForRequest
		this.agent.modelForRequest = (ctx) => {
			const maintenanceModel = this.maintenanceModelForRequest(ctx)
			if (maintenanceModel) return maintenanceModel
			return existingModelForRequest?.call(this.agent, ctx)
		}
		const existingPreTurnMessages = this.agent.preTurnMessages
		const existingMaxToolCalls = this.agent.maxToolCalls
		this.agent.automatedFollowUp = (ctx) => this.automatedMaintenanceFollowUp(ctx)
		this.agent.preTurnMessages = async (ctx) => [
			...(await this.automatedMaintenancePreTurn(ctx)),
			...((await existingPreTurnMessages?.call(this.agent, ctx)) ?? []),
		]
		this.agent.maxToolCalls = async (ctx) => {
			const existing = await existingMaxToolCalls?.call(this.agent, ctx)
			const maintenance = this.preTurnSessionPropertiesMaxToolCalls(ctx)
			if (existing !== undefined && maintenance !== undefined) return Math.min(existing, maintenance)
			return existing ?? maintenance
		}
		const existingTransformContext = this.agent.transformContext
		this.agent.transformContext = async (messages, signal) => {
			const transformed = existingTransformContext ? await existingTransformContext.call(this.agent, messages, signal) : messages
			return this.resolveImageAttachmentsForModel(transformed)
		}
		this.agent.resolveModelInputAttachments = (messages) => this.resolveImageAttachmentsForModel(messages)
		this.agent.projectMessagesForNextAction = (ctx) => this.projectMessagesForNextAction(ctx)
		this.agent.onContextLoad = (entry) => this.handleContextLoad(entry)
		this.agent.environmentContext = () => this.environmentContext()
		this.agent.skillsContext = () => this.currentSkillsContext
		this.hydrateAgentFromSession()
		this.unsubscribe = this.agent.subscribe((event) => this.trackProjection(async () => {
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
		}))
		this.unsubscribeCompaction = this.agent.subscribeCompaction((message) => this.trackProjection(async () => {
			const end = this.diagnostics?.span?.("SessionRuntime.handleCompaction", { sessionId: this.sessionId })
			try {
				await this.handleCompaction(message)
			} finally {
				end?.()
			}
		}))
	}

	touch() {
		this.lastActiveAt = Date.now()
	}

	trackProjection(operation) {
		let tracked
		tracked = operation().finally(() => this.pendingProjectionTasks.delete(tracked))
		this.pendingProjectionTasks.add(tracked)
		return tracked
	}

	async waitForPendingProjections() {
		while (this.pendingProjectionTasks.size > 0) await Promise.all([...this.pendingProjectionTasks])
	}

	promptImageRefsByNumber() {
		const refs = new Map()
		for (const message of this.agent.state.messages ?? []) {
			if (!Array.isArray(message?.content)) continue
			for (const block of message.content) {
				if (block?.type !== "image" || !block.attachmentId) continue
				const number = Number(block.imageNumber)
				if (!Number.isInteger(number) || number <= 0) continue
				refs.set(number, { ...block })
			}
		}
		return refs
	}

	promptImageMinimumNumber(refsByNumber = this.promptImageRefsByNumber()) {
		let maximum = Math.max(0, ...refsByNumber.keys())
		if (this.nextPromptImageNumberFloor === undefined) {
			for (const entry of this.session.getEntries()) {
				if (entry?.type !== "message" || !Array.isArray(entry.message?.content)) continue
				for (const block of entry.message.content) {
					const number = Number(block?.imageNumber)
					if (block?.type === "image" && Number.isInteger(number) && number > maximum) maximum = number
				}
			}
		}
		this.nextPromptImageNumberFloor = Math.max(this.nextPromptImageNumberFloor ?? 1, maximum + 1)
		return this.nextPromptImageNumberFloor
	}

	withPromptImageDetail(block, source) {
		if (!block) return undefined
		return {
			...block,
			...(source?.detail ? { detail: source.detail } : block.detail ? { detail: block.detail } : {}),
		}
	}

	async resolveSubmittedPromptImage(image, refsByNumber) {
		if (image?.attachmentId) {
			const block = await this.db.getImageAttachment(image.attachmentId)
			if (!block || (image.attachmentSessionId && image.attachmentSessionId !== block.attachmentSessionId)) {
				throw Object.assign(new Error(`Prompt image attachment not found: ${image.attachmentId}`), { status: 404 })
			}
			return this.withPromptImageDetail(block, image)
		}
		const number = Number(image?.imageNumber)
		if (Number.isInteger(number) && number > 0) {
			return this.withPromptImageDetail(refsByNumber.get(number) ?? await this.db.getImageAttachmentByNumber(this.sessionId, number), image)
		}
		return undefined
	}

	replacePromptImageLabels(text, replacements) {
		if (replacements.size === 0) return text
		return String(text || "").replace(PROMPT_IMAGE_LABEL_TEXT_RE, (label) => replacements.get(label) ?? label)
	}

	promptImageContentFromBlocks(message, imageBlocks) {
		const content = imageBlocks.flatMap((image) => [
			{ type: "text", text: promptImageOpenTag(promptImageLabel(image.imageNumber)) },
			image,
			{ type: "text", text: PROMPT_IMAGE_CLOSE_TAG },
		])
		if (message) content.push({ type: "text", text: message })
		if (content.length === 0) content.push({ type: "text", text: "" })
		return content
	}

	async materializePromptContent(message, images = []) {
		const originalText = String(message || "")
		const originalLabels = promptImageLabelsForText(originalText)
		const refsByNumber = this.promptImageRefsByNumber()
		const submittedBlocks = new Array(images.length)
		const inlineImages = []
		const inlineIndexes = []
		for (let i = 0; i < images.length; i += 1) {
			const existing = await this.resolveSubmittedPromptImage(images[i], refsByNumber)
			if (existing?.attachmentId) {
				submittedBlocks[i] = existing
			} else {
				inlineImages.push(images[i])
				inlineIndexes.push(i)
			}
		}
		const numberingRefs = new Map(refsByNumber)
		for (const block of submittedBlocks) {
			const number = Number(block?.imageNumber)
			if (Number.isInteger(number) && number > 0) numberingRefs.set(number, block)
		}
		const created = inlineImages.length > 0
			? await persistPromptImageAttachments(this.db, this.sessionId, inlineImages, {
				minimumNumber: this.promptImageMinimumNumber(numberingRefs),
				diagnostics: this.diagnostics,
			})
			: []
		for (const block of created) {
			const number = Number(block?.imageNumber)
			if (Number.isInteger(number)) this.nextPromptImageNumberFloor = Math.max(this.nextPromptImageNumberFloor ?? 1, number + 1)
		}
		for (let i = 0; i < created.length; i += 1) submittedBlocks[inlineIndexes[i]] = created[i]

		const replacements = new Map()
		for (let i = 0; i < submittedBlocks.length; i += 1) {
			const block = submittedBlocks[i]
			if (!block?.imageNumber) continue
			const oldLabel = originalLabels[i] ?? promptImageLabel(i + 1)
			const newLabel = promptImageLabel(block.imageNumber)
			if (oldLabel !== newLabel) replacements.set(oldLabel, newLabel)
		}
		const finalText = this.replacePromptImageLabels(originalText, replacements)
		const submittedByNumber = new Map(submittedBlocks
			.filter((block) => block?.attachmentId && Number.isInteger(Number(block.imageNumber)))
			.map((block) => [Number(block.imageNumber), block]))
		const finalBlocks = []
		const included = new Set()
		for (const placeholder of promptImagePlaceholders(finalText)) {
			const number = Number(placeholder.index)
			if (included.has(number)) continue
			const block = submittedByNumber.get(number) ?? refsByNumber.get(number) ?? await this.db.getImageAttachmentByNumber(this.sessionId, number)
			if (!block?.attachmentId) continue
			included.add(number)
			finalBlocks.push(block)
		}
		for (const block of submittedBlocks) {
			const number = Number(block?.imageNumber)
			if (!block?.attachmentId || included.has(number)) continue
			included.add(number)
			finalBlocks.push(block)
		}
		return this.promptImageContentFromBlocks(finalText, finalBlocks)
	}

	async resolveImageAttachmentsForModel(messages) {
		const resolveBlock = async (block) => {
			if (block?.type !== "image" || block.data || !block.attachmentId) return block
			const sessionId = block.attachmentSessionId ?? this.sessionId
			const variant = await readPromptImageAttachmentVariant(this.db, sessionId, block.attachmentId, undefined, {
				diagnostics: this.diagnostics,
			})
			if (!variant?.data) throw new Error(`Prompt image attachment not found: ${block.attachmentId}`)
			return {
				...block,
				data: variant.data.toString("base64"),
				mimeType: block.mimeType ?? variant.mimeType,
			}
		}
		return await Promise.all(messages.map(async (message) => {
			if (!Array.isArray(message?.content)) return message
			let changed = false
			const content = await Promise.all(message.content.map(async (block) => {
				const resolved = await resolveBlock(block)
				if (resolved !== block) changed = true
				return resolved
			}))
			return changed ? { ...message, content } : message
		}))
	}

	async normalizeUserCwd(cwd, label = "cwd") {
		return this.workspace.paths.normalizeUserCwd(cwd, label)
	}

	async normalizeStoredCwd(cwd, label = "cwd") {
		return this.workspace.paths.normalizeStoredCwd(cwd, label)
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

	installCodeModeApi(agent = this.agent, fixedScope = undefined) {
		const handler = (request) => this.handleCodeModeApiRequest(request)
		const apiForScope = (scope) => createCodeModeApi({
			getSession: (sessionId) => handler({ op: "session.get", sessionId, scope }),
			setSession: (sessionId, patch) => handler({ op: "session.set", sessionId, patch, scope }),
		})
		agent.codeModeApi = apiForScope(fixedScope)
		agent.codeModeApiForTool = () => apiForScope(fixedScope ?? this.codeModeApiScope)
		agent.codeModeApiScopeForTool = () => fixedScope ?? this.codeModeApiScope
		agent.codeModeApiRequest = handler
	}

	/** @param {string | undefined} sessionId */
	resolveSessionId(sessionId) {
		return sessionId || this.sessionId
	}

	/** @param {string} id */
	async storedSessionEntryAllowed(entry) {
		return await this.workspace.paths.allowsStoredCwd(entry?.cwd)
			&& await this.workspace.paths.allowsStoredCwd(projectCwdForSessionEntry(entry))
	}

	async sessionInfo(id) {
		const entry = await this.db.getSession(id)
		if (entry && !await this.storedSessionEntryAllowed(entry)) {
			throw Object.assign(new Error(`session cwd is outside configured service.workspaceRoot (${this.workspaceRoot}): ${entry.cwd}`), { status: 403 })
		}
		const info = sessionInfoFromEntry(entry)
		if (!info) return undefined
		if (id === this.sessionId) info.properties = this.effectiveSessionProperties()
		return info
	}

	rawEffectiveSessionProperties(fromId = undefined) {
		this.session.legacySessionProperties = this.legacySessionProperties
		return getEffectiveSessionProperties(this.session, fromId)
	}

	effectiveSessionProperties(fromId = undefined) {
		const properties = this.rawEffectiveSessionProperties(fromId)
		return applyProjectLocationToProperties(properties, this.getProjectLocationChange?.(properties))
	}

	effectiveSessionConfig(fromId = undefined) {
		const config = fromId === undefined
			? this.session.getSessionConfig?.() ?? {}
			: sessionConfigAt(this.session, fromId)
		const properties = this.rawEffectiveSessionProperties(fromId)
		return applyProjectLocationToConfig(config, this.getProjectLocationChange?.(properties))
	}

	async reconcileProjectLocation() {
		const properties = this.rawEffectiveSessionProperties()
		const change = this.getProjectLocationChange?.(properties)
		if (!change) return false
		await this.session.appendCustomEntry(PROJECT_LOCATION_CUSTOM_TYPE, change)
		await this.refreshSessionPropertyCache({ source: { kind: "project_location_changed" } })
		this.hydrateAgentFromSession()
		this.bumpViewEpoch()
		await this.invalidateSnapshot(this.sessionId)
		return true
	}

	isProjectMaintenanceSession() {
		return this.projectMaintenanceSession
	}

	visibleProjectionOptions(options = {}) {
		return {
			...options,
			showAutomatedMaintenanceUsers: this.isProjectMaintenanceSession(),
		}
	}

	projectCwd() {
		return projectCwdForSnapshot(this.session, this.effectiveSessionProperties(), this.cwd)
	}

	async bridgeProjectInfo() {
		return this.workspace.project.info(this.projectCwd())
	}

	async bridgeProjectSet(name, options = {}) {
		const result = await this.workspace.project.setName(this.projectCwd(), name)
		if (options.invalidate !== false) await this.invalidateSnapshot(this.sessionId)
		return result
	}

	environmentContext() {
		const props = this.effectiveSessionProperties()
		const config = this.effectiveSessionConfig()
		const sandboxBaseWd = sessionSandboxBaseWd(config, props.projectDir, props.cwd ?? this.cwd)
		return environmentContextFor({
			cwd: props.cwd ?? this.cwd,
			initialCwd: sandboxBaseWd,
			sandboxMounts: sessionSandboxMounts(config),
			environmentId: props.environmentId,
			sessionId: this.sessionId,
			sessionWorkspacePath: sessionWorkspacePath(this.sessionId),
			previewPublicUrl: this.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.getSettings?.()),
			stateMount: stateMountFromSettings(this.getSettings?.()),
			mountCurrentCwd: true,
		})
	}

	skillsCwd() {
		return this.effectiveSessionProperties().cwd ?? this.cwd
	}

	async replaceSkillsContextForText(text) {
		this.currentSkillsContext = await buildWorkspaceSkillsContextForPrompt(this.skillsCwd(), text, this.workspace)
		return this.currentSkillsContext
	}

	async mergeSkillsContextForText(text) {
		const next = await buildWorkspaceSkillsContextForPrompt(this.skillsCwd(), text, this.workspace)
		this.currentSkillsContext = mergeSkillsContext(
			this.currentSkillsContext,
			next,
		)
		return this.currentSkillsContext
	}

	clearSkillsContext() {
		this.currentSkillsContext = undefined
	}

	latestHumanPromptText() {
		const branch = this.session.getBranch?.() ?? []
		const entry = [...branch].reverse().find((candidate) => isHumanUserEntry(candidate) && !isProjectContextMessage(candidate.message))
		return entry ? entryMessageText(entry) : ""
	}

	async refreshSessionPropertyCache(options = {}) {
		const raw = this.rawEffectiveSessionProperties()
		const config = this.session.getSessionConfig?.() ?? {}
		await this.db.setSessionTranscriptProjection(this.sessionId, {
			cwd: raw.cwd,
			initialWd: config.initialWd,
			projectDir: raw.projectDir ?? null,
			updatedAt: sessionActivityAt(this.session),
		})
		const props = applyProjectLocationToProperties(raw, this.getProjectLocationChange?.(raw))
		if (props.cwd && props.cwd !== this.cwd) this.cwd = props.cwd
		const metadata = sessionPropertiesToAgentView(props) ?? {}
		await this.db.setAgentViewMetadata(this.sessionId, metadata)
		this.emitRuntimeEvent({ type: "agent_view_metadata", metadata, source: options.source })
		return props
	}

	async touchSessionActivity(updatedAt = sessionActivityAt(this.session)) {
		const cwd = this.rawEffectiveSessionProperties().cwd ?? this.session.getMetadata().cwd ?? this.cwd
		await this.db.touchSession(this.sessionId, cwd, updatedAt)
	}

	async appendCwdContextLoad(cwd) {
		if (!cwd || contextFilesDisabledForAgent(this.agent)) return
		const loadedContextFiles = new Set(activeContextFiles(this.session).map(contextFileIdentity))
		const files = (await loadProjectContext(cwd, this.workspace)).filter((file) => !loadedContextFiles.has(contextFileIdentity(file)))
		if (files.length === 0) return
		const load = { source: "cwd", cwd, loadedAt: new Date().toISOString(), files }
		const entryId = await this.session.appendContextLoad(load)
		this.handleContextLoad({ entryId, timestamp: load.loadedAt, contextLoad: load })
	}

	async appendSessionPropertyPatch(patch, source = undefined, options = {}) {
		const normalizeOptions = sessionPatchNormalizeOptionsForSource(source)
		let normalized = normalizeSessionPropertyPatch(patch, normalizeOptions)
		const registry = loadEnvironmentRegistry()
		if (normalized.environmentId) getEnvironment(normalized.environmentId, registry)
		const before = this.effectiveSessionProperties()
		normalized = completeEnvironmentPatch(normalized, before, registry)
		if (normalized.cwd) {
			normalized = {
				...normalized,
				cwd: options.allowStoredCwd === true
					? await this.normalizeStoredCwd(normalized.cwd, "session cwd")
					: await this.normalizeUserCwd(normalized.cwd, "session cwd"),
			}
		}
		let projectRegistration
		if (normalized.projectDir) {
			projectRegistration = await this.registerProjectRoot?.(normalized.projectDir, { force: true })
			if (projectRegistration?.projectDir) normalized = { ...normalized, projectDir: projectRegistration.projectDir }
		}
		if (normalized.projectDir) {
			normalized = {
				...normalized,
				projectDir: options.allowStoredCwd === true
					? await this.normalizeStoredCwd(normalized.projectDir, "session project-dir")
					: await this.normalizeUserCwd(normalized.projectDir, "session project-dir"),
			}
		}
		const environmentChangeBlocked = this.automatedMaintenanceTurnActive
			&& Object.prototype.hasOwnProperty.call(normalized, "environmentId")
			&& (before.environmentId ?? null) !== (normalized.environmentId ?? null)
		if (environmentChangeBlocked) throw new Error("Automated session metadata maintenance may not change environmentId")

		const changed = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => (before[key] ?? null) !== (value ?? null)))
		const unchanged = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => (before[key] ?? null) === (value ?? null)))
		if (this.automatedMaintenanceTurnActive && Object.prototype.hasOwnProperty.call(changed, "projectTag")) {
			throw new Error("Automated session metadata maintenance may not change legacy projectTag")
		}
		const writeResult = (properties) => ({
			properties,
			patch: normalized,
			changed,
			unchanged,
			noChange: Object.keys(changed).length === 0,
		})
		if (!patchIsMeaningful(normalized)) return writeResult(before)
		if (Object.keys(changed).length === 0 && options.force !== true) return writeResult(before)
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
		if (Object.prototype.hasOwnProperty.call(changed, "projectDir")) {
			if (after.projectDir) {
				if (projectRegistration?.projectId) await this.db.setSessionProject(this.sessionId, projectRegistration.projectId, projectRegistration.projectDir)
			}
			else await this.db.setSessionProject(this.sessionId, null, null)
		}
		const properties = await this.refreshSessionPropertyCache({ source })
		if (Object.prototype.hasOwnProperty.call(changed, "cwd")) await this.appendCwdContextLoad(properties.cwd)
		return writeResult(properties)
	}

	async refreshWorktreeModeExitLifecycle(source = undefined) {
		if (sessionOpenGitWorktreeRecords(this.session).length > 0) return undefined
		const props = this.effectiveSessionProperties()
		if (!isWorktreeLifecycleState(props.state)) return undefined
		const state = source?.terminalState === GIT_WORKTREE_TERMINAL_APPLIED ? SESSION_COMPLETED_STATE : SESSION_DISCUSSING_STATE
		return await this.appendSessionPropertyPatch({ state }, source ?? { kind: "worktree_mode_exit" })
	}

	/** @param {any} scope @param {string} id */
	assertCodeModeScopeCurrent(scope, id) {
		if (!scope?.anchorEntryId) return
		if (id !== this.sessionId) throw new Error("Automated session maintenance can only update its current session")
		if (this.session.getLeafId() !== scope.anchorEntryId) throw new Error("Session changed since automated maintenance started")
	}

	async handleInternalWorktreeEvent(request, workerContext = undefined) {
		if (request.method !== "POST") return internalHttpJsonResponse({ error: "Method Not Allowed" }, 405)
		const payload = parseInternalJsonBody(request)
		if (payload?.operation === GIT_WORKTREE_CLOSE_OPERATION) {
			let result
			try {
				const request = normalizeGitWorktreeEventPayload(payload, { workerContext })
				const cwd = this.effectiveSessionProperties().cwd ?? this.cwd
				if (request?.path && cwd && pathIsWithin(request.path, cwd)) {
					const record = sessionOpenGitWorktreeRecords(this.session).find((candidate) => candidate.path === request.path)
					const example = record?.repositoryRoot ? ` For example: cerex session set cwd ${record.repositoryRoot}` : ""
					throw Object.assign(new Error(`Session cwd is inside this worktree. Set cwd outside ${request.path} before closing it.${example}`), {
						status: 409,
						code: "worktreeContainsSessionCwd",
					})
				}
				result = await closeSessionGitWorktree(this.session, payload, { workerContext, workspace: this.workspace })
			} catch (err) {
				const cleanup = err?.cleanup && typeof err.cleanup === "object" ? err.cleanup : undefined
				return internalHttpJsonResponse({
					ok: false,
					recorded: false,
					error: err?.message ?? String(err),
					...(cleanup ? { cleanup } : {}),
				}, err?.status ?? 500)
			}
			if (!result) return internalHttpJsonResponse({ ok: true, recorded: false })
			await this.refreshWorktreeModeExitLifecycle({ kind: "worktree_mode_exit", operation: payload.operation, terminalState: result.event?.terminalState })
			await this.invalidateSnapshot(this.sessionId)
			this.emit({ type: "session_list_changed", sessionId: this.sessionId })
			this.refreshWorktrees?.(this.sessionId, { force: true, reason: "internal_worktree_close" })
			const body = {
				ok: result.cleanupOk !== false,
				recorded: !result.alreadyClosed,
				alreadyClosed: result.alreadyClosed === true,
				entryId: result.entryId,
				event: result.event,
				cleanup: result.cleanup,
				...(result.cleanupError ? { error: result.cleanupError } : {}),
			}
			return internalHttpJsonResponse(body, result.cleanupOk === false ? 409 : result.alreadyClosed ? 200 : 201)
		}
		const event = normalizeGitWorktreeEventPayload(payload, { workerContext })
		if (!event) return internalHttpJsonResponse({ ok: true, recorded: false })
		const entryId = await this.session.appendCustomEntry(GIT_WORKTREE_CUSTOM_TYPE, event)
		await this.invalidateSnapshot(this.sessionId)
		this.emit({ type: "session_list_changed", sessionId: this.sessionId })
		this.refreshWorktrees?.(this.sessionId, { force: true, reason: "internal_worktree_event" })
		return internalHttpJsonResponse({ ok: true, recorded: true, entryId }, 201)
	}

	async handleInternalBridgeSessionRequest(request) {
		if (request.method !== "POST") return internalHttpJsonResponse({ error: "Method Not Allowed" }, 405)
		const payload = parseInternalJsonBody(request)
		const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : undefined
		if (!sessionId) throw Object.assign(new Error("session id is required"), { status: 400 })
		if (payload.operation === "session.get") {
			const session = this.sessionBridge?.get
				? await this.sessionBridge.get(sessionId)
				: await this.sessionInfo(sessionId)
			if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, session })
		}
		if (payload.operation === "session.set") {
			const source = {
				kind: "bridge",
				name: "agent-command",
				...(typeof payload.toolCallId === "string" && payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
			}
			const session = this.sessionBridge?.set
				? await this.sessionBridge.set(sessionId, payload.patch, source)
				: undefined
			if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, ...session }, 201)
		}
		if (payload.operation === "session.lifecycle") {
			if (sessionId !== this.sessionId) throw Object.assign(new Error("session lifecycle can only update the current session"), { status: 403 })
			if (this.automatedMaintenanceKind !== SESSION_WORKTREE_LIFECYCLE_MAINTENANCE) {
				throw Object.assign(new Error("session lifecycle can only be updated by automated worktree maintenance"), { status: 409 })
			}
			const source = {
				kind: "worktree_lifecycle",
				name: "agent-command",
				...(typeof payload.toolCallId === "string" && payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
			}
			const write = await this.appendSessionPropertyPatch({ state: payload.state }, source)
			await this.invalidateSnapshot(this.sessionId)
			const session = await this.sessionInfo(this.sessionId)
			if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, session, write }, 201)
		}
		if (payload.operation === "session.cat") {
			const transcriptOptions = transcriptOptionsForPayload(payload)
			const text = this.sessionBridge?.cat
				? await this.sessionBridge.cat(sessionId, transcriptOptions)
				: sessionId === this.sessionId
					? formatTranscriptEntries(this.sessionId, this.session.getDisplayEntries(), this.visibleProjectionOptions(transcriptOptions))
					: undefined
			if (text === undefined) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, text })
		}
		if (payload.operation === "sessions.list") {
			if (!this.sessionBridge?.list) throw Object.assign(new Error("session collection bridge is unavailable"), { status: 404 })
			const filters = payload.filters && typeof payload.filters === "object" && !Array.isArray(payload.filters) ? payload.filters : {}
			const text = await this.sessionBridge.list(filters)
			return internalHttpJsonResponse({ ok: true, text })
		}
		if (payload.operation === "sessions.cat") {
			return internalHttpJsonResponse({
				error: "sessions.cat bridge operation was removed; call sessions.list and then session.cat for each returned session id",
			}, 410)
		}
		if (payload.operation === "project.get") {
			if (!this.sessionBridge?.projectGet && sessionId !== this.sessionId) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			const project = this.sessionBridge?.projectGet
				? await this.sessionBridge.projectGet(sessionId)
				: await this.bridgeProjectInfo()
			if (!project) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, project })
		}
		if (payload.operation === "project.set") {
			if (!this.sessionBridge?.projectSet && sessionId !== this.sessionId) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			const name = typeof payload.name === "string" ? payload.name : ""
			if (!name.trim()) throw Object.assign(new Error("project name is required"), { status: 400 })
			const result = this.sessionBridge?.projectSet
				? await this.sessionBridge.projectSet(sessionId, name)
				: await this.bridgeProjectSet(name)
			if (!result) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, ...result }, 201)
		}
		if (payload.operation === "preview.list") {
			if (!this.sessionBridge?.previewList && sessionId !== this.sessionId) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			const result = this.sessionBridge?.previewList
				? await this.sessionBridge.previewList(sessionId)
				: undefined
			if (!result) throw Object.assign(new Error(`Session not found: ${sessionId}`), { status: 404 })
			return internalHttpJsonResponse({ ok: true, ...result })
		}
		throw Object.assign(new Error("unsupported bridge session operation"), { status: 400 })
	}

	async handleInternalHttpRequest(request, workerContext = undefined) {
		const url = new URL(request.path || "/", "http://cerex.internal")
		if (url.pathname === SESSION_BRIDGE_ROUTE) return this.handleInternalBridgeSessionRequest(request)
		if (url.pathname === WORKTREE_EVENT_ROUTE) return this.handleInternalWorktreeEvent(request, workerContext)
		if (url.pathname === DOCKER_PROXY_ROUTE) return handleDockerProxyRequest(request, workerContext, { sessionId: this.sessionId })
		if (url.pathname === GITHUB_PROXY_ROUTE) return handleGithubProxyRequest(request, workerContext, {
			sessionId: this.sessionId,
			onCredentialRequired: (credentialRequest) => this.githubPermission.credentialRequired(credentialRequest),
			selectCredential: (target, candidates) => this.githubPermission.selectedCredential(target, candidates),
		})
		return internalHttpJsonResponse({ error: "Not Found" }, 404)
	}

	/** @param {{ op: string, sessionId?: string, patch?: any, scope?: any, request?: any, workerContext?: any, update?: any, source?: any }} request */
	async handleCodeModeApiRequest(request) {
		const id = this.resolveSessionId(request.sessionId)
		if (request.op === "session.get") {
			const info = await this.sessionInfo(id)
			if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
			return info
		}
		if (request.op === "session.set") {
			this.assertCodeModeScopeCurrent(request.scope, id)
			if (id !== this.sessionId) throw new Error("session.set can currently only update the active session")
			let patch = request.patch
			if (request.patch?.overview) {
				patch = {}
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "state")) patch.state = request.patch.overview.state
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "description")) patch.descriptionInUi = request.patch.overview.description
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "projectTag")) patch.projectTag = request.patch.overview.projectTag
				if (Object.prototype.hasOwnProperty.call(request.patch.overview, "projectDir")) patch.projectDir = request.patch.overview.projectDir
			}
			const write = await this.appendSessionPropertyPatch(patch, request.source ?? { kind: "api" })
			await this.invalidateSnapshot(this.sessionId)
			const info = await this.sessionInfo(id)
			if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
			return { ...info, write }
		}
		if (request.op === "plan.update") {
			const update = normalizePlanUpdateEntryData({
				...request.update,
				source: request.source,
				runId: this.currentRunId,
				recordedAt: new Date().toISOString(),
			})
			const entryId = await this.session.appendCustomEntry(PLAN_UPDATE_CUSTOM_TYPE, update)
			const message = { ...planUpdateDisplayMessage(update), entryId }
			this.emitRuntimeEvent({ type: "plan_update", entryId, message })
			return { entryId }
		}
		if (request.op === "subsession.spawn") {
			return this.subSessions.spawn(this.sessionId, request)
		}
		if (request.op === "subsession.list") {
			return { agents: await this.subSessions.list(this.sessionId, request) }
		}
		if (request.op === "subsession.wait") {
			return this.subSessions.wait(this.sessionId, request)
		}
		if (request.op === "subsession.followup") {
			return this.subSessions.followup(this.sessionId, request)
		}
		if (request.op === "subsession.resume") {
			return this.subSessions.resume(this.sessionId, request)
		}
		if (request.op === "subsession.close") {
			return this.subSessions.close(this.sessionId, request)
		}
		if (request.op === "internalHttp") return this.handleInternalHttpRequest(request.request ?? {}, request.workerContext)
		throw new Error(`Unknown Cerex JS API operation: ${request.op}`)
	}

	/** @param {any} event */
	emitRuntimeEvent(event) {
		const runtimeEvent = {
			...event,
			sessionId: this.sessionId,
			runId: this.currentRunId,
			...(this.cursorGeneration ? { cursorGeneration: this.cursorGeneration } : {}),
			seq: this.nextEventSeqValue(),
			viewEpoch: this.getViewEpoch(),
		}
		this.emit(runtimeEvent)
		const activity = sessionActivityFromRuntimeEvent(runtimeEvent)
		if (activity) this.emit(activity)
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
			this.automatedMaintenanceKind = undefined
			this.visibleMaintenanceToolCallIds = new Set()
		}
		if (event.type === "message_start" && event.message?.role === "user") {
			this.automatedMaintenanceTurnActive = isAutomatedMaintenanceMessage(event.message)
			this.automatedMaintenanceKind = this.automatedMaintenanceTurnActive ? event.message.maintenance : undefined
		}
		if (event.message && this.automatedMaintenanceTurnActive) {
			event.message.automated = true
			if (this.automatedMaintenanceKind) event.message.maintenance = this.automatedMaintenanceKind
		}
		if (event.type === "tool_execution_start") {
			if (!this.automatedMaintenanceTurnActive) this.currentRunToolNames.add(event.toolName)
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
					await this.touchSessionActivity(activityAt)
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
				const hasOpenWorktree = sessionOpenGitWorktreeRecords(this.session).length > 0
				const shouldResetState = hasOpenWorktree
					? props.state === SESSION_NEEDS_INPUT_STATE || props.state === SESSION_DEFERRED_STATE || props.state === SESSION_COMPLETED_STATE
					: props.state !== SESSION_DISCUSSING_STATE
				if (shouldResetState) await this.appendSessionPropertyPatch({ state: SESSION_DISCUSSING_STATE }, { kind: "run_reset", runId: this.currentRunId })
				else await this.refreshSessionPropertyCache({ source: { kind: "run_reset", runId: this.currentRunId } })
			}
		}
		if (event.type === "agent_end") {
			this.activeToolCalls.clear()
			const endTouch = this.diagnostics?.span?.("SessionRuntime.db.touchSession", {
				sessionId: this.sessionId,
				eventType: "agent_end",
			})
			try {
				await this.touchSessionActivity()
			} finally {
				endTouch?.()
			}
			await this.finishRunFromAgentEnd(event)
			await this.refreshSessionPropertyCache({ source: { kind: "agent_end" } })
		}
		if (!event.message) {
			if (!(this.automatedMaintenanceTurnActive && event.type?.startsWith?.("tool_execution_"))) this.emitRuntimeEvent(emitEvent)
		} else {
			const visible = projectVisibleMessage(emitEvent.message, this.visibleProjectionOptions({ retainedMaintenanceToolCallIds: this.visibleMaintenanceToolCallIds }))
			if (visible) this.emitRuntimeEvent({ ...emitEvent, message: visible })
		}
		if (event.type === "message_end" && event.message?.role === "assistant") this.streamingAssistantMessageId = null
		if (event.type === "tool_execution_end" && sessionOpenGitWorktreeRecords(this.session).length > 0) {
			this.refreshWorktrees?.(this.sessionId, { force: true, reason: "tool_execution_end" })
		}
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
		if (!automatedMaintenanceExchangeActive(ctx?.context?.messages ?? [])) return undefined
		const ref = this.agent.state.model?.maintenanceModelRef
		if (!ref) return undefined
		return resolveModel(ref, { providers: this.getSettings?.()?.providers })
	}

	async automatedMaintenancePreTurn(ctx) {
		if (this.isProjectMaintenanceSession()) return []
		if (this.agent.state.model?.provider === "mock") return []
		if (ctx.newMessages?.some(isAutomatedMaintenanceMessage)) return []
		if (!sessionMaintenanceToolAvailable(this.agent.state.tools)) return []
		const props = this.effectiveSessionProperties()
		const project = await this.workspace.project.info(projectCwdForSnapshot(this.session, props, this.cwd)).catch(() => undefined)
		const missingRequiredUi = !props.descriptionInUi
		const missingProjectMetadata = project?.missingProjectMetadata === true
		if (!missingRequiredUi && !missingProjectMetadata) return []
		return [asPreTurnMaintenanceMessage(createMaintenancePromptMessage(props, project))]
	}

	preTurnSessionPropertiesMaxToolCalls(ctx) {
		return preTurnSessionPropertiesMaintenanceActive(ctx?.context?.messages ?? [])
			? PRE_TURN_SESSION_PROPERTIES_MAX_TOOL_CALLS
			: undefined
	}

	projectMessagesForNextAction(ctx) {
		if (ctx.message?.role !== "assistant" || !ctx.message?.automated) return undefined
		const activeMaintenance = activeAutomatedMaintenanceUser(ctx.context?.messages ?? [])
		if (activeMaintenance?.maintenancePlacement !== PRE_TURN_MAINTENANCE_PLACEMENT) return undefined
		this.automatedMaintenanceTurnActive = false
		this.automatedMaintenanceKind = undefined
		return projectAutomatedMaintenanceMessages(ctx.context.messages)
	}

	async automatedMaintenanceFollowUp(ctx) {
		if (this.isProjectMaintenanceSession()) return []
		if (this.agent.state.model?.provider === "mock") return []
		if (ctx.message?.automated || ctx.message?.maintenance) return []
		const blocks = Array.isArray(ctx.message?.content) ? ctx.message.content : []
		if (blocks.some((block) => block?.type === "toolCall")) return []
		if (!sessionMaintenanceToolAvailable(this.agent.state.tools)) return []
		const props = this.effectiveSessionProperties()
		const usedMeaningfulTool = this.currentRunToolNames.size > 0
		const hadPreTurnMaintenance = ctx.newMessages?.some((message) => message?.maintenancePlacement === PRE_TURN_MAINTENANCE_PLACEMENT)
		const openWorktreeRecords = sessionOpenGitWorktreeRecords(this.session)
		if (openWorktreeRecords.length > 0 && (usedMeaningfulTool || props.state === SESSION_DISCUSSING_STATE)) {
			const worktrees = await sessionGitWorktreeStatuses(this.session, { workspace: this.workspace }).catch(() => [])
			const openWorktrees = worktrees.filter((worktree) => !worktree?.removed)
			return [createWorktreeLifecyclePromptMessage(props, {
				activeWorktree: activeWorktreeStatusForCwd(props.cwd ?? this.cwd, openWorktrees),
				openWorktrees,
			})]
		}
		const project = await this.workspace.project.info(projectCwdForSnapshot(this.session, props, this.cwd)).catch(() => undefined)
		const missingRequiredUi = !props.descriptionInUi
		const missingProjectMetadata = project?.missingProjectMetadata === true
		if (hadPreTurnMaintenance && !usedMeaningfulTool) return []
		if (!missingRequiredUi && !missingProjectMetadata && !usedMeaningfulTool) return []
		return [createMaintenancePromptMessage(props, project)]
	}

	async handleCompaction(message) {
		this.touch()
		if (!visibleMessage(message)) return
		this.bumpViewEpoch()
		this.emitRuntimeEvent({ type: "compaction", message })
		await this.invalidateSnapshot(this.sessionId)
	}

	async finishRunFromAgentEnd(event) {
		this.clearSkillsContext()
		const runId = this.currentRunId
		if (!runId || this.finishedRunIds.has(runId)) return
		const messages = Array.isArray(event.messages) ? event.messages : []
		const lastMessage = messages[messages.length - 1]
		const finalMessage = [...messages].reverse().find((message) => !message?.automated && !message?.maintenance) ?? lastMessage
		if (lastMessage?.automated && lastMessage?.errorMessage) this.agent.state.errorMessage = undefined
		const stopReason = event.interrupted ? "interrupted" : finalMessage?.stopReason
		const errorMessage = finalMessage?.errorMessage
		const status = event.interrupted ? "interrupted" : stopReason === "aborted" ? "aborted" : errorMessage ? "failed" : "completed"
		await this.db.finishRun(runId, { status, error: errorMessage, stopReason })
		this.finishedRunIds.add(runId)
		this.currentRunId = null
		this.session.clearMutationRunId(runId)
	}

	async finishRunFromFailure(runId, err) {
		if (this.finishedRunIds.has(runId)) return
		if (this.currentRunId === runId) this.clearSkillsContext()
		await this.db.finishRun(runId, {
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

	needsInput() {
		return this.runtimeNeedsInput
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
				const message = projectVisibleMessage(item.message, this.visibleProjectionOptions())
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
		const withSkills = prependSkillsContext(this.currentSkillsContext, contextMessages)
		return prependEnvironmentContext(this.environmentContext(), withSkills)
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
		return sessionGitWorktreeStatuses(this.session, { workspace: this.workspace })
	}

	async snapshot(options = {}) {
		this.touch()
		// Agent state changes before its listener persists and publishes the corresponding runtime event. Wait only for projections already in flight, then capture cursor-bound runtime state before any external await can pair an old cursor with a newer transcript.
		await Promise.resolve()
		await this.waitForPendingProjections()
		const properties = this.effectiveSessionProperties()
		const requestedProjectCwd = projectCwdForSnapshot(this.session, properties, this.cwd)
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
			visibleDisplayEntries = projectVisibleEntries(displayEntries, this.visibleProjectionOptions())
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
		const cursor = this.snapshotCursor()
		const viewLeafId = this.session.getLeafId()
		const model = this.agent.state.model
		const thinkingLevel = this.agent.state.thinkingLevel
		const serviceTier = this.agent.state.serviceTier
		const systemPrompt = this.agent.state.systemPrompt
		const tools = this.agent.state.tools
		const isStreaming = this.agent.state.isStreaming
		const currentModelRequest = this.agent.state.currentModelRequest
		const pendingToolCalls = [...this.agent.state.pendingToolCalls]
		const pendingToolCallDetails = [...this.activeToolCalls.values()]
		const pendingUserMessages = this.pendingUserMessages()
		const errorMessage = this.agent.state.errorMessage
		const streamingMessage = projectVisibleMessage(this.agent.state.streamingMessage, this.visibleProjectionOptions())
		const streamingAssistantMessageId = this.streamingAssistantMessageId
		const promptDraft = await this.db.getPromptDraft(this.sessionId)
		const messages = visibleDisplayEntries.map((entry) => ({
			...(options.transcriptMode === "deferred" ? transcriptManifestMessage(entry.message) : entry.message),
			entryId: entry.entryId,
		}))
		const snapshotContextMessages = options.includeContextMessages
			? contextMessages.map((message) => ({ ...message, entryId: message.entryId ?? "context" }))
			: undefined
		endPayload?.({ messages: messages.length, contextMessages: contextStats.messageCount, includeContextMessages: options.includeContextMessages === true })
		const [project, subSessions] = await Promise.all([
			this.workspace.project.info(requestedProjectCwd),
			this.subSessions.list(this.sessionId, { includeClosed: true }),
		])
		const snapshot = {
			cwd: properties.cwd ?? this.cwd,
			project,
			sessionId: this.sessionId,
			sessionWorkspacePath: sessionWorkspacePath(this.sessionId),
			...cursor,
			viewLeafId,
			model,
			thinkingLevel,
			serviceTier,
			systemPrompt,
			tools,
			modelIoLogEnabled: isModelIoLogEnabled(),
			isStreaming,
			currentModelRequest,
			pendingToolCalls,
			pendingToolCallDetails,
			pendingUserMessages,
			errorMessage,
			agentView: sessionPropertiesToAgentView(properties),
			sessionProperties: properties,
			promptDraft,
			subSessions,
			messages,
			contextStats,
			streamingMessage: streamingMessage
				? { ...streamingMessage, messageId: streamingAssistantMessageId }
				: null,
		}
		if (snapshotContextMessages) snapshot.contextMessages = snapshotContextMessages
		if (options.includeSessions) snapshot.sessions = await this.sessions()
		return snapshot
	}

	snapshotCursor() {
		return {
			...(this.cursorGeneration ? { cursorGeneration: this.cursorGeneration } : {}),
			seq: this.getEventSeq(),
			viewEpoch: this.getViewEpoch(),
		}
	}

	statusCursor() {
		const currentModelRequest = this.agent.state.currentModelRequest
		return {
			sessionId: this.sessionId,
			...this.snapshotCursor(),
			isStreaming: this.agent.state.isStreaming === true,
			runtimeNeedsInput: this.runtimeNeedsInput,
			...(currentModelRequest?.startedAt ? { currentModelRequest: { startedAt: currentModelRequest.startedAt } } : {}),
			pendingToolCallCount: this.agent.state.pendingToolCalls?.size ?? this.agent.state.pendingToolCalls?.length ?? 0,
		}
	}

	async startRunRecord() {
		const runId = randomUUID()
		await this.db.startRun({
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
		return modelRetryDelayMs(attempt)
	}

	modelRetryNow() {
		return Date.now()
	}

	lastAssistantMessage() {
		const messages = this.agent.state.messages
		const last = messages[messages.length - 1]
		return last?.role === "assistant" ? last : undefined
	}

	async recoverUnknownToolExecutionFailure(failed, retry = {}) {
		if (!failed || failed.stopReason !== "error") return false
		if (startedToolsWithoutDurableResult(this.session).length === 0) return false
		if (this.disposed || this.agent.state.isStreaming || this.lastAssistantMessage() !== failed) return true

		const attempt = retry.unknownToolRecoveryAttempt ?? 0
		const maxAttempts = retry.maxUnknownToolRecoveryAttempts ?? UNKNOWN_TOOL_RECOVERY_MAX_ATTEMPTS
		if (attempt >= maxAttempts) {
			this.emitRuntimeEvent({
				type: "unknown_tool_recovery_exhausted",
				attempt,
				maxAttempts,
				error: failed.errorMessage,
			})
			return true
		}

		this.emitRuntimeEvent({
			type: "unknown_tool_recovery_scheduled",
			attempt: attempt + 1,
			maxAttempts,
			error: failed.errorMessage,
		})
		try {
			await this.continueRun({
				waitForCompletion: true,
				retry: recoveryContinuationOptions(retry, {
					unknownToolRecoveryAttempt: attempt + 1,
					maxUnknownToolRecoveryAttempts: maxAttempts,
				}),
			})
		} catch (err) {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		}
		return true
	}

	async retryModelFailure(failed, retry = {}) {
		if (!failed || failed.stopReason !== "error" || !messageHasRetryableModelError(failed)) return false
		if (this.disposed || this.agent.state.isStreaming || this.lastAssistantMessage() !== failed) return true

		const plan = createModelRetryPlan(retry, {
			nowMs: this.modelRetryNow(),
			delayForAttempt: (attempt) => this.modelRetryDelay(attempt),
		})
		if (!plan.shouldRetry) {
			this.emitRuntimeEvent({
				type: "model_retry_exhausted",
				attempt: plan.attempt,
				maxAttempts: plan.maxAttempts,
				retryStartedAtMs: plan.startedAtMs,
				retryDeadlineAtMs: plan.deadlineAtMs,
				retryElapsedMs: plan.elapsedMs,
				retryWindowMs: plan.maxElapsedMs,
				retryExhaustedReason: plan.reason,
				error: failed.errorMessage,
			})
			return true
		}

		this.pendingModelRetryCount += 1
		try {
			this.emitRuntimeEvent({
				type: "model_retry_scheduled",
				attempt: plan.nextAttempt,
				maxAttempts: plan.maxAttempts,
				delayMs: plan.delayMs,
				retryStartedAtMs: plan.startedAtMs,
				retryDeadlineAtMs: plan.deadlineAtMs,
				retryElapsedMs: plan.elapsedMs,
				retryRemainingMs: plan.remainingMs,
				retryWindowMs: plan.maxElapsedMs,
				error: failed.errorMessage,
			})
			await sleep(plan.delayMs)
		} finally {
			this.pendingModelRetryCount = Math.max(0, this.pendingModelRetryCount - 1)
		}
		if (this.disposed || this.agent.state.isStreaming || this.lastAssistantMessage() !== failed) return true

		try {
			await this.continueRun({
				waitForCompletion: true,
				retry: recoveryContinuationOptions(retry, plan.nextRetry),
			})
		} catch (err) {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		}
		return true
	}

	async monitorRunForAutomaticRecovery(run, retry = {}) {
		try {
			await run
		} catch (err) {
			await this.finishRunFromFailure(retry.runId, err)
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
			return
		}

		const failed = this.lastAssistantMessage()
		if (await this.recoverUnknownToolExecutionFailure(failed, retry)) return
		await this.retryModelFailure(failed, retry)
	}

	enqueueTurnStart(operation) {
		const previous = this.turnStartQueue.catch(() => {})
		const current = previous.then(() => {
			if (this.disposed) {
				throw Object.assign(new Error("Session runtime is no longer active. Retry the request to reopen it."), {
					status: 409,
					code: "sessionRuntimeDisposed",
					sessionId: this.sessionId,
				})
			}
			return operation()
		})
		this.turnStartQueue = current.then(() => undefined, () => undefined)
		return current
	}

	async startStreamingPrompt(userMessage, streamingBehavior) {
		const behavior = cleanStreamingBehavior(streamingBehavior) ?? "steer"
		await this.mergeSkillsContextForText(textFromContent(userMessage.content))
		if (!this.agent.state.isStreaming) {
			this.hydrateAgentFromSession()
			return this.startPromptRun(textFromContent(userMessage.content), userMessage)
		}
		this.assignMessageEventId(userMessage)
		const accepted = this.agent.waitForMessagesAccepted([userMessage], this.agent.waitForIdle())
		if (behavior === "steer") this.agent.steer(userMessage)
		else this.agent.followUp(userMessage)
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
		return { accepted, streamingBehavior: behavior }
	}

	async startPromptRun(message, userMessage) {
		await this.replaceSkillsContextForText(message)
		this.currentRunToolNames = new Set()
		const endStartRun = this.diagnostics?.span?.("SessionRuntime.prompt.startRunRecord", { sessionId: this.sessionId })
		let runId
		try {
			runId = await this.startRunRecord()
		} finally {
			endStartRun?.()
		}
		this.currentPrompt = {
			runId,
			text: message,
			preAgentView: await this.db.getAgentViewMetadata(this.sessionId),
			userEntryId: undefined,
		}

		const endStartPrompt = this.diagnostics?.span?.("SessionRuntime.prompt.startPrompt", { sessionId: this.sessionId })
		let accepted
		let run
		try {
			;({ accepted, run } = this.agent.startPrompt(userMessage))
		} catch (err) {
			await this.finishRunFromFailure(runId, err)
			if (this.currentPrompt?.runId === runId) this.currentPrompt = undefined
			throw err
		} finally {
			endStartPrompt?.()
		}
		this.monitorRunForAutomaticRecovery(run, { runId }).catch((err) => {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		})
		return { accepted }
	}

	async beginPrompt(message, streamingBehavior, images = []) {
		const content = await this.materializePromptContent(message, images)
		return this.beginUserMessagePrompt({ role: "user", content, timestamp: Date.now() }, streamingBehavior)
	}

	async beginUserMessagePrompt(userMessage, streamingBehavior) {
		this.touch()
		const behavior = cleanStreamingBehavior(streamingBehavior)
		const message = textFromContent(userMessage.content)
		const normalizedUserMessage = {
			...userMessage,
			role: "user",
			timestamp: userMessage.timestamp ?? Date.now(),
		}
		return await this.enqueueTurnStart(async () => {
			if (this.agent.state.isStreaming) return this.startStreamingPrompt(normalizedUserMessage, behavior)
			await this.agent.waitForIdle()
			if (this.agent.state.isStreaming) return this.startStreamingPrompt(normalizedUserMessage, behavior)
			await this.reconcileProjectLocation()
			this.hydrateAgentFromSession()
			return this.startPromptRun(message, normalizedUserMessage)
		})
	}

	async waitForPromptAccepted(submission) {
		const endAccepted = this.diagnostics?.span?.("SessionRuntime.prompt.awaitAccepted", {
			sessionId: this.sessionId,
			streamingBehavior: submission.streamingBehavior,
		})
		try {
			await submission.accepted
		} finally {
			endAccepted?.()
		}
	}

	observePromptAccepted(submission) {
		this.waitForPromptAccepted(submission).catch((err) => {
			this.emitRuntimeEvent({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
			this.invalidateSnapshot(this.sessionId).catch(() => {})
		})
	}

	async prompt(message, streamingBehavior, images = []) {
		await this.waitForPromptAccepted(await this.beginPrompt(message, streamingBehavior, images))
	}

	async reconcileUnknownToolExecutions() {
		const pending = startedToolsWithoutDurableResult(this.session)
		if (pending.length === 0) return []
		let changed = false
		const latestStartedEntryId = pending[pending.length - 1]?.entryId
		if (latestStartedEntryId && this.session.getLeafId() !== latestStartedEntryId) {
			// Drop any tail produced after the harness lost a tool outcome (usually an
			// error assistant from the crash) and recover from the durable tool-start
			// boundary. Repeating the tool would be unsafe; keeping the failure tail in
			// the model context would put a non-tool message between the assistant tool
			// call and its recovered tool result.
			await this.session.moveTo(latestStartedEntryId)
			changed = true
		}
		const synthesized = await synthesizeUnknownToolResultsForStartedTools(this.session)
		if (synthesized.length > 0) changed = true
		if (changed) {
			this.hydrateAgentFromSession()
			this.bumpViewEpoch()
			await this.touchSessionActivity()
			await this.invalidateSnapshot(this.sessionId)
		}
		return synthesized
	}

	async rewindFailedAssistantTail() {
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
		await this.session.moveTo(parentEntryId)
		this.hydrateAgentFromSession()
		return true
	}

	async prepareContinuationState() {
		await this.reconcileUnknownToolExecutions()
		if (await this.rewindFailedAssistantTail()) {
			this.bumpViewEpoch()
			await this.touchSessionActivity()
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

		await this.reconcileProjectLocation()
		await this.replaceSkillsContextForText(this.latestHumanPromptText())
		this.currentRunToolNames = new Set()
		const runId = await this.startRunRecord()
		let run
		try {
			run = this.agent.continue()
		} catch (err) {
			await this.finishRunFromFailure(runId, err)
			throw err
		}
		const monitored = this.monitorRunForAutomaticRecovery(run, { runId, ...(options.retry ?? {}) })
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

	cancellablePromptTailEntry(prompt) {
		if (assistantMessageHasOutput(this.agent.state.streamingMessage)) return undefined
		if (!prompt?.userEntryId) return undefined
		const branch = this.session.getBranch()
		const promptIndex = branch.findIndex((entry) => entry.id === prompt.userEntryId)
		if (promptIndex < 0) return undefined
		let lastOutputIndex = promptIndex - 1
		for (let i = promptIndex; i < branch.length; i += 1) {
			if (entryIsAgentOutputBoundary(branch[i])) lastOutputIndex = i
		}
		return branch.slice(lastOutputIndex + 1).find((entry) => isHumanUserEntry(entry) && !isProjectContextMessage(entry.message))
	}

	async abort() {
		this.touch()
		this.agent.abort()
		await this.agent.waitForIdle()
		if (this.clearQueuedMessages()) await this.invalidateSnapshot(this.sessionId)
	}

	clearQueuedMessages() {
		const queued = queuedAgentMessages(this.agent)
		if (queued.length === 0 || typeof this.agent.clearAllQueues !== "function") return false
		this.agent.clearAllQueues()
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
		return true
	}

	takeQueuedCancellableUserMessageItems() {
		const queued = typeof this.agent.takeQueuedMessages === "function"
			? this.agent.takeQueuedMessages((item) => isCancellableUserMessage(item.message))
			: queuedAgentMessages(this.agent)
				.filter((item) => isCancellableUserMessage(item?.message ?? item))
				.map(normalizeQueuedMessageItem)
		if (queued.length === 0) return []
		if (typeof this.agent.takeQueuedMessages !== "function") this.agent.clearAllQueues?.()
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
		return queued
	}

	restoreQueuedMessageItems(queuedItems) {
		if (queuedItems.length === 0) return
		if (typeof this.agent.prependQueuedMessages === "function") this.agent.prependQueuedMessages(queuedItems)
		else queuedItems.forEach((item) => item.behavior === "followUp" ? this.agent.followUp(item.message) : this.agent.steer(item.message))
		this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
	}

	async interruptWithoutPromptRestore(reason, queuedItems = this.takeQueuedCancellableUserMessageItems()) {
		const queuedMessages = queuedItems.map((item) => item.message)
		let clearedQueuedMessages = false
		if (this.agent.state.isStreaming) {
			this.agent.abort()
			await this.agent.waitForIdle()
			clearedQueuedMessages = this.clearQueuedMessages()
		}
		if (queuedMessages.length > 0 || clearedQueuedMessages) await this.invalidateSnapshot(this.sessionId)
		return {
			ok: true,
			cancelled: false,
			reason,
			...(queuedMessages.length > 0 ? { queuedCancelled: true, ...promptDraftResponseFromMessages(queuedMessages) } : {}),
		}
	}

	async cancelCurrentPrompt(options = {}) {
		this.touch()
		const restoreCurrentPrompt = options.restoreCurrentPrompt !== false
		const queuedItems = this.takeQueuedCancellableUserMessageItems()
		const queuedMessages = queuedItems.map((item) => item.message)
		let restoreQueuedOnError = queuedItems.length > 0
		try {
			if (!restoreCurrentPrompt) {
				const response = await this.interruptWithoutPromptRestore("restore_current_prompt_disabled", queuedItems)
				restoreQueuedOnError = false
				return response
			}
			const prompt = this.currentPrompt
			if (!this.agent.state.isStreaming) {
				if (queuedMessages.length > 0) await this.invalidateSnapshot(this.sessionId)
				restoreQueuedOnError = false
				return {
					ok: true,
					cancelled: false,
					reason: "not_streaming",
					...(queuedMessages.length > 0 ? { queuedCancelled: true, ...promptDraftResponseFromMessages(queuedMessages) } : {}),
				}
			}
			if (!prompt) {
				const response = await this.interruptWithoutPromptRestore("no_current_prompt", queuedItems)
				restoreQueuedOnError = false
				return response
			}
			const toolStartedBeforeAbort = this.toolStartedForRun(prompt.runId)
			const cancellableEntry = toolStartedBeforeAbort ? undefined : this.cancellablePromptTailEntry(prompt)
			if (!cancellableEntry) {
				const response = await this.interruptWithoutPromptRestore(toolStartedBeforeAbort ? "tool_started" : "assistant_output_started", queuedItems)
				restoreQueuedOnError = false
				return response
			}
			this.promptCancellation = { runId: prompt.runId, sawToolStart: false }
			try {
				this.agent.abort()
				await this.agent.waitForIdle()
			} finally {
				if (this.promptCancellation?.runId === prompt.runId && (toolStartedBeforeAbort || this.promptCancellation.sawToolStart)) {
					this.promptCancellation = undefined
				}
			}
			const toolStarted = toolStartedBeforeAbort || this.toolStartedForRun(prompt.runId) || this.promptCancellation?.sawToolStart === true
			if (toolStarted) {
				restoreQueuedOnError = false
				return {
					ok: true,
					cancelled: false,
					reason: "tool_started",
					...(queuedMessages.length > 0 ? { queuedCancelled: true, ...promptDraftResponseFromMessages(queuedMessages) } : {}),
				}
			}

			const entry = this.session.getEntry(cancellableEntry.id)
			if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
				if (this.promptCancellation?.runId === prompt.runId) this.promptCancellation = undefined
				restoreQueuedOnError = false
				return {
					ok: true,
					cancelled: false,
					reason: "prompt_entry_not_found",
					...(queuedMessages.length > 0 ? { queuedCancelled: true, ...promptDraftResponseFromMessages(queuedMessages) } : {}),
				}
			}

			const draftMessages = [
				...cancellableBranchUserMessages(this.session, entry),
				...queuedMessages,
			]
			await this.session.moveTo(entry.parentId ?? null, { runId: prompt.runId })
			this.hydrateAgentFromSession()
			this.agent.clearAllQueues?.()
			this.agent.state.errorMessage = undefined
			await this.refreshSessionPropertyCache({ source: { kind: "cancel_prompt" } })
			await this.db.finishRun(prompt.runId, { status: "completed", stopReason: "cancelled" })
			this.finishedRunIds.add(prompt.runId)
			if (this.currentRunId === prompt.runId) this.currentRunId = null
			this.session.clearMutationRunId(prompt.runId)
			this.currentPrompt = undefined
			this.streamingAssistantMessageId = null
			if (this.promptCancellation?.runId === prompt.runId) this.promptCancellation = undefined
			this.bumpViewEpoch()
			await this.touchSessionActivity()
			this.emitRuntimeEvent({ type: "pending_user_messages_update", pendingUserMessages: this.pendingUserMessages() })
			await this.invalidateSnapshot(this.sessionId)
			restoreQueuedOnError = false
			return {
				ok: true,
				cancelled: true,
				...(queuedMessages.length > 0 ? { queuedCancelled: true } : {}),
				...promptDraftResponseFromMessages(draftMessages),
			}
		} catch (err) {
			if (restoreQueuedOnError) {
				this.restoreQueuedMessageItems(queuedItems)
				await this.invalidateSnapshot(this.sessionId).catch(() => {})
			}
			throw err
		}
	}

	softInterrupt() {
		this.touch()
		return this.agent.softInterrupt()
	}

	async waitForIdle() {
		await this.agent.waitForIdle()
	}

	hasBackgroundWork() {
		return this.pendingModelRetryCount > 0 || this.agent.hasBackgroundWork?.() === true || this.agent.toolExecutor?.hasBackgroundWork?.() === true
	}

	async waitForBackgroundWork() {}

	pruneIdleResources(now = Date.now()) {
		const executor = this.agent.toolExecutor
		if (!executor || typeof executor.pruneIdleWorkers !== "function") return
		executor.pruneIdleWorkers(now).catch((err) => {
			process.stderr.write(`[session-runtime:${this.sessionId}] idle worker prune failed: ${err?.stack ?? err}\n`)
		})
	}

	rewindTargets() {
		this.touch()
		return buildRewindTargets(this.session)
	}

	assertCanNavigateBranch(action, streamingMessage) {
		if (this.agent.state.isStreaming) throw Object.assign(new Error(streamingMessage), { status: 409 })
		const queued = queuedAgentMessages(this.agent)
		if (queued.length === 0) return
		const subject = queued.length === 1 ? "a queued message is" : `${queued.length} queued messages are`
		const object = queued.length === 1 ? "it" : "them"
		throw Object.assign(new Error(`Cannot ${action} while ${subject} pending. Let ${object} be accepted or abort the turn before changing branches.`), { status: 409 })
	}

	async rewind(id, options = {}) {
		this.touch()
		this.assertCanNavigateBranch("rewind", "Abort this session's running turn before rewinding.")
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
		if (options.restoreFiles === true) fileRestoreResult = await restoreFilesToCheckpoint(this.session, id, this.workspace)
		if (restoreConversation) await this.session.moveTo(entry.parentId ?? null)
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
		await this.refreshSessionPropertyCache({ source: { kind: "rewind" } })
		this.hydrateAgentFromSession()
		this.bumpViewEpoch()
		await this.touchSessionActivity()
		await this.invalidateSnapshot(this.sessionId)
		return editorText
	}

	async setFastMode(args) {
		this.touch()
		return handleFastCommand(this.agent, this.session, args)
	}

	async setModel(nextModel) {
		this.touch()
		return await this.enqueueTurnStart(async () => {
			this.assertCanNavigateBranch("change models", "Abort this session's running turn before changing models.")
			const eligibilityError = sessionModelEligibilityError(this.agent.state.model, nextModel)
			if (eligibilityError) throw Object.assign(new Error(eligibilityError), { status: 400 })
			if (modelRef(nextModel) === modelRef(this.agent.state.model) && nextModel.baseUrl === this.agent.state.model.baseUrl) {
				return { changed: false }
			}
			await this.session.appendGlobalConfigPatch({
				modelRef: modelRef(nextModel),
				model: nextModel,
				baseUrl: nextModel.baseUrl,
				toolProfile: nextModel.toolProfile,
			})
			applyAgentModel(this.agent, this.cwd, nextModel)
			await this.invalidateSnapshot(this.sessionId)
			return { changed: true }
		})
	}

	async compact() {
		this.touch()
		if (this.agent.compact) return this.agent.compact()
		return compact(this.agent)
	}

	async switchBranchTip(id) {
		this.touch()
		this.assertCanNavigateBranch("switch branches", "Abort this session's running turn before switching branches.")
		const branchTips = buildBranchTipItems(this.session)
		if (!branchTips.some((tip) => tip.id === id)) throw Object.assign(new Error(`Branch tip not found: ${id}`), { status: 404 })
		let switched = false
		if (id !== this.session.getLeafId()) {
			await this.session.moveTo(id)
			await this.session.appendCustomEntry(SESSION_CUSTOM_TYPE_BRANCH_SWITCH, { targetEntryId: id })
			switched = true
		}
		await this.refreshSessionPropertyCache({ source: { kind: "branch_switch" } })
		this.hydrateAgentFromSession()
		this.bumpViewEpoch()
		await this.touchSessionActivity()
		await this.invalidateSnapshot(this.sessionId)
	}

	dispose() {
		this.disposed = true
		try {
			this.permissionRequests.dispose()
			this.unsubscribe?.()
			this.unsubscribeCompaction?.()
			this.agent.dispose?.()
		} finally {
			closeModelSessionResources(this.sessionId)
		}
	}

	async permissionRequest(toolCallId) {
		this.touch()
		return await this.permissionRequests.describe(toolCallId)
	}

	async resolvePermission(toolCallId, decision, input = undefined) {
		this.touch()
		return await this.permissionRequests.resolve(toolCallId, decision, input)
	}
}
