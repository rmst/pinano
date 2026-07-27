// Manager for live Cerex session runtimes.

import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import { normalizeReasoningLevel } from "../../../../../protocol/src/reasoning.js"
import { pathIsPageDocument } from "../../../../../protocol/src/product.js"
import { ensureProjectContextMessage, isProjectContextMessage } from "../../project/context.js"
import { systemPromptFor } from "../../agent/factory.js"
import { resolveModelWithProviderMetadata } from "../../model/registry.js"
import { assertNoSessionWorkspaceNameCollisions, branchSessionInDb, createSessionIdInDb, createSessionInDb, loadSessionPreviewInDb, openSessionInDb, restoreSessionInDb, sessionPreviewFromMessages } from "../store.js"
import { sessionActivityAt } from "../activity.js"
import { initialSessionEnvironment } from "../../environment/registry.js"
import { PREVIEW_FILE_SUFFIX, PREVIEW_LOG_DIRNAME, PREVIEW_ROOT_KIND_PROJECT, PREVIEW_ROOT_KIND_SOURCE, PREVIEW_ROOT_KIND_STATIC, STATIC_PREVIEW_FILE_SUFFIX, matchPreviewHost, previewFileDefinitionFromPath, previewLogPath, previewPublicUrlFromSettings, previewRoutingSlugFromSettings, projectPreviewDirectory, projectPreviewLogPath, projectPreviewScopeId, readSessionPreviewDefinitions, sessionPreviewScopeId, sourcePreviewScopeId, staticPreviewScopeId } from "../../preview/manifest.js"
import { isStaticPreviewDefinition, processPreviewDefinitions, projectStaticPreviewDefinitions, staticPreviewDefinitionForRecord, staticPreviewDefinitions } from "../../preview/static-definitions.js"
import { sessionWorkspacePath } from "../../paths.js"
import { sessionSandboxBaseWd, sessionSandboxMounts } from "../config.js"
import { branchNoticeMessage, branchSessionWorkspace } from "../workspaces.js"
import { pathIsWithin } from "../../sandbox/paths.js"
import { createLocalWorkspaceHost } from "../../workspace/local-host.js"
import { runNeedsAcknowledgement } from "../../overview/run-acknowledgement.js"
import { projectDocumentsDirectory } from "../../project/documents.js"
import { WEB_BROWSER_UI_NAME } from "../../../../../protocol/src/web-branding.js"
import {
	SUB_SESSION_MAX_DEPTH,
	SUB_SESSION_MAX_OPEN_PER_ROOT,
	defaultSubSessionName,
	normalizeSubSessionForkTurns,
	normalizeSubSessionName,
	subSessionConfig,
	subSessionOpenCommand,
	subSessionStatus,
} from "../sub-sessions.js"
import { GIT_WORKTREE_CUSTOM_TYPE, cleanupSessionGitWorktrees, gitWorktreeRecordsFromEntries, resetInheritedSessionGitWorktrees, sessionGitWorktreeStatuses } from "../../source-control/worktree-events.js"
import {
	SESSION_COMPLETED_STATE,
	SESSION_DEFERRED_STATE,
	SESSION_DISCUSSING_STATE,
	getEffectiveSessionProperties,
	isHumanUserEntry,
	sessionPropertiesToAgentView,
} from "../properties.js"
import {
	filterSessionCollectionRows,
	formatSessionCollectionRows,
	formatTranscriptEntries,
} from "./transcript-projection.js"
import { promptDraftFromMessages } from "./prompt-drafts.js"
import {
	PROJECT_SETUP_MAINTENANCE_KIND,
	ensureProjectPreviewsDirectory,
	projectMaintenanceEligible,
	projectMaintenanceNoticeMessage,
	projectMaintenancePrompt,
	projectMaintenanceSetupStatus,
	projectSetupMaintenanceActive,
	sessionPreviewsDirectoryExists,
	shouldAutoRegisterProjectRoot,
} from "./maintenance.js"
import {
	MAX_PREVIEW_UI_FILE_BYTES,
	longestContainingRoot,
	previewItemFromDefinition,
	previewItemFromTarget,
	previewSourcePath,
	readTextFileTail,
	urlPort,
} from "./preview-resolution.js"
export {
	filterSessionCollectionRows,
	formatSessionCollectionRows,
	formatTranscriptEntries,
	imageBlocksFromContent,
	projectVisibleEntries,
	projectVisibleMessage,
	sessionCollectionState,
	textFromContent,
	visibleMessage,
	visibleMessages,
} from "./transcript-projection.js"
export { buildBranchTipItems, buildRewindTargets, entryMessageText } from "./branch-navigation.js"
/** @typedef {import("../../agent/runtime.js").AgentRuntime} Agent */
/** @typedef {import("../../../session-manager/index.js").Session} Session */
/** @typedef {import("../../database/index.js").ServerDb} ServerDb */

import { SessionRuntime } from "./session-runtime.js"
import {
	DEFAULT_IDLE_TTL_MS,
	DEFAULT_MAX_IDLE_RUNTIMES,
	DEFAULT_WORKTREE_STATUS_RUNNING_TTL_MS,
	DEFAULT_WORKTREE_STATUS_ACTIVE_TTL_MS,
	DEFAULT_WORKTREE_STATUS_DEFERRED_TTL_MS,
	DEFAULT_WORKTREE_STATUS_COMPLETED_TTL_MS,
	DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES,
	PROJECT_MAINTENANCE_SESSION_TITLE,
	isSessionNotFoundError,
	cleanText,
	cleanPromptText,
	subSessionNoticeMessage,
	latestAssistantText,
	firstVisibleUserText,
	olderThanLegacyCompletionWindow,
	needsLegacyAgentViewFallback,
	sleep,
	cloneWorktreeStatuses,
	worktreeStatusCacheHit,
	hasVisibleUserPrompt,
	lifecycleStateForSession,
	fallbackAgentViewState,
	sessionMatchesDirectoryFilter,
	autoResumeCandidate,
	completedLegacyMetadata,
	sessionInfoFromEntry,
	projectCwdForSessionEntry,
	projectCwdForSnapshot,
	sessionWorkspaceProjectDirForCwd,
	cwdIsInsideSessionWorkspacesRoot,
	initialProjectDirForCwd,
	sessionConfigForAgent,
	sessionModelConfigForAgent,
	sessionConfigAt,
	remapSandboxMounts,
	remapProjectDir,
	sessionWorkspacePathMappingsForEnvironment,
	applyAgentModel,
	applySessionConfig,
	applySessionProviderMetadata,
} from "./runtime-helpers.js"

const STATIC_PREVIEW_NOT_CONFIGURED = "CEREX_STATIC_PREVIEW_NOT_CONFIGURED"

export class RuntimeManager {
	/**
	 * @param {object} opts
	 * @param {Session} [opts.session]
	 * @param {string} [opts.sessionId]
	 * @param {string} opts.cwd
	 * @param {(info: { sessionId: string, session: Session, cwd: string, getSettings?: () => any, workspace?: any, previewAccessToken?: string }) => Agent} [opts.createAgent]
	 * @param {() => { model?: string, thinkingLevel?: string, models?: Record<string, any> }} [opts.getSettings]
	 * @param {() => string | undefined} [opts.getPreviewPublicUrl]
	 * @param {number} [opts.idleRuntimeTtlMs]
	 * @param {number} [opts.maxIdleRuntimes]
	 * @param {number} [opts.worktreeStatusRunningTtlMs]
	 * @param {number} [opts.worktreeStatusActiveTtlMs]
	 * @param {number} [opts.worktreeStatusDeferredTtlMs]
	 * @param {number} [opts.worktreeStatusCompletedTtlMs]
	 * @param {number} [opts.worktreeStatusCacheMaxEntries]
	 * @param {boolean} [opts.snapshotIncludesSessions]
	 * @param {string} [opts.workspaceRoot]
	 * @param {import("../../sandbox/workspace-root-policy.js").WorkspaceRootPolicy} [opts.workspacePolicy]
	 * @param {import("../../workspace/client.js").WorkspaceClient} [opts.workspace]
	 * @param {{ root: string | null, configuredRoot: string | null }} [opts.workspaceDescription]
	 * @param {{ span?: (name: string, args?: Record<string, any>) => (extraArgs?: Record<string, any>) => void }} [opts.diagnostics]
	 * @param {ServerDb} db
	 * @param {{ send: (event: any) => void, cursor?: () => { epoch?: string } }} hub
	 */
	constructor(opts, db, hub) {
		this.opts = opts
		this.db = db
		this.hub = hub
		this.cwd = opts.cwd
		this.initialSessionId = opts.sessionId ?? null
		this.disposed = false
		this.idleRuntimeTtlMs = opts.idleRuntimeTtlMs ?? DEFAULT_IDLE_TTL_MS
		this.maxIdleRuntimes = opts.maxIdleRuntimes ?? DEFAULT_MAX_IDLE_RUNTIMES
		this.worktreeStatusCacheOptions = {
			runningTtlMs: opts.worktreeStatusRunningTtlMs ?? DEFAULT_WORKTREE_STATUS_RUNNING_TTL_MS,
			activeTtlMs: opts.worktreeStatusActiveTtlMs ?? DEFAULT_WORKTREE_STATUS_ACTIVE_TTL_MS,
			deferredTtlMs: opts.worktreeStatusDeferredTtlMs ?? DEFAULT_WORKTREE_STATUS_DEFERRED_TTL_MS,
			completedTtlMs: opts.worktreeStatusCompletedTtlMs ?? DEFAULT_WORKTREE_STATUS_COMPLETED_TTL_MS,
			maxEntries: opts.worktreeStatusCacheMaxEntries ?? DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES,
		}
		this.snapshotOptions = opts.snapshotIncludesSessions ? { includeSessions: true } : {}
		this.cursorGeneration = hub.cursor?.().epoch
		this.diagnostics = opts.diagnostics
		this.workspace = opts.workspace
		this.workspaceDescription = opts.workspaceDescription ?? opts.workspace?.description ?? { root: null, configuredRoot: null }
		this.workspaceRoot = this.workspaceDescription.root ?? undefined
		/** @type {Map<string, SessionRuntime>} */
		this.runtimes = new Map()
		/** @type {Map<string, { mutationVersion: number, loadedAt: number, statuses: any[] }>} */
		this.worktreeStatusCache = new Map()
		/** @type {Map<string, { mutationVersion: number, promise: Promise<any[]> }>} */
		this.worktreeStatusLoads = new Map()
		/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, force: boolean, reason?: string }>} */
		this.worktreeStatusRefreshTimers = new Map()
		/** @type {Map<string, Promise<void>>} */
		this.completedWorktreeCleanupTasks = new Map()
		/** @type {Map<string, Promise<void>>} */
		this.projectMaintenanceCompletionTasks = new Map()
		/** @type {Map<string, number>} */
		this.eventSeqs = new Map()
		/** @type {Map<string, number>} */
		this.viewEpochs = new Map()
		this.createAgent = opts.createAgent ?? (() => {
			throw new Error("server runtime needs createAgent to open live sessions")
		})
	}

	static async create(opts, db, hub) {
		const workspaceHost = opts.workspace ? undefined : await createLocalWorkspaceHost({
			workspaceRoot: opts.workspaceRoot,
			workspacePolicy: opts.workspacePolicy,
		})
		const workspace = opts.workspace ?? workspaceHost.client
		const workspaceDescription = await workspace.describe()
		const cwd = await workspace.paths.normalizeUserCwd(opts.cwd, "service startup cwd")
		assertNoSessionWorkspaceNameCollisions(db)
		const manager = new RuntimeManager({ ...opts, cwd, workspace, workspaceDescription }, db, hub)
		if (opts.session && opts.sessionId) {
			manager.upsertSession(opts.session, opts.sessionId)
			await manager.createRuntime(opts.session, opts.sessionId)
		}
		manager.applyLegacyAgentViewFallbacks().catch(() => {})
		return manager
	}

	projectInfo(cwd) {
		return this.workspace.project.info(cwd)
	}

	upsertSession(session, id) {
		const meta = session.getMetadata()
		const initialWd = session.getSessionConfig?.().initialWd
		this.db.upsertSession({
			id,
			cwd: meta.cwd ?? this.cwd,
			...(typeof initialWd === "string" && initialWd ? { initialWd } : {}),
			createdAt: meta.createdAt,
			updatedAt: sessionActivityAt(session),
		})
	}

	async createSessionId() {
		return createSessionIdInDb(this.db)
	}

	async createStoredSession(cwd) {
		return createSessionInDb(this.db, cwd, { diagnostics: this.diagnostics })
	}

	async branchStoredSession(sourceId, options = {}) {
		return branchSessionInDb(this.db, sourceId, options, { diagnostics: this.diagnostics })
	}

	loadSessionPreview(id) {
		return loadSessionPreviewInDb(this.db, id)
	}

	openStoredSession(id) {
		return openSessionInDb(this.db, id, { diagnostics: this.diagnostics })
	}

	rethrowSessionNotFound(id, err, options = {}) {
		if (!isSessionNotFoundError(err)) throw err
		this.db.markSessionDeleted(id)
		if (options.clearWorktreeStatus === true) this.worktreeStatusCache.delete(id)
		this.hub.send({ type: "session_list_changed", sessionId: id })
		throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
	}

	async normalizeUserCwd(cwd, label = "cwd") {
		return this.workspace.paths.normalizeUserCwd(cwd, label)
	}

	async normalizeStoredCwd(cwd, label = "cwd") {
		return this.workspace.paths.normalizeStoredCwd(cwd, label)
	}

	async normalizeOptionalUserCwd(cwd, label = "cwd") {
		if (cwd === undefined || cwd === null || cwd === "") return undefined
		return this.normalizeUserCwd(cwd, label)
	}

	async storedCwdAllowed(cwd) {
		if (!cwd) return true
		return await this.workspace.paths.allowsStoredCwd(cwd)
	}

	async assertStoredCwdAllowed(cwd, label = "session cwd") {
		if (await this.storedCwdAllowed(cwd)) return
		throw Object.assign(new Error(`${label} is outside configured service.workspaceRoot (${this.workspaceRoot}): ${cwd}`), { status: 403 })
	}

	async assertSessionEntryAllowed(entry) {
		await this.assertStoredCwdAllowed(entry?.cwd, "session cwd")
		await this.assertStoredCwdAllowed(projectCwdForSessionEntry(entry), "session project cwd")
	}

	async assertOpenedSessionAllowed(session, fallbackCwd) {
		const metaCwd = session?.getMetadata?.()?.cwd ?? fallbackCwd
		await this.assertStoredCwdAllowed(metaCwd, "session cwd")
		const properties = getEffectiveSessionProperties(session)
		await this.assertStoredCwdAllowed(projectCwdForSnapshot(session, properties, metaCwd), "session project cwd")
		await this.assertStoredCwdAllowed(properties.cwd, "session cwd")
	}

	async workspaceAllowedSessionEntries(entries) {
		const checks = await Promise.all(entries.map(async (entry) =>
			await this.storedCwdAllowed(entry?.cwd)
			&& await this.storedCwdAllowed(projectCwdForSessionEntry(entry))
		))
		return entries.filter((_, index) => checks[index])
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
		await this.assertOpenedSessionAllowed(session, cwd)
		const agent = this.createAgent({ sessionId: id, session, cwd, getSettings: this.opts.getSettings, workspace: this.workspace })
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
			refreshWorktrees: (sessionId, options) => this.scheduleWorktreeStatusRefresh(sessionId, options),
			registerProjectRoot: (projectDir, options) => this.registerProjectRoot(projectDir, options),
			cursorGeneration: this.cursorGeneration,
			nextEventSeq: () => this.nextEventSeq(id),
			getEventSeq: () => this.getEventSeq(id),
			getViewEpoch: () => this.getViewEpoch(id),
			bumpViewEpoch: () => this.bumpViewEpoch(id),
			getSettings: this.opts.getSettings,
			getPreviewPublicUrl: this.opts.getPreviewPublicUrl,
			workspace: this.workspace,
			workspaceRoot: this.workspaceRoot,
			subSessions: {
				spawn: (parentSessionId, request) => this.spawnSubSession(parentSessionId, request),
				list: (parentSessionId, request) => this.listSubSessions(parentSessionId, request),
				wait: (parentSessionId, request) => this.waitSubSession(parentSessionId, request),
				followup: (parentSessionId, request) => this.followupSubSession(parentSessionId, request),
				resume: (parentSessionId, request) => this.resumeSubSession(parentSessionId, request),
				close: (parentSessionId, request) => this.closeSubSession(parentSessionId, request),
			},
			sessionBridge: {
				get: (sessionId) => this.bridgeSessionInfo(sessionId),
				set: (sessionId, patch, source) => this.bridgeSessionSet(sessionId, patch, source),
				cat: (sessionId, options) => this.bridgeSessionCat(sessionId, options),
				list: (filters) => this.bridgeSessionsList(filters),
				projectGet: (sessionId) => this.bridgeProjectInfo(sessionId),
				projectSet: (sessionId, name) => this.bridgeProjectSet(sessionId, name),
				previewList: (sessionId) => this.bridgePreviewList(sessionId),
			},
			diagnostics: this.diagnostics,
		})
		await applySessionProviderMetadata(agent, session, cwd, this.opts.getSettings?.())
		this.runtimes.set(id, runtime)
		runtime.refreshSessionPropertyCache({ source: { kind: "runtime_create" } })
		this.pruneIdleRuntimes()
		return runtime
	}

	async appendRuntimeMessage(runtime, message) {
		const entryId = await runtime.session.appendMessage(message)
		runtime.agent.state.messages.push(message)
		runtime.agent.msgToEntryId.set(message, entryId)
		return entryId
	}

	async openManagedSession(plan) {
		if (plan.open?.kind === "create") return this.createStoredSession(plan.open.cwd)
		if (plan.open?.kind === "branch") {
			return this.branchStoredSession(plan.open.sourceSessionId, {
				cwd: plan.open.cwd,
				sessionId: plan.open.sessionId,
				...(plan.open.sourceEntryId !== undefined ? { sourceEntryId: plan.open.sourceEntryId } : {}),
			})
		}
		throw new Error("managed session launch requires an open plan")
	}

	async submitManagedSessionPrompt(runtime, prompt) {
		if (prompt.kind === "message") {
			const submission = await runtime.beginUserMessagePrompt(prompt.message, prompt.streamingBehavior)
			if (prompt.waitForAccepted === false) runtime.observePromptAccepted(submission)
			else await runtime.waitForPromptAccepted(submission)
			return submission
		}
		if (prompt.kind === "text") {
			const submission = await runtime.beginPrompt(prompt.text, prompt.streamingBehavior, prompt.images ?? [])
			if (prompt.waitForAccepted === false) runtime.observePromptAccepted(submission)
			else await runtime.waitForPromptAccepted(submission)
			return submission
		}
		throw new Error("managed session launch prompt must be text or message")
	}

	// Centralizes the order-sensitive mechanics shared by project maintenance sessions and hidden sub-sessions while keeping policy-specific registration and config in the caller.
	async launchManagedSession(plan) {
		const opened = await this.openManagedSession(plan)
		if (plan.contextMessageCwd && this.opts.noContextFiles !== true) await ensureProjectContextMessage(opened.session, plan.contextMessageCwd, this.workspace)
		this.upsertSession(opened.session, opened.id)

		let registration = await plan.beforeRuntime?.({ opened })
		const runtime = await this.createRuntime(opened.session, opened.id)
		let context = { opened, runtime, registration }

		const beforeConfigRegistration = await plan.beforeConfig?.(context)
		if (beforeConfigRegistration !== undefined) {
			registration = beforeConfigRegistration
			context = { opened, runtime, registration }
		}

		const configPatch = typeof plan.config === "function" ? await plan.config(context) : plan.config
		if (configPatch) await opened.session.appendConfigPatch(configPatch)
		await plan.afterConfig?.(context)

		const properties = typeof plan.properties === "function" ? await plan.properties(context) : plan.properties
		if (properties?.patch) await runtime.appendSessionPropertyPatch(properties.patch, properties.source, properties.options)

		const notices = typeof plan.notices === "function" ? await plan.notices(context) : plan.notices
		for (const notice of notices ?? []) {
			if (notice) await this.appendRuntimeMessage(runtime, notice)
		}

		let promptError
		const initialPrompt = typeof plan.initialPrompt === "function" ? await plan.initialPrompt(context) : plan.initialPrompt
		if (initialPrompt) {
			try {
				await this.submitManagedSessionPrompt(runtime, initialPrompt)
			} catch (err) {
				promptError = /** @type {any} */ (err)?.message ?? String(err)
				if (initialPrompt.bestEffort !== true) throw err
			}
		}

		const invalidateSessionIds = typeof plan.invalidateSessionIds === "function" ? await plan.invalidateSessionIds(context) : plan.invalidateSessionIds
		for (const sessionId of invalidateSessionIds ?? []) await this.invalidateSnapshot(sessionId)
		if (plan.emitSessionListChange === true) this.hub.send({ type: "session_list_changed", sessionId: opened.id })
		return { ...context, promptError }
	}

	async bridgeSessionInfo(id) {
		const runtime = this.runtimes.get(id)
		if (runtime && !runtime.agent.isDead) {
			const info = await runtime.sessionInfo(id)
			if (!info) return undefined
			const properties = runtime.effectiveSessionProperties()
			return { ...info, project: await this.projectInfo(projectCwdForSnapshot(runtime.session, properties, runtime.cwd)) }
		}
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		const info = sessionInfoFromEntry(entry)
		let properties
		let project
		try {
			const opened = this.openStoredSession(id)
			opened.session.legacySessionProperties = entry.agentView
			await this.assertOpenedSessionAllowed(opened.session, entry.cwd)
			properties = getEffectiveSessionProperties(opened.session)
			project = await this.projectInfo(projectCwdForSnapshot(opened.session, properties, entry.cwd))
		} catch (err) {
			this.rethrowSessionNotFound(id, err)
		}
		return { ...info, project, properties }
	}

	async bridgeSessionSet(id, patch, source = undefined) {
		const runtime = await this.getRuntime(id)
		const write = await runtime.appendSessionPropertyPatch(patch, source)
		await this.invalidateSnapshot(id)
		const info = await runtime.sessionInfo(id)
		if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		const properties = runtime.effectiveSessionProperties()
		return { ...info, project: await this.projectInfo(projectCwdForSnapshot(runtime.session, properties, runtime.cwd)), write }
	}

	async bridgeSessionCat(id, options = {}) {
		const runtime = this.runtimes.get(id)
		if (runtime && !runtime.agent.isDead) return formatTranscriptEntries(id, runtime.session.getDisplayEntries(), runtime.visibleProjectionOptions(options))
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		try {
			const opened = this.openStoredSession(id)
			opened.session.legacySessionProperties = entry.agentView
			await this.assertOpenedSessionAllowed(opened.session, entry.cwd)
			return formatTranscriptEntries(id, opened.session.getDisplayEntries(), {
				...options,
				showAutomatedMaintenanceUsers: Boolean(this.db.getProjectMaintenanceSessionBySessionId(id)),
			})
		} catch (err) {
			this.rethrowSessionNotFound(id, err)
		}
	}

	async bridgeSessionCollection(filters = {}) {
		const entries = await this.workspaceAllowedSessionEntries(this.db.listSessionStatuses())
		const rows = filterSessionCollectionRows(entries.map((entry) => {
			const runtime = this.runtimes.get(entry.id)
			const liveRunning = runtime?.isStreaming() === true
			return {
				...entry,
				runStatus: liveRunning ? "running" : entry.runStatus,
				runtimeState: liveRunning ? "running" : entry.runtimeState,
				lifecycleState: liveRunning || entry.runStatus === "running" || entry.runtimeState === "running" ? "running" : "stopped",
			}
		}), filters)
		return Promise.all(rows.map(async (entry) => ({
			...entry,
			project: await this.projectInfo(projectCwdForSessionEntry(entry)).catch(() => undefined),
		})))
	}

	async bridgeSessionsList(filters = {}) {
		return formatSessionCollectionRows(await this.bridgeSessionCollection(filters))
	}

	async bridgeProjectInfo(id) {
		const runtime = this.runtimes.get(id)
		if (runtime && !runtime.agent.isDead) return runtime.bridgeProjectInfo()
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		try {
			const opened = this.openStoredSession(id)
			opened.session.legacySessionProperties = entry.agentView
			await this.assertOpenedSessionAllowed(opened.session, entry.cwd)
			const properties = getEffectiveSessionProperties(opened.session)
			return this.projectInfo(projectCwdForSnapshot(opened.session, properties, entry.cwd))
		} catch (err) {
			this.rethrowSessionNotFound(id, err)
		}
	}

	async bridgeProjectSet(id, name) {
		const runtime = await this.getRuntime(id)
		const result = await runtime.bridgeProjectSet(name, { invalidate: false })
		await this.registerProjectRoot(result.project.root, { force: true })
		await this.invalidateSnapshot(id, {})
		this.hub.send({ type: "session_list_changed" })
		return result
	}

	ensurePreviewRoot(record) {
		const existing = this.db.getPreviewRoot(record.scopeId)
		if (existing
			&& existing.scopeKind === record.scopeKind
			&& existing.rootPath === record.rootPath
			&& existing.projectDir === (record.projectDir ?? undefined)
			&& existing.sessionId === (record.sessionId ?? undefined)) return existing
		return this.db.upsertPreviewRoot(record)
	}

	async registerProjectRoot(projectDir, options = {}) {
		const normalizedRoot = await this.normalizeUserCwd(projectDir, "project directory")
		const root = await this.workspace.paths.resolveDirectory(normalizedRoot, "project directory")
		await this.assertStoredCwdAllowed(root, "project directory")
		const setup = await projectMaintenanceSetupStatus(root, this.workspace)
		const project = setup.project
		if (options.force !== true && !await shouldAutoRegisterProjectRoot(root, project, this.workspace)) return undefined
		const projectScopeId = projectPreviewScopeId(root)
		const documentsRoot = projectDocumentsDirectory(root)
		const staticScopeId = staticPreviewScopeId(documentsRoot)
		const projectRoot = projectMaintenanceEligible(setup)
			? this.ensurePreviewRoot({
				scopeId: projectScopeId,
				scopeKind: PREVIEW_ROOT_KIND_PROJECT,
				rootPath: projectPreviewDirectory(root),
				projectDir: root,
			})
			: undefined
		const staticRoot = this.ensurePreviewRoot({
			scopeId: staticScopeId,
			scopeKind: PREVIEW_ROOT_KIND_STATIC,
			rootPath: documentsRoot,
			projectDir: root,
		})
		return {
			projectDir: root,
			project,
			setup,
			projectRoot,
			staticRoot,
		}
	}

	async projectMaintenanceContext(projectDir) {
		const root = await this.normalizeUserCwd(projectDir, "project directory")
		await this.assertStoredCwdAllowed(root, "project directory")
		const setup = await projectMaintenanceSetupStatus(root, this.workspace)
		return {
			projectDir: root,
			setup,
			project: setup.project,
			eligible: projectMaintenanceEligible(setup),
		}
	}

	projectMaintenanceSkippedResult(context) {
		return {
			projectDir: context.projectDir,
			created: false,
			skipped: true,
			setup: context.setup,
			project: context.project,
		}
	}

	async projectMaintenanceRecordFromContext(context, options = {}) {
		if (!context.eligible) return context
		const record = options.create === true
			? await this.ensureProjectMaintenanceSession(context.projectDir, options.ensureOptions ?? { runPrompt: false })
			: this.db.getProjectMaintenanceSession(context.projectDir)
		return {
			...context,
			record: record?.sessionId ? record : undefined,
		}
	}

	async projectMaintenanceRecordForProject(projectDir, options = {}) {
		return await this.projectMaintenanceRecordFromContext(await this.projectMaintenanceContext(projectDir), options)
	}

	async worktreePreviewSession(projectDir, sessionId) {
		const id = typeof sessionId === "string" ? sessionId.trim() : ""
		if (!id) return undefined
		const entry = this.findSessionEntry(id)
		if (!entry) return undefined
		await this.assertSessionEntryAllowed(entry)
		let root
		let sessionCwd
		try {
			root = await this.workspace.paths.resolveDirectory(projectDir, "preview project cwd")
			sessionCwd = await this.workspace.paths.resolveDirectory(entry.cwd, "preview session cwd")
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
			throw err
		}
		if (sessionCwd !== root) return undefined
		return { sessionId: id, entry }
	}

	async projectPreviewRunner(context, options = {}) {
		// Linked worktrees keep project maintenance disabled; their checked-out preview definitions run in the explicitly associated worktree session instead.
		if (context.setup?.linkedGitWorktree) {
			return await this.worktreePreviewSession(context.projectDir, options.sessionId)
		}
		if (!context.eligible) return undefined
		const owner = await this.projectMaintenanceRecordFromContext(context, {
			create: options.createMaintenance === true,
			ensureOptions: {
				runPrompt: false,
				...(options.ensureSetupFiles === false ? { ensureSetupFiles: false } : {}),
			},
		})
		return owner.record ? { sessionId: owner.record.sessionId, maintenance: owner } : undefined
	}

	registerStaticPreviewDefinition(projectDir, definition) {
		const rootPath = resolve(definition.source.path)
		const scopeId = staticPreviewScopeId(rootPath)
		const record = this.ensurePreviewRoot({
			scopeId,
			scopeKind: PREVIEW_ROOT_KIND_STATIC,
			rootPath,
			projectDir,
		})
		return record ? { definition, record, scopeId } : undefined
	}

	async registerConfiguredStaticPreviews(projectDir) {
		const root = await this.normalizeUserCwd(projectDir, "project directory")
		await this.assertStoredCwdAllowed(root, "project directory")
		const definitions = projectStaticPreviewDefinitions(await this.workspace.previews.projectManifest(root))
		return definitions.map((definition) => this.registerStaticPreviewDefinition(root, definition)).filter(Boolean)
	}

	async resolveStaticPreviewRequest(request = {}) {
		const requested = typeof request.filePath === "string" && request.filePath
			? request.filePath
			: undefined
		if (!requested) throw Object.assign(new Error("static preview filePath is required"), { status: 400 })
		let filePath
		try {
			filePath = (await this.workspace.previews.resolveStaticFile(requested)).path
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Path not found"), { status: 404 })
			throw err
		}
		if (!pathIsPageDocument(filePath)) throw Object.assign(new Error("Static preview requires an HTML or Markdown file"), { status: 400 })
		if (request.projectDir) await this.registerConfiguredStaticPreviews(request.projectDir)
		const candidates = []
		const records = [
			...this.db.listPreviewRoots(PREVIEW_ROOT_KIND_STATIC),
			...this.db.listPreviewRoots(PREVIEW_ROOT_KIND_SOURCE),
		]
		for (const record of records) {
			if (record.projectDir && !pathIsWithin(record.projectDir, filePath)) continue
			const definition = await staticPreviewDefinitionForRecord(this.workspace, record, undefined, { ignoreInvalidSource: true })
			const rootPath = definition?.source?.path ? resolve(definition.source.path) : undefined
			if (rootPath && pathIsWithin(rootPath, filePath)) candidates.push({ ...record, rootPath, definition })
		}
		let record = longestContainingRoot(candidates, filePath)
		if (!record) throw Object.assign(new Error("Static document preview requires a file under a configured static preview root"), {
			code: STATIC_PREVIEW_NOT_CONFIGURED,
			status: 404,
		})
		const equallySpecific = candidates.filter((candidate) => resolve(candidate.rootPath) === resolve(record.rootPath))
		const registered = equallySpecific.find((candidate) => candidate.scopeKind === PREVIEW_ROOT_KIND_STATIC)
		if (registered) record = registered
		else if (equallySpecific.length > 1) {
			throw Object.assign(new Error("Static document preview matches multiple directly opened preview definitions"), { status: 409 })
		}
		await this.assertStoredCwdAllowed(record.projectDir, "static preview project directory")
		await this.assertStoredCwdAllowed(record.rootPath, "static preview root directory")
		const relativePath = relative(record.rootPath, filePath)
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw Object.assign(new Error("Path not allowed"), { status: 403 })
		return {
			scopeId: record.scopeId,
			scopeKind: record.scopeKind,
			rootPath: record.rootPath,
			projectDir: record.projectDir ?? record.rootPath,
			definition: record.definition,
			filePath,
			relativePath,
		}
	}

	async resolveSessionPreviewSourcePath(sessionId, value) {
		const id = typeof sessionId === "string" ? sessionId.trim() : ""
		if (!id) throw Object.assign(new Error("Session preview source requires a session"), { status: 400 })
		const sessionDir = resolve(sessionWorkspacePath(id))
		const requested = typeof value === "string" ? value.trim() : ""
		if (!requested) throw Object.assign(new Error("preview source path is required"), { status: 400 })
		if (!isAbsolute(requested)) throw Object.assign(new Error("preview source path must be absolute"), { status: 400 })
		if (!pathIsWithin(sessionDir, resolve(requested))) throw Object.assign(new Error("Preview source is outside the session file directory"), { status: 403 })
		let sourcePath
		try {
			sourcePath = resolve(await realpath(resolve(requested)))
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Preview source file not found"), { status: 404 })
			throw err
		}
		if (!pathIsWithin(sessionDir, sourcePath)) throw Object.assign(new Error("Preview source is outside the session file directory"), { status: 403 })
		if (!sourcePath.endsWith(PREVIEW_FILE_SUFFIX) && !sourcePath.endsWith(STATIC_PREVIEW_FILE_SUFFIX) && !pathIsPageDocument(sourcePath)) {
			throw Object.assign(new Error(`preview source file must end with ${PREVIEW_FILE_SUFFIX} or ${STATIC_PREVIEW_FILE_SUFFIX}, or be an HTML or Markdown file`), { status: 400 })
		}
		const info = await stat(sourcePath)
		if (!info.isFile()) throw Object.assign(new Error("Preview source is not a file"), { status: 400 })
		return sourcePath
	}

	async sessionPreviewDefinitionForSourcePath(sourcePath) {
		try {
			return await previewFileDefinitionFromPath(sourcePath)
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw Object.assign(new Error("Preview source file not found"), { status: 404 })
			if (sourcePath.endsWith(STATIC_PREVIEW_FILE_SUFFIX)) throw Object.assign(new Error(err?.message ?? String(err)), { status: 400 })
			if (/preview source (?:file must end with|is not a file)/.test(String(err?.message ?? ""))) {
				throw Object.assign(new Error(err.message), { status: 400 })
			}
			throw err
		}
	}

	async sourcePreviewTargetForProject(projectDir, sourcePath, definition, scopeId, options = {}) {
		const root = await this.normalizeUserCwd(projectDir, "project directory")
		await this.assertStoredCwdAllowed(root, "project directory")
		if (!pathIsWithin(root, sourcePath)) return undefined
		if (isStaticPreviewDefinition(definition)) {
			await this.assertStoredCwdAllowed(definition.source.path, "static preview root directory")
			this.ensurePreviewRoot({
				scopeId,
				scopeKind: PREVIEW_ROOT_KIND_SOURCE,
				rootPath: sourcePath,
				projectDir: root,
			})
			return {
				scopeKind: "static",
				scopeId,
				rootPath: definition.source.path,
				projectDir: root,
				definition,
			}
		}
		const context = await this.projectMaintenanceContext(root)
		const runner = await this.projectPreviewRunner(context, {
			sessionId: options.sessionId,
			createMaintenance: true,
			ensureSetupFiles: false,
		})
		if (!runner) return undefined
		this.ensurePreviewRoot({
			scopeId,
			scopeKind: PREVIEW_ROOT_KIND_SOURCE,
			rootPath: sourcePath,
			projectDir: context.projectDir,
			sessionId: runner.sessionId,
		})
		return {
			scopeKind: "project",
			scopeId,
			sessionId: runner.sessionId,
			projectDir: context.projectDir,
			definition,
			logPath: projectPreviewLogPath(context.projectDir, definition.name),
		}
	}

	async sourcePreviewTargetForSession(sessionId, sourcePath, definition, scopeId) {
		const id = typeof sessionId === "string" && sessionId ? sessionId : undefined
		if (!id) return undefined
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		const sessionDir = sessionWorkspacePath(id)
		if (!pathIsWithin(sessionDir, sourcePath)) return undefined
		this.ensurePreviewRoot({
			scopeId,
			scopeKind: PREVIEW_ROOT_KIND_SOURCE,
			rootPath: sourcePath,
			sessionId: id,
		})
		return {
			scopeKind: "session",
			scopeId,
			sessionId: id,
			sessionDir,
			definition,
			logPath: previewLogPath(sessionDir, definition.name),
			entry,
		}
	}

	async resolvePreviewSource(request = {}) {
		if (pathIsPageDocument(request.path)) {
			let resolved
			try {
				resolved = await this.resolveStaticPreviewRequest({
					filePath: request.path,
					projectDir: request.projectDir,
				})
			} catch (err) {
				if (err?.code === STATIC_PREVIEW_NOT_CONFIGURED) return { preview: null }
				throw err
			}
			const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
			const routingSlug = previewRoutingSlugFromSettings(this.opts.getSettings?.())
			return {
				preview: previewItemFromTarget({
					scopeKind: "static",
					scopeId: resolved.scopeId ?? staticPreviewScopeId(resolved.rootPath),
					rootPath: resolved.rootPath,
					projectDir: resolved.projectDir,
					definition: resolved.definition,
				}, publicUrl, routingSlug),
			}
		}
		let target
		let projectError
		if (request.projectDir) {
			try {
				const source = await this.workspace.previews.resolveSource(request.path, { projectDir: request.projectDir })
				target = await this.sourcePreviewTargetForProject(request.projectDir, source.path, source.definition, sourcePreviewScopeId(source.path), { sessionId: request.sessionId })
			} catch (err) {
				projectError = err
			}
		}
		let fallbackTarget = target
		const sessionId = typeof request.sessionId === "string" && request.sessionId ? request.sessionId : undefined
		const sessionDir = sessionId ? sessionWorkspacePath(sessionId) : undefined
		const isSessionSource = sessionDir
			&& typeof request.path === "string"
			&& isAbsolute(request.path)
			&& pathIsWithin(sessionDir, resolve(request.path))
		if (!fallbackTarget && isSessionSource) {
			try {
				const sourcePath = await this.resolveSessionPreviewSourcePath(sessionId, request.path)
				const definition = await this.sessionPreviewDefinitionForSourcePath(sourcePath)
				fallbackTarget = await this.sourcePreviewTargetForSession(sessionId, sourcePath, definition, sourcePreviewScopeId(sourcePath))
			} catch (err) {
				throw err
			}
		}
		if (!fallbackTarget && projectError) throw projectError
		if (!fallbackTarget) throw Object.assign(new Error("Preview source is outside the current project or session workspace"), { status: 404 })
		const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
		const routingSlug = previewRoutingSlugFromSettings(this.opts.getSettings?.())
		return {
			preview: previewItemFromTarget(fallbackTarget, publicUrl, routingSlug),
		}
	}

	async sourcePreviewTargetFromRootRecord(rootRecord, match) {
		const source = rootRecord.projectDir
			? await this.workspace.previews.resolveSource(rootRecord.rootPath, { projectDir: rootRecord.projectDir })
			: {
				path: await this.resolveSessionPreviewSourcePath(rootRecord.sessionId, rootRecord.rootPath),
				definition: await this.sessionPreviewDefinitionForSourcePath(rootRecord.rootPath),
			}
		const sourcePath = source.path
		const definition = source.definition
		if (definition.name !== match.name) throw Object.assign(new Error(`Preview source not found: ${match.name}`), { status: 404 })
		if (isStaticPreviewDefinition(definition) && rootRecord.projectDir) {
			await this.assertStoredCwdAllowed(rootRecord.projectDir, "static preview project directory")
			await this.assertStoredCwdAllowed(definition.source.path, "static preview root directory")
			return {
				scopeKind: "static",
				scopeId: rootRecord.scopeId,
				rootPath: definition.source.path,
				projectDir: rootRecord.projectDir,
				definition,
			}
		}
		if (rootRecord.projectDir) {
			const context = await this.projectMaintenanceContext(rootRecord.projectDir)
			const runner = await this.projectPreviewRunner(context, {
				sessionId: rootRecord.sessionId,
				createMaintenance: true,
				ensureSetupFiles: false,
			})
			if (!runner) throw Object.assign(new Error(`Preview scope not found: ${rootRecord.scopeId}`), { status: 404 })
			this.ensurePreviewRoot({
				scopeId: rootRecord.scopeId,
				scopeKind: PREVIEW_ROOT_KIND_SOURCE,
				rootPath: sourcePath,
				projectDir: context.projectDir,
				sessionId: runner.sessionId,
			})
			return {
				scopeKind: "project",
				scopeId: rootRecord.scopeId,
				sessionId: runner.sessionId,
				projectDir: context.projectDir,
				definition,
				logPath: projectPreviewLogPath(context.projectDir, definition.name),
			}
		}
		if (rootRecord.sessionId) {
			const entry = this.findSessionEntry(rootRecord.sessionId)
			if (!entry) throw Object.assign(new Error(`Session not found: ${rootRecord.sessionId}`), { status: 404 })
			await this.assertSessionEntryAllowed(entry)
			const sessionDir = sessionWorkspacePath(rootRecord.sessionId)
			return {
				scopeKind: "session",
				scopeId: rootRecord.scopeId,
				sessionId: rootRecord.sessionId,
				sessionDir,
				definition,
				logPath: previewLogPath(sessionDir, definition.name),
				entry,
			}
		}
		throw Object.assign(new Error(`Preview scope not found: ${rootRecord.scopeId}`), { status: 404 })
	}

	async ensureProjectMaintenanceSession(projectDir, options = {}) {
		const context = await this.projectMaintenanceContext(projectDir)
		const root = context.projectDir
		const setup = context.setup
		if (!context.eligible) return this.projectMaintenanceSkippedResult(context)
		await this.registerProjectRoot(root, { force: true })
		const existing = this.db.getProjectMaintenanceSession(root)
		if (options.onlyIfNeeded === true && !setup.needed) {
			if (existing) await this.ensureProjectMaintenanceSessionProperties(existing.sessionId, root, { state: false })
			return {
				projectDir: root,
				created: false,
				skipped: true,
				setup,
				project: setup.project,
			}
		}
		if (setup.needed && options.ensureSetupFiles !== false) await ensureProjectPreviewsDirectory(root, this.workspace)
		if (existing) {
			const entry = this.findSessionEntry(existing.sessionId)
			if (entry) {
				await this.assertSessionEntryAllowed(entry)
				const record = entry.hidden === true ? existing : this.db.markProjectMaintenanceSession({ projectDir: root, sessionId: existing.sessionId }) ?? existing
				const project = setup.project ?? await this.projectInfo(root).catch(() => undefined)
				await this.ensureProjectMaintenanceSessionProperties(record.sessionId, root)
				let promptError
				let promptSkipped
				if (setup.needed && options.runPrompt !== false) {
					const runtime = await this.getRuntime(record.sessionId)
					if (projectSetupMaintenanceActive(runtime.agent.state.messages)) {
						promptSkipped = "active"
					} else {
						try {
							const promptText = projectMaintenancePrompt({ projectDir: root, project, setup })
							const submission = await runtime.beginUserMessagePrompt({
								role: "user",
								content: [{ type: "text", text: promptText }],
								timestamp: Date.now(),
								automated: true,
								maintenance: PROJECT_SETUP_MAINTENANCE_KIND,
							}, undefined)
							await runtime.waitForPromptAccepted(submission)
							await this.completeProjectMaintenanceSessionAfterPrompt(runtime, options)
						} catch (err) {
							promptError = /** @type {any} */ (err)?.message ?? String(err)
							if (options.bestEffortPrompt === false) throw err
						}
					}
				}
				return {
					...record,
					created: false,
					setup,
					project,
					...(promptSkipped ? { promptSkipped } : {}),
					...(promptError ? { promptError } : {}),
				}
			}
		}

		let initial = initialSessionEnvironment(root)
		initial = { ...initial, cwd: await this.normalizeUserCwd(initial.cwd, "project maintenance cwd") }
		const project = setup.project ?? await this.projectInfo(root).catch(() => undefined)
		const launch = await this.launchManagedSession({
			open: { kind: "create", cwd: initial.cwd },
			contextMessageCwd: initial.cwd,
			beforeRuntime: ({ opened }) => {
				const record = this.db.markProjectMaintenanceSession({ projectDir: root, sessionId: opened.id })
				if (!record) throw new Error(`Could not mark project maintenance session ${opened.id}`)
				return record
			},
			config: ({ runtime }) => sessionConfigForAgent(runtime.agent, {
				initialWd: initial.cwd,
				projectDir: root,
				sandboxMounts: [root],
				environmentId: initial.environmentId,
				noContextFiles: this.opts.noContextFiles === true,
			}),
			properties: {
				patch: {
					state: SESSION_DISCUSSING_STATE,
					descriptionInUi: PROJECT_MAINTENANCE_SESSION_TITLE,
					projectDir: root,
					cwd: initial.cwd,
				},
				source: { kind: "project_maintenance_properties" },
				options: { allowStoredCwd: true },
			},
			notices: [projectMaintenanceNoticeMessage({ projectDir: root })],
			initialPrompt: options.runPrompt === false ? undefined : () => {
				const promptText = projectMaintenancePrompt({ projectDir: root, project, setup })
				return {
					kind: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: promptText }],
						timestamp: Date.now(),
						automated: true,
						maintenance: PROJECT_SETUP_MAINTENANCE_KIND,
					},
					bestEffort: options.bestEffortPrompt !== false,
				}
			},
			invalidateSessionIds: ({ opened }) => [opened.id],
			emitSessionListChange: true,
		})
		if (options.runPrompt !== false && !launch.promptError) await this.completeProjectMaintenanceSessionAfterPrompt(launch.runtime, options)
		return {
			...launch.registration,
			created: true,
			setup,
			project,
			...(launch.promptError ? { promptError: launch.promptError } : {}),
		}
	}

	async ensureProjectMaintenanceSessionProperties(sessionId, projectDir, options = {}) {
		const runtime = await this.getRuntime(sessionId)
		const patch = {
			descriptionInUi: PROJECT_MAINTENANCE_SESSION_TITLE,
			projectDir,
			...(options.cwd ? { cwd: options.cwd } : {}),
		}
		if (options.state !== false) patch.state = options.state ?? SESSION_DISCUSSING_STATE
		return runtime.appendSessionPropertyPatch(patch, { kind: "project_maintenance_properties" }, { allowStoredCwd: true })
	}

	async completeProjectMaintenanceSessionAfterPrompt(runtime, options = {}) {
		if (options.waitForCompletion === false) {
			this.scheduleProjectMaintenanceCompletion(runtime)
			return
		}
		await this.completeProjectMaintenanceSession(runtime)
	}

	scheduleProjectMaintenanceCompletion(runtime) {
		const sessionId = runtime.sessionId
		const existing = this.projectMaintenanceCompletionTasks.get(sessionId)
		if (existing) return existing
		let task
		task = Promise.resolve()
			.then(() => this.completeProjectMaintenanceSession(runtime))
			.catch((err) => {
				if (!this.disposed) console.error(`project maintenance completion failed for ${sessionId}:`, err?.stack ?? err)
			})
			.finally(() => {
				if (this.projectMaintenanceCompletionTasks.get(sessionId) === task) this.projectMaintenanceCompletionTasks.delete(sessionId)
			})
		this.projectMaintenanceCompletionTasks.set(sessionId, task)
		return task
	}

	async completeProjectMaintenanceSession(runtime) {
		await runtime.waitForIdle()
		await runtime.appendSessionPropertyPatch({
			state: SESSION_COMPLETED_STATE,
		}, { kind: "project_maintenance_completed" })
		await this.invalidateSnapshot(runtime.sessionId)
		this.hub.send({ type: "session_list_changed", sessionId: runtime.sessionId })
	}

	async resolvePreviewTarget(match) {
		const value = String(match?.scopeId ?? "").trim().toLowerCase()
		if (!/^[a-z0-9]{16}$/.test(value)) throw Object.assign(new Error("preview scope id must be a 16-character lowercase hash"), { status: 400 })
		const rootRecord = this.db.getPreviewRoot(value)
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_STATIC) {
			const definition = await staticPreviewDefinitionForRecord(this.workspace, rootRecord, match?.name)
			if (definition) {
				await this.assertStoredCwdAllowed(rootRecord.projectDir, "static preview project directory")
				await this.assertStoredCwdAllowed(rootRecord.rootPath, "static preview root directory")
				return {
					scopeKind: "static",
					scopeId: value,
					rootPath: rootRecord.rootPath,
					projectDir: rootRecord.projectDir,
					definition,
				}
			}
		}
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_SOURCE) {
			return await this.sourcePreviewTargetFromRootRecord(rootRecord, match)
		}
		const sessionMatches = await Promise.all(this.db.listSessionStatuses({ includeHidden: true }).map(async (entry) => {
			const sessionDir = sessionWorkspacePath(entry.id)
			if (sessionPreviewScopeId(sessionDir) !== value) return undefined
			const manifest = await readSessionPreviewDefinitions(sessionDir)
			const definition = manifest.previews[match.name]
			if (!definition) return undefined
			return {
				scopeKind: "session",
				scopeId: value,
				sessionId: entry.id,
				sessionDir,
				definition,
				logPath: previewLogPath(sessionDir, definition.name),
				entry,
			}
		}))
		const projectMatches = []
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_PROJECT && rootRecord.projectDir) {
			await this.assertStoredCwdAllowed(rootRecord.projectDir, "project preview directory")
			const context = await this.projectMaintenanceContext(rootRecord.projectDir)
			const runner = await this.projectPreviewRunner(context, {
				sessionId: rootRecord.sessionId,
				createMaintenance: true,
			})
			if (runner) {
				const manifest = await this.workspace.previews.projectManifest(rootRecord.projectDir)
				const definition = manifest.previews[match.name]
				if (definition && !isStaticPreviewDefinition(definition)) {
					projectMatches.push({
						scopeKind: "project",
						scopeId: value,
						sessionId: runner.sessionId,
						projectDir: context.projectDir,
						definition,
						logPath: projectPreviewLogPath(context.projectDir, definition.name),
					})
				}
			}
		}
		const matches = [...sessionMatches, ...projectMatches].filter(Boolean)
		if (matches.length === 0) throw Object.assign(new Error(`Preview scope not found: ${value}`), { status: 404 })
		if (matches.length > 1) throw Object.assign(new Error(`Ambiguous preview scope id ${value}`), { status: 400 })
		const target = matches[0]
		if (target.scopeKind === "session") await this.assertSessionEntryAllowed(target.entry)
		return target
	}

	async previewTargetForUrl(value) {
		const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
		if (!publicUrl) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} publicUrl is required for previews`), { status: 404 })
		let publicBase
		try {
			publicBase = new URL(publicUrl)
		} catch (err) {
			throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} publicUrl is invalid`), { status: 404, cause: err })
		}
		let url
		try {
			url = new URL(String(value ?? ""))
		} catch (err) {
			throw Object.assign(new Error("preview url must be an absolute URL"), { status: 400, cause: err })
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") throw Object.assign(new Error("preview url must use http or https"), { status: 400 })
		if (url.protocol !== publicBase.protocol || urlPort(url) !== urlPort(publicBase)) throw Object.assign(new Error("URL is not a Cerex preview URL"), { status: 404 })
		const match = matchPreviewHost(url.host, publicUrl)
		if (!match) throw Object.assign(new Error("URL is not a Cerex preview URL"), { status: 404 })
		const target = await this.resolvePreviewTarget(match)
		return { match, publicUrl, target, url }
	}

	async resolvePreviewUrl(value) {
		const { match, publicUrl, target, url } = await this.previewTargetForUrl(value)
		return {
			preview: previewItemFromTarget(target, publicUrl, match.routingSlug, url.href),
		}
	}

	async previewLogForUrl(value) {
		const { match, publicUrl, target, url } = await this.previewTargetForUrl(value)
		return {
			preview: previewItemFromTarget(target, publicUrl, match.routingSlug, url.href),
			text: target.scopeKind === "project"
				? await this.workspace.previews.readProjectLog(target.projectDir, target.definition.name, MAX_PREVIEW_UI_FILE_BYTES)
				: await readTextFileTail(target.logPath),
		}
	}

	async previewSourceForUrl(value) {
		const { match, publicUrl, target, url } = await this.previewTargetForUrl(value)
		const source = target.definition.source
		const path = previewSourcePath(source)
		const preview = previewItemFromTarget(target, publicUrl, match.routingSlug, url.href)
		if (!path) return { preview, source, path: "", text: "", unavailable: true }
		if (target.scopeKind !== "session") {
			try {
				const result = await this.workspace.previews.readSource(path, MAX_PREVIEW_UI_FILE_BYTES)
				if (result.tooLarge) return { preview, source, path: result.path, text: "", tooLarge: true, size: result.size }
				return { preview, source, ...result }
			} catch (err) {
				if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.status === 404) return { preview, source, path, text: "", error: "Source file not found" }
				throw err
			}
		}
		let info
		try {
			info = await stat(path)
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { preview, source, path, text: "", error: "Source file not found" }
			throw err
		}
		if (!info.isFile()) return { preview, source, path, text: "", error: "Preview source is not a file" }
		if (info.size > MAX_PREVIEW_UI_FILE_BYTES) return { preview, source, path, text: "", tooLarge: true, size: info.size }
		return { preview, source, path, text: await readFile(path, "utf-8"), size: info.size }
	}

	async bridgePreviewList(id) {
		const info = await this.bridgeSessionInfo(id)
		if (!info) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		const sessionDir = sessionWorkspacePath(id)
		const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
		const routingSlug = previewRoutingSlugFromSettings(this.opts.getSettings?.())
		const sessionScope = { kind: "session", scopeId: sessionPreviewScopeId(sessionDir), sessionId: id, logPath: undefined }
		const sessionManifest = await readSessionPreviewDefinitions(sessionDir)
		const sessionPreviews = Object.values(sessionManifest.previews).map((definition) => previewItemFromDefinition({
			...sessionScope,
			logPath: previewLogPath(sessionDir, definition.name),
		}, definition, publicUrl, routingSlug))
		const project = info.project ?? await this.bridgeProjectInfo(id).catch(() => undefined)
		const entry = this.findSessionEntry(id)
		const sessionCwdContext = entry?.cwd ? await this.projectMaintenanceContext(entry.cwd).catch(() => undefined) : undefined
		let projectPreviews = []
		if (sessionCwdContext?.setup?.linkedGitWorktree) {
			projectPreviews = (await this.projectPreviewList(sessionCwdContext.projectDir, { sessionId: id })).previews
		} else if (project?.root) {
			projectPreviews = (await this.projectPreviewList(project.root, { sessionId: id, createMaintenance: false })).previews
		}
		return {
			previews: [...projectPreviews, ...sessionPreviews],
			project,
			sessionId: id,
		}
	}

	async sessionPreviewList(id) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
		const routingSlug = previewRoutingSlugFromSettings(this.opts.getSettings?.())
		const sessionDir = sessionWorkspacePath(id)
		const previewsDirectory = join(sessionDir, PREVIEW_LOG_DIRNAME)
		const previewsDirectoryExists = await sessionPreviewsDirectoryExists(sessionDir)
		let previewsError
		let sessionDefinitions = []
		if (previewsDirectoryExists) {
			try {
				sessionDefinitions = Object.values((await readSessionPreviewDefinitions(sessionDir)).previews)
			} catch (err) {
				previewsError = /** @type {any} */ (err)?.message ?? String(err)
			}
		}
		const sessionScope = { kind: "session", scopeId: sessionPreviewScopeId(sessionDir), sessionId: id, logPath: undefined }
		return {
			sessionId: id,
			sessionDirectory: sessionDir,
			previewsDirectory,
			previewsDirectoryExists,
			...(previewsError ? { previewsError } : {}),
			previews: sessionDefinitions.map((definition) => previewItemFromDefinition({
				...sessionScope,
				logPath: previewLogPath(sessionDir, definition.name),
			}, definition, publicUrl, routingSlug)),
		}
	}

	projectDocumentPreview(projectDir, definition, publicUrl, routingSlug) {
		if (!definition) return undefined
		const registered = this.registerStaticPreviewDefinition(projectDir, definition)
		if (!registered) return undefined
		return previewItemFromDefinition({ kind: "project", scopeId: registered.scopeId }, registered.definition, publicUrl, routingSlug)
	}

	async projectPreviewList(projectDir, options = {}) {
		const root = await this.normalizeUserCwd(projectDir, "project directory")
		await this.assertStoredCwdAllowed(root, "project directory")
		const publicUrl = this.opts.getPreviewPublicUrl?.() ?? previewPublicUrlFromSettings(this.opts.getSettings?.())
		const routingSlug = previewRoutingSlugFromSettings(this.opts.getSettings?.())
		let projectManifest
		let previewsError
		try {
			projectManifest = await this.workspace.previews.projectManifest(root)
		} catch (err) {
			previewsError = /** @type {any} */ (err)?.message ?? String(err)
			projectManifest = { directory: projectPreviewDirectory(root), exists: false, previews: {}, documentPreview: null }
		}
		const previewsDirectory = projectManifest.directory
		const previewsDirectoryExists = projectManifest.exists
		const documentPreview = this.projectDocumentPreview(root, projectManifest.documentPreview, publicUrl, routingSlug)
		const context = await this.projectMaintenanceContext(root)
		const project = context.project
		const projectDefinitions = Object.values(projectManifest.previews)
		const staticDefinitions = staticPreviewDefinitions(projectDefinitions)
		const processDefinitions = processPreviewDefinitions(projectDefinitions)
		await this.registerProjectRoot(root, { force: projectDefinitions.length > 0 })
		const staticPreviews = staticDefinitions
			.map((definition) => this.registerStaticPreviewDefinition(root, definition))
			.filter(Boolean)
			.map((registered) => previewItemFromDefinition({
				kind: "project",
				scopeId: registered.scopeId,
			}, registered.definition, publicUrl, routingSlug))
		const projectScopeId = projectPreviewScopeId(root)
		let runner
		if (processDefinitions.length > 0) {
			runner = await this.projectPreviewRunner(context, {
				sessionId: options.sessionId,
				createMaintenance: options.createMaintenance !== false,
			})
			if (runner) {
				this.ensurePreviewRoot({
					scopeId: projectScopeId,
					scopeKind: PREVIEW_ROOT_KIND_PROJECT,
					rootPath: previewsDirectory,
					projectDir: root,
					...(context.setup.linkedGitWorktree ? { sessionId: runner.sessionId } : {}),
				})
			}
		} else {
			runner = await this.projectPreviewRunner(context)
		}
		return {
			projectDir: root,
			project,
			previewsDirectory,
			previewsDirectoryExists,
			...(previewsError ? { previewsError } : {}),
			maintenanceSessionId: runner?.maintenance?.record?.sessionId,
			previews: [
				...(documentPreview ? [documentPreview] : []),
				...staticPreviews,
				...(runner || (context.eligible && !context.setup.linkedGitWorktree) ? processDefinitions.map((definition) => previewItemFromDefinition({
					kind: "project",
					scopeId: projectScopeId,
					sessionId: runner?.sessionId,
					logPath: projectPreviewLogPath(root, definition.name),
				}, definition, publicUrl, routingSlug)) : []),
			],
		}
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
					opened = this.openStoredSession(id)
				} finally {
					endOpen?.()
				}
			} catch (/** @type {any} */ err) {
				this.rethrowSessionNotFound(id, err)
			}
			const cwd = opened.session.getMetadata().cwd ?? this.cwd
			const entry = this.findSessionEntry(id)
			if (entry) opened.session.legacySessionProperties = entry.agentView
			await this.assertOpenedSessionAllowed(opened.session, cwd)
			if (this.opts.noContextFiles !== true && opened.session.getSessionConfig?.().noContextFiles !== true) await ensureProjectContextMessage(opened.session, cwd, this.workspace)
			this.upsertSession(opened.session, opened.id)
			const runtime = await this.createRuntime(opened.session, opened.id)
			endGetRuntime({ cache: "miss" })
			return runtime
		} finally {
			endGetRuntime({ error: true })
		}
	}

	async createSession(cwd = this.cwd) {
		const requestedCwd = await this.normalizeUserCwd(cwd, "session cwd")
		let initial = initialSessionEnvironment(requestedCwd)
		initial = { ...initial, cwd: await this.normalizeUserCwd(initial.cwd, "session initial cwd") }
		const opened = await this.createStoredSession(initial.cwd)
		if (this.opts.noContextFiles !== true) await ensureProjectContextMessage(opened.session, initial.cwd, this.workspace)
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
		const projectDir = await initialProjectDirForCwd(initial.cwd, this.workspace)
		if (projectDir) await this.registerProjectRoot(projectDir)
		await opened.session.appendConfigPatch(sessionConfigForAgent(runtime.agent, {
			initialWd: initial.cwd,
			...(projectDir ? { projectDir } : {}),
			sandboxMounts: [initial.cwd],
			environmentId: initial.environmentId,
			noContextFiles: this.opts.noContextFiles === true,
		}))
		runtime.refreshSessionPropertyCache({ source: { kind: "session_create" } })
		return runtime
	}

	async branchSession(sourceId, options = {}) {
		const sourceRuntime = await this.getRuntime(sourceId)
		const requestedEntryId = typeof options.entryId === "string" && options.entryId ? options.entryId : undefined
		const targetEntry = requestedEntryId ? sourceRuntime.session.getEntry(requestedEntryId) : undefined
		if (requestedEntryId && (!targetEntry || !isHumanUserEntry(targetEntry) || isProjectContextMessage(targetEntry.message))) {
			throw Object.assign(new Error(`Branch target not found: ${requestedEntryId}`), { status: 404 })
		}
		const sourceEntryId = targetEntry ? targetEntry.parentId ?? null : undefined
		const restoreDraft = targetEntry && options.restoreDraft !== false
			? promptDraftFromMessages([targetEntry.message])
			: undefined
		sourceRuntime.session.legacySessionProperties = sourceRuntime.legacySessionProperties
		const sourceProps = sourceEntryId === undefined
			? sourceRuntime.effectiveSessionProperties()
			: getEffectiveSessionProperties(sourceRuntime.session, sourceEntryId)
		const sourceConfig = sourceEntryId === undefined
			? sourceRuntime.session.getSessionConfig?.() ?? {}
			: sessionConfigAt(sourceRuntime.session, sourceEntryId)
		const targetId = await this.createSessionId()
		const sourceCwd = await this.normalizeOptionalUserCwd(options.cwd, "branch cwd") ?? sourceProps.cwd ?? sourceRuntime.cwd ?? this.cwd
		const workspaceBranch = await branchSessionWorkspace({
			sourceSessionId: sourceId,
			targetSessionId: targetId,
			cwd: sourceCwd,
			pathMappings: sessionWorkspacePathMappingsForEnvironment(sourceId, targetId, sourceProps, sourceConfig, sourceRuntime),
		})
		const cwd = workspaceBranch.cwd?.newPath ?? sourceCwd
		const fallbackDescription = firstVisibleUserText(sourceRuntime.agent.state.messages)
		const opened = await this.branchStoredSession(sourceId, {
			cwd,
			sessionId: targetId,
			...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
		})
		this.upsertSession(opened.session, opened.id)
		const runtime = await this.createRuntime(opened.session, opened.id)
		applyAgentModel(runtime.agent, cwd, sourceRuntime.agent.state.model)
		const sourceDescription = cleanText(sourceProps.descriptionInUi || fallbackDescription || "Session branch", 148)
		const sandboxMounts = remapSandboxMounts(sessionSandboxMounts(sourceConfig), workspaceBranch.remapPath)
		await opened.session.appendConfigPatch(sessionConfigForAgent(runtime.agent, {
			...sourceConfig,
			initialWd: cwd,
			projectDir: sourceProps.projectDir ? remapProjectDir(sourceProps.projectDir, workspaceBranch.remapPath) : undefined,
			sandboxMounts,
		}))
		await opened.session.appendGlobalConfigPatch(sessionModelConfigForAgent(runtime.agent))
		await resetInheritedSessionGitWorktrees(opened.session)
		const propertyPatch = {
			state: SESSION_DISCUSSING_STATE,
			descriptionInUi: sourceDescription.startsWith("(branched)") ? sourceDescription : `(branched) ${sourceDescription}`,
			...(sourceProps.projectDir ? { projectDir: remapProjectDir(sourceProps.projectDir, workspaceBranch.remapPath) } : {}),
			...(workspaceBranch.cwd?.changed ? { cwd } : {}),
		}
		await runtime.appendSessionPropertyPatch(propertyPatch, { kind: "branch" }, { allowStoredCwd: true })
		await this.appendRuntimeMessage(runtime, branchNoticeMessage(workspaceBranch))
		if (restoreDraft) await this.setPromptDraft(opened.id, restoreDraft.text)
		await this.invalidateSnapshot(opened.id)
		return runtime
	}

	subSessionItem(row) {
		const sessionEntry = this.findSessionEntry(row.childSessionId)
		const runtime = this.runtimes.get(row.childSessionId)
		return {
			...row,
			status: subSessionStatus(row, sessionEntry, runtime?.isStreaming() === true),
			openCommand: subSessionOpenCommand(row.childSessionId),
			cwd: sessionEntry?.cwd,
			runStatus: runtime?.isStreaming() ? "running" : sessionEntry?.runStatus,
			runtimeState: runtime?.isStreaming() ? "running" : sessionEntry?.runtimeState,
		}
	}

	parentSubSessionRecord(parentSessionId) {
		return this.db.getSubSession(parentSessionId)
	}

	resolveSubSession(parentSessionId, selector, options = {}) {
		const value = String(selector ?? "").trim()
		if (!value) throw Object.assign(new Error("sub-agent name or session id is required"), { status: 400 })
		const rows = this.db.listSubSessions(parentSessionId, { includeClosed: true })
		const matches = rows.filter((row) => row.name === value || row.childSessionId === value || row.childSessionId.startsWith(value))
		if (matches.length === 0) throw Object.assign(new Error(`Sub-agent not found: ${value}`), { status: 404 })
		if (matches.length > 1) throw Object.assign(new Error(`Ambiguous sub-agent selector: ${value}`), { status: 400 })
		const row = matches[0]
		if (row.closedAt && options.allowClosed !== true) throw Object.assign(new Error(`Sub-agent is closed: ${row.name}`), { status: 409 })
		return row
	}

	async spawnSubSession(parentSessionId, request = {}) {
		const task = cleanPromptText(request.task)
		if (!task) throw Object.assign(new Error("sub-agent task is required"), { status: 400 })
		const forkTurns = normalizeSubSessionForkTurns(request.forkTurns)
		const existing = this.db.listSubSessions(parentSessionId, { includeClosed: true })
		const requestedName = normalizeSubSessionName(request.name)
		const existingNames = new Set(existing.map((row) => row.name))
		const name = requestedName ?? defaultSubSessionName(existingNames)
		if (existingNames.has(name)) throw Object.assign(new Error(`Sub-agent name already exists: ${name}`), { status: 409 })

		const parentRecord = this.parentSubSessionRecord(parentSessionId)
		const rootSessionId = parentRecord?.rootSessionId ?? parentSessionId
		const depth = (parentRecord?.depth ?? 0) + 1
		if (depth > SUB_SESSION_MAX_DEPTH) throw Object.assign(new Error(`Sub-agent nesting is limited to depth ${SUB_SESSION_MAX_DEPTH}`), { status: 409 })
		const openForRoot = this.db.listSubSessionsForRoot(rootSessionId).length
		if (openForRoot >= SUB_SESSION_MAX_OPEN_PER_ROOT) throw Object.assign(new Error(`Sub-agent limit reached for this session tree (${SUB_SESSION_MAX_OPEN_PER_ROOT})`), { status: 409 })

		const sourceRuntime = await this.getRuntime(parentSessionId)
		sourceRuntime.session.legacySessionProperties = sourceRuntime.legacySessionProperties
		const sourceProps = sourceRuntime.effectiveSessionProperties()
		const sourceConfig = sourceRuntime.session.getSessionConfig?.() ?? {}
		const targetId = await this.createSessionId()
		const sourceCwd = await this.normalizeOptionalUserCwd(request.cwd, "sub-session cwd") ?? sourceProps.cwd ?? sourceRuntime.cwd ?? this.cwd
		const workspaceBranch = await branchSessionWorkspace({
			sourceSessionId: parentSessionId,
			targetSessionId: targetId,
			cwd: sourceCwd,
			pathMappings: sessionWorkspacePathMappingsForEnvironment(parentSessionId, targetId, sourceProps, sourceConfig, sourceRuntime),
		})
		const cwd = workspaceBranch.cwd?.newPath ?? sourceCwd
		const branchEntryId = sourceRuntime.session.getLeafId()
		const sandboxMounts = remapSandboxMounts(sessionSandboxMounts(sourceConfig), workspaceBranch.remapPath)
		const sourceDescription = cleanText(sourceProps.descriptionInUi || firstVisibleUserText(sourceRuntime.agent.state.messages) || "Sub-session", 96)
		const launch = await this.launchManagedSession({
			open: {
				kind: "branch",
				sourceSessionId: parentSessionId,
				cwd,
				sessionId: targetId,
				sourceEntryId: branchEntryId,
			},
			beforeRuntime: ({ opened }) => {
				this.db.setSessionHidden(opened.id, true)
			},
			beforeConfig: ({ opened }) => {
				return this.db.upsertSubSession({
					childSessionId: opened.id,
					parentSessionId,
					rootSessionId,
					name,
					origin: request.origin === "user" ? "user" : "agent",
					forkTurns,
					depth,
					task: cleanText(task, 240),
					branchEntryId: branchEntryId ?? undefined,
				})
			},
			config: ({ runtime, registration }) => {
				applyAgentModel(runtime.agent, cwd, sourceRuntime.agent.state.model)
				return sessionConfigForAgent(runtime.agent, {
					...sourceConfig,
					initialWd: cwd,
					projectDir: sourceProps.projectDir ? remapProjectDir(sourceProps.projectDir, workspaceBranch.remapPath) : undefined,
					sandboxMounts,
					subSession: subSessionConfig({ ...registration, branchEntryId }),
				})
			},
			afterConfig: async ({ opened, runtime }) => {
				await opened.session.appendGlobalConfigPatch(sessionModelConfigForAgent(runtime.agent))
				await resetInheritedSessionGitWorktrees(opened.session)
			},
			properties: {
				patch: {
					state: SESSION_DISCUSSING_STATE,
					descriptionInUi: `[${name}] ${cleanText(task, 110) || sourceDescription}`,
					projectTag: sourceProps.projectTag,
					...(sourceProps.projectDir ? { projectDir: remapProjectDir(sourceProps.projectDir, workspaceBranch.remapPath) } : {}),
					...(workspaceBranch.cwd?.changed ? { cwd } : {}),
				},
				source: { kind: "sub_session_spawn", parentSessionId, name },
				options: { allowStoredCwd: true },
			},
			notices: ({ opened }) => [
				branchNoticeMessage(workspaceBranch),
				subSessionNoticeMessage({ name, parentSessionId, childSessionId: opened.id }),
			],
			initialPrompt: { kind: "text", text: task },
			invalidateSessionIds: ({ opened }) => [parentSessionId, opened.id],
			emitSessionListChange: true,
		})
		return this.subSessionItem(launch.registration)
	}

	async listSubSessions(parentSessionId, request = {}) {
		return this.db
			.listSubSessions(parentSessionId, { includeClosed: request.includeClosed === true })
			.map((row) => this.subSessionItem(row))
	}

	async waitSubSession(parentSessionId, request = {}) {
		const row = this.resolveSubSession(parentSessionId, request.agent, { allowClosed: true })
		const runtime = await this.getRuntime(row.childSessionId)
		const timeoutMs = Number(request.timeoutMs)
		if (!row.closedAt) {
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				await Promise.race([
					runtime.waitForIdle(),
					sleep(timeoutMs).then(() => {
						throw Object.assign(new Error(`Timed out waiting for sub-agent ${row.name}`), { status: 408 })
					}),
				])
			} else {
				await runtime.waitForIdle()
			}
		}
		const snapshot = await runtime.snapshot()
		return {
			...this.subSessionItem(row),
			latestAssistantText: latestAssistantText(snapshot.messages),
		}
	}

	async followupSubSession(parentSessionId, request = {}) {
		const row = this.resolveSubSession(parentSessionId, request.agent)
		const task = cleanPromptText(request.task)
		if (!task) throw Object.assign(new Error("follow-up task is required"), { status: 400 })
		const runtime = await this.getRuntime(row.childSessionId)
		if (request.interrupt === true && runtime.isStreaming()) await runtime.abort()
		const submission = await runtime.beginPrompt(task, runtime.agent.state.isStreaming ? "followUp" : undefined)
		if (submission.streamingBehavior) runtime.observePromptAccepted(submission)
		else await runtime.waitForPromptAccepted(submission)
		await this.invalidateSnapshot(parentSessionId)
		await this.invalidateSnapshot(row.childSessionId)
		return this.subSessionItem(row)
	}

	async resumeSubSession(parentSessionId, request = {}) {
		const row = this.resolveSubSession(parentSessionId, request.agent, { allowClosed: true })
		if (!this.findSessionEntry(row.childSessionId)) throw Object.assign(new Error(`Sub-agent session not found: ${row.name}`), { status: 404 })
		const reopened = row.closedAt ? this.db.reopenSubSession(row.childSessionId) ?? row : row
		await this.invalidateSnapshot(parentSessionId)
		await this.invalidateSnapshot(row.childSessionId)
		this.hub.send({ type: "session_list_changed", sessionId: row.childSessionId })
		return this.subSessionItem(reopened)
	}

	async closeSubSession(parentSessionId, request = {}) {
		const row = this.resolveSubSession(parentSessionId, request.agent, { allowClosed: true })
		const runtime = this.runtimes.get(row.childSessionId)
		if (runtime?.isStreaming()) await runtime.abort()
		const closed = this.db.closeSubSession(row.childSessionId, cleanText(request.reason, 240) || undefined) ?? row
		await this.invalidateSnapshot(parentSessionId)
		await this.invalidateSnapshot(row.childSessionId)
		this.hub.send({ type: "session_list_changed", sessionId: row.childSessionId })
		return this.subSessionItem(closed)
	}

	async resumeRunnableInterruptedRuns() {
		const candidates = (await this.workspaceAllowedSessionEntries(this.db.listSessionStatuses({ includeHidden: true }))).filter(autoResumeCandidate)
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
						this.hub.send({ type: "session_list_changed", sessionId: entry.id })
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
		for (const entry of await this.workspaceAllowedSessionEntries(this.db.listSessionStatuses({ includeHidden: true }))) {
			if (entry.agentView?.state === "legacy") {
				const preview = this.loadSessionPreview(entry.id)
				const metadata = completedLegacyMetadata(entry, preview)
				this.db.setAgentViewMetadata(entry.id, metadata)
				this.hub.send({ type: "agent_view_metadata", sessionId: entry.id, metadata })
				continue
			}
			if (!needsLegacyAgentViewFallback(entry.agentView)) continue
			const preview = this.loadSessionPreview(entry.id)
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
		return this.db.getSession(id)
	}

	findSessionEntryIncludingDeleted(id) {
		return this.db.getSession(id, { includeDeleted: true })
	}

	sessionStatusForEntry(entry) {
		const runtime = this.runtimes.get(entry.id)
		const live = runtime && !runtime.agent.isDead ? runtime.statusCursor() : undefined
		const liveRunning = live?.isStreaming === true
		const storedRunning = entry.runStatus === "running" || entry.runtimeState === "running"
		const agentView = entry.agentView ? {
			state: entry.agentView.state,
			updatedAt: entry.agentView.updatedAt,
		} : undefined
		return {
			id: entry.id,
			sessionId: entry.id,
			...(this.cursorGeneration ? { cursorGeneration: this.cursorGeneration } : {}),
			seq: live?.seq ?? this.getEventSeq(entry.id),
			viewEpoch: live?.viewEpoch ?? this.getViewEpoch(entry.id),
			isStreaming: live ? live.isStreaming : storedRunning,
			...(live?.currentModelRequest ? { currentModelRequest: live.currentModelRequest } : {}),
			pendingToolCallCount: live?.pendingToolCallCount ?? 0,
			cwd: entry.cwd,
			initialWd: entry.initialWd,
			hidden: entry.hidden === true,
			sessionKind: entry.sessionKind,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
			latestRunStartedAt: entry.latestRunStartedAt,
			latestRunEndedAt: entry.latestRunEndedAt,
			runStatus: liveRunning ? "running" : entry.runStatus,
			runtimeState: liveRunning ? "running" : entry.runtimeState,
			...(agentView ? { agentView } : {}),
		}
	}

	scheduleCompletedWorktreeCleanup(id, runtime) {
		if (this.completedWorktreeCleanupTasks.has(id)) return
		let task
		task = Promise.resolve()
			.then(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0))
				if (this.completedWorktreeCleanupTasks.get(id) !== task) return
				const end = this.diagnostics?.span?.("RuntimeManager.cleanupCompletedWorktrees", { sessionId: id })
				try {
					const removed = await cleanupSessionGitWorktrees(runtime.session, { workspace: this.workspace })
					if (removed.length === 0) {
						end?.({ removed: 0 })
						return
					}
					for (const event of removed) await runtime.remapClosedWorktreePaths(event)
					this.worktreeStatusCache.delete(id)
					this.worktreeStatusLoads.delete(id)
					await this.invalidateSnapshot(id)
					this.scheduleWorktreeStatusRefresh(id, { force: true, reason: "completed_worktree_cleanup", delayMs: 0 })
					end?.({ removed: removed.length })
				} catch (err) {
					end?.({ error: /** @type {any} */ (err)?.message ?? String(err) })
					throw err
				}
			})
			.catch(() => {})
			.finally(() => {
				if (this.completedWorktreeCleanupTasks.get(id) === task) this.completedWorktreeCleanupTasks.delete(id)
			})
		this.completedWorktreeCleanupTasks.set(id, task)
	}

	async markAgentViewState(id, state, _result, runningMessage, options = {}) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		if (this.runtimes.get(id)?.isStreaming() || entry.runStatus === "running") throw Object.assign(new Error(runningMessage), { status: 409 })
		const runtime = await this.getRuntime(id)
		const write = await runtime.appendSessionPropertyPatch({ state }, { kind: "user_mark" }, { force: runNeedsAcknowledgement(entry) })
		await this.invalidateSnapshot(id)
		if (options.cleanupWorktrees === true) this.scheduleCompletedWorktreeCleanup(id, runtime)
		return sessionPropertiesToAgentView(write.properties) ?? {}
	}

	async markCompleted(id) {
		return this.markAgentViewState(id, SESSION_COMPLETED_STATE, "Marked completed by user.", "Cannot mark a running session completed.", { cleanupWorktrees: true })
	}

	async setPromptDraft(id, text, options = {}) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		const draft = this.db.setPromptDraft(id, text, options)
		if (draft.applied !== false) this.hub.send({ type: "prompt_draft_update", sessionId: id, draft })
		return draft
	}

	async markDeferred(id) {
		return this.markAgentViewState(id, SESSION_DEFERRED_STATE, "Deferred by user.", "Cannot defer a running session.")
	}

	async markReadyForReview(id) {
		return this.markAgentViewState(id, SESSION_DISCUSSING_STATE, "Reopened by user.", "Cannot reopen a running session.")
	}

	async deleteStoppedSession(id) {
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		const runtime = this.runtimes.get(id)
		if (runtime?.isStreaming() || entry.runStatus === "running") throw Object.assign(new Error("Stop the session before deleting it."), { status: 409 })
		runtime?.dispose()
		this.runtimes.delete(id)
		this.worktreeStatusCache.delete(id)
		this.worktreeStatusLoads.delete(id)
		this.db.closeSubSession(id, "session deleted")
		this.db.markSessionDeleted(id)
		this.hub.send({ type: "session_list_changed", sessionId: id })
		return { ok: true }
	}

	async restoreDeletedSession(id) {
		const entry = this.findSessionEntryIncludingDeleted(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		if (!entry.deletedAt) return { ok: true }
		await this.assertSessionEntryAllowed(entry)
		if (!restoreSessionInDb(this.db, id)) throw Object.assign(new Error(`Session is not deleted: ${id}`), { status: 409 })
		this.hub.send({ type: "session_list_changed", sessionId: id })
		return { ok: true }
	}

	async projectSessionListEntries(entries, now = Date.now()) {
		const previewRowsBySessionId = new Map()
		const endPreviews = this.diagnostics?.span?.("RuntimeManager.loadSessionPreviews", { count: entries.length })
		try {
			for (const row of this.db.loadSessionOverviewPreviewMessagesForSessions(entries.map((entry) => entry.id))) {
				const rows = previewRowsBySessionId.get(row.sessionId) ?? []
				rows.push(row)
				previewRowsBySessionId.set(row.sessionId, rows)
			}
		} finally {
			endPreviews?.({ count: previewRowsBySessionId.size })
		}

		const projectCwds = [...new Set(entries.map(projectCwdForSessionEntry))]
		const projectsByCwd = new Map(await Promise.all(projectCwds.map(async (cwd) => [cwd, await this.projectInfo(cwd)])))
		return entries.map((entry) => {
			const liveRunning = this.runtimes.get(entry.id)?.isStreaming() === true
			const preview = sessionPreviewFromMessages(previewRowsBySessionId.get(entry.id) ?? [])
			let agentView = entry.agentView
			const lifecycleState = lifecycleStateForSession(entry, preview, liveRunning)
			const fallbackState = entry.deletedAt ? undefined : fallbackAgentViewState(entry, preview, now)
			if (!entry.deletedAt && agentView?.state === "legacy") {
				agentView = completedLegacyMetadata(entry, preview)
				this.db.setAgentViewMetadata(entry.id, agentView)
			}
			if (!entry.deletedAt && fallbackState === "completed" && needsLegacyAgentViewFallback(agentView)) {
				agentView = completedLegacyMetadata({ ...entry, agentView }, preview)
				this.db.setAgentViewMetadata(entry.id, agentView)
			}
			return {
				id: entry.id,
				cwd: entry.cwd,
				initialWd: entry.initialWd,
				projectDir: entry.projectDir,
				project: projectsByCwd.get(projectCwdForSessionEntry(entry)),
				sessionKind: entry.sessionKind,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				deletedAt: entry.deletedAt,
				hidden: entry.hidden === true,
				hasWorktrees: entry.hasWorktrees === true,
				latestRunStartedAt: entry.latestRunStartedAt,
				latestRunEndedAt: entry.latestRunEndedAt,
				runStatus: liveRunning ? "running" : entry.runStatus,
				runtimeState: liveRunning ? "running" : entry.runtimeState,
				lifecycleState,
				preview,
				agentView,
				agentViewFallbackState: fallbackState,
			}
		})
	}

	async sessionListEntry(id, cwd = undefined, options = {}) {
		const filterCwd = await this.normalizeOptionalUserCwd(cwd, "session list cwd filter")
		this.pruneIdleRuntimes()
		const entry = this.db.getSessionListEntry(id, {
			includeDeleted: options.includeDeleted === true,
			includeHidden: options.includeHidden === true,
		})
		if (!entry || !sessionMatchesDirectoryFilter(entry, filterCwd)) return undefined
		const [allowed] = await this.workspaceAllowedSessionEntries([entry])
		if (!allowed) return undefined
		return (await this.projectSessionListEntries([allowed]))[0]
	}

	async sessions(cwd = undefined, options = {}) {
		const filterCwd = await this.normalizeOptionalUserCwd(cwd, "session list cwd filter")
		const end = this.diagnostics?.span?.("RuntimeManager.sessions", { cwd: filterCwd })
		let entries = []
		try {
			this.pruneIdleRuntimes()
			const endList = this.diagnostics?.span?.("RuntimeManager.db.listSessions", { cwd: filterCwd })
			try {
				const listed = filterCwd
					? this.db.listSessionsForDirectory(filterCwd, {
						includeDeleted: options.includeDeleted === true,
						includeHidden: options.includeHidden === true,
					})
					: this.db.listSessions(undefined, {
						includeDeleted: options.includeDeleted === true,
						includeHidden: options.includeHidden === true,
					})
				entries = (await this.workspaceAllowedSessionEntries(listed)).filter((entry) => sessionMatchesDirectoryFilter(entry, filterCwd))
			} finally {
				endList?.({ count: entries.length })
			}
			return await this.projectSessionListEntries(entries)
		} finally {
			end?.({ count: entries.length })
		}
	}

	async sessionsStatus(cwd = undefined, options = {}) {
		const filterCwd = await this.normalizeOptionalUserCwd(cwd, "session status cwd filter")
		const end = this.diagnostics?.span?.("RuntimeManager.sessionsStatus", { cwd: filterCwd })
		let entries = []
		try {
			this.pruneIdleRuntimes()
			entries = (await this.workspaceAllowedSessionEntries(this.db.listSessionStatuses({
				cwd: filterCwd,
				includeDeleted: options.includeDeleted === true,
				includeHidden: options.includeHidden === true,
			}))).filter((entry) => sessionMatchesDirectoryFilter(entry, filterCwd))
			const sessions = entries.map((entry) => this.sessionStatusForEntry(entry))
			const latest = (field) => sessions.reduce((max, session) => {
				const value = session[field]
				return typeof value === "string" && value > max ? value : max
			}, "")
			return {
				cwd: filterCwd,
				count: sessions.length,
				maxUpdatedAt: latest("updatedAt"),
				maxLatestRunStartedAt: latest("latestRunStartedAt"),
				maxLatestRunEndedAt: latest("latestRunEndedAt"),
				sessions,
			}
		} finally {
			end?.({ count: entries.length })
		}
	}

	async sessionStatus(id = this.initialSessionId) {
		if (!id) throw new Error("No session selected")
		const entry = this.findSessionEntry(id)
		if (!entry) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		await this.assertSessionEntryAllowed(entry)
		return this.sessionStatusForEntry(entry)
	}

	async overviewCwd(cwd = undefined) {
		if (cwd === undefined || cwd === null || cwd === "") return this.cwd
		if (cwdIsInsideSessionWorkspacesRoot(cwd)) {
			const sessionWorkspaceProjectDir = (await this.workspaceAllowedSessionEntries(this.db.listSessionStatuses({ includeHidden: true })))
				.map((entry) => sessionWorkspaceProjectDirForCwd(entry, cwd))
				.find(Boolean)
			if (sessionWorkspaceProjectDir) return await this.normalizeUserCwd(sessionWorkspaceProjectDir, "overview cwd")
		}
		try {
			return await this.normalizeUserCwd(cwd, "overview cwd")
		} catch (err) {
			if (this.workspaceRoot && /** @type {any} */ (err)?.status) return this.workspaceRoot
			throw err
		}
	}

	async overviewProject(cwd = undefined) {
		const projectCwd = await this.overviewCwd(cwd)
		const project = await this.projectInfo(projectCwd)
		await this.registerProjectRoot(project.root).catch(() => undefined)
		return project
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

	pruneWorktreeStatusCache() {
		const maxEntries = this.worktreeStatusCacheOptions.maxEntries
		if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
			this.worktreeStatusCache.clear()
			return
		}
		while (this.worktreeStatusCache.size > maxEntries) {
			const oldest = this.worktreeStatusCache.keys().next().value
			if (!oldest) break
			this.worktreeStatusCache.delete(oldest)
		}
	}

	async loadWorktreesUncached(id) {
		const existing = this.runtimes.get(id)
		if (existing && !existing.agent.isDead) return existing.worktrees()
		if (existing?.agent.isDead) {
			existing.dispose()
			this.runtimes.delete(id)
		}
		try {
			const entry = this.findSessionEntry(id)
			if (!entry) throw new Error(`Session not found: ${id}`)
			await this.assertSessionEntryAllowed(entry)
			const records = gitWorktreeRecordsFromEntries(this.db.loadSessionCustomEntries(id, GIT_WORKTREE_CUSTOM_TYPE))
			return this.workspace.worktrees.statuses(records)
		} catch (/** @type {any} */ err) {
			this.rethrowSessionNotFound(id, err, { clearWorktreeStatus: true })
		}
	}

	emitWorktreeStatus(id, cacheEntry, reason = undefined) {
		this.hub.send({
			type: "worktree_status",
			sessionId: id,
			worktrees: cloneWorktreeStatuses(cacheEntry.statuses),
			loadedAt: cacheEntry.loadedAt,
			mutationVersion: cacheEntry.mutationVersion,
			...(reason ? { reason } : {}),
		})
	}

	scheduleWorktreeStatusRefresh(id, options = {}) {
		if (!id || this.disposed) return
		const existing = this.worktreeStatusRefreshTimers.get(id)
		if (existing) {
			existing.force = existing.force || options.force === true
			existing.reason = options.reason ?? existing.reason
			return
		}
		const item = {
			timer: setTimeout(() => {
				this.worktreeStatusRefreshTimers.delete(id)
				void this.worktrees(id, { force: item.force, reason: item.reason }).catch(() => {})
			}, Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 150),
			force: options.force === true,
			reason: options.reason,
		}
		item.timer.unref?.()
		this.worktreeStatusRefreshTimers.set(id, item)
	}

	async worktrees(id = this.initialSessionId, options = {}) {
		if (!id) throw new Error("No session selected")
		const sessionMutation = this.db.getSessionMutation(id)
		if (!sessionMutation) {
			this.worktreeStatusCache.delete(id)
			throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 })
		}
		const cached = this.worktreeStatusCache.get(id)
		if (options.force !== true && worktreeStatusCacheHit(cached, sessionMutation, this.worktreeStatusCacheOptions)) {
			this.worktreeStatusCache.delete(id)
			this.worktreeStatusCache.set(id, cached)
			return cloneWorktreeStatuses(cached.statuses)
		}
		const loading = this.worktreeStatusLoads.get(id)
		if (loading?.mutationVersion === sessionMutation.mutationVersion) return cloneWorktreeStatuses(await loading.promise)
		const promise = this.loadWorktreesUncached(id)
			.then((statuses) => {
				const currentMutation = this.db.getSessionMutation(id)
				if (currentMutation?.mutationVersion === sessionMutation.mutationVersion) {
					const cacheEntry = {
						mutationVersion: sessionMutation.mutationVersion,
						loadedAt: Date.now(),
						statuses: cloneWorktreeStatuses(statuses),
					}
					this.worktreeStatusCache.delete(id)
					this.worktreeStatusCache.set(id, cacheEntry)
					this.pruneWorktreeStatusCache()
					this.emitWorktreeStatus(id, cacheEntry, options.reason)
				}
				return cloneWorktreeStatuses(statuses)
			})
			.finally(() => {
				const current = this.worktreeStatusLoads.get(id)
				if (current?.promise === promise) this.worktreeStatusLoads.delete(id)
			})
		this.worktreeStatusLoads.set(id, { mutationVersion: sessionMutation.mutationVersion, promise })
		return cloneWorktreeStatuses(await promise)
	}

	async invalidateSnapshot(id, options = this.snapshotOptions) {
		if (!id) throw new Error("No session selected")
		const end = this.diagnostics?.span?.("RuntimeManager.invalidateSnapshot", {
			sessionId: id,
			includeSessions: options.includeSessions === true,
		})
		try {
			const cursor = this.runtimes.get(id)?.snapshotCursor() ?? {
				...(this.cursorGeneration ? { cursorGeneration: this.cursorGeneration } : {}),
				seq: this.getEventSeq(id),
				viewEpoch: this.getViewEpoch(id),
			}
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
		const candidates = [...this.runtimes.values()]
			.filter((runtime) => !runtime.isStreaming())
		for (const runtime of candidates) runtime.pruneIdleResources?.(now)
		const idle = candidates
			.filter((runtime) => !runtime.hasBackgroundWork() && runtime.sessionId !== this.initialSessionId)
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
		this.disposed = true
		for (const runtime of this.runtimes.values()) runtime.dispose()
		this.runtimes.clear()
		for (const item of this.worktreeStatusRefreshTimers.values()) clearTimeout(item.timer)
		this.worktreeStatusRefreshTimers.clear()
		this.worktreeStatusCache.clear()
		this.worktreeStatusLoads.clear()
		this.completedWorktreeCleanupTasks.clear()
		this.projectMaintenanceCompletionTasks.clear()
	}
}
