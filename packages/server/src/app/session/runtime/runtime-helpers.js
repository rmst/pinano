// Shared helpers for session runtime orchestration and session list projection.

import { isAbsolute, join, resolve } from "node:path"

import { normalizeReasoningLevel } from "../../../../../protocol/src/reasoning.js"
import { productErrorCodeMatches } from "../../../../../protocol/src/product.js"
import { systemPromptFor } from "../../agent/factory.js"
import { toolProfileForModel } from "../../model/instructions/index.js"
import { modelRef, refreshModelFromRegistry, refreshModelWithProviderMetadata, resolveModel, resolveModelWithProviderMetadata } from "../../model/registry.js"
import { getEnvironment, loadEnvironmentRegistry, resolveConfiguredEnvironmentId } from "../../environment/registry.js"
import { sessionWorkspaceToolPathForEnvironment } from "../../environment/context.js"
import { optionalSessionWorkspacesRoot, sessionWorkspacePath } from "../../paths.js"
import { stateMountFromSettings } from "../../settings.js"
import { sessionSandboxBaseWd, sessionSandboxMounts } from "../config.js"
import { pathIsWithin } from "../../sandbox/paths.js"
import { subSessionOpenCommand } from "../sub-sessions.js"
import { internalHttpRequestBodyText } from "../../workers/internal-http.js"
import { isPromptImageMarkerText } from "../../../../../protocol/src/prompt-images.js"
import {
	SESSION_DISCUSSING_STATE,
	SESSION_PROPERTY_STATES,
	SESSION_READY_FOR_REVIEW_STATE,
	SESSION_WORKTREE_MAINTENANCE_STATES,
} from "../properties.js"
import { textFromContent, visibleMessage } from "./transcript-projection.js"
import { shouldAutoRegisterProjectRoot } from "./maintenance.js"
import { worktreeStatusTtlMsForState } from "../../source-control/worktree-status-policy.js"

export {
	DEFAULT_WORKTREE_STATUS_ACTIVE_TTL_MS,
	DEFAULT_WORKTREE_STATUS_CACHE_MAX_ENTRIES,
	DEFAULT_WORKTREE_STATUS_COMPLETED_TTL_MS,
	DEFAULT_WORKTREE_STATUS_DEFERRED_TTL_MS,
	DEFAULT_WORKTREE_STATUS_RUNNING_TTL_MS,
} from "../../source-control/worktree-status-policy.js"

export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_MAX_IDLE_RUNTIMES = 8
export const LEGACY_AGENT_VIEW_COMPLETION_WINDOW_MS = 48 * 60 * 60 * 1000
export const UNKNOWN_TOOL_RECOVERY_MAX_ATTEMPTS = 3
export const SESSION_ACTIVITY_TEXT_MAX = 160
export const PROJECT_MAINTENANCE_SESSION_TITLE = "Project maintenance"

/** @param {any} err */
export function isSessionNotFoundError(err) {
	return err?.code === "ENOENT"
		|| productErrorCodeMatches(err, "CEREX_SESSION_NOT_FOUND")
		|| /Session not found/.test(err?.message ?? "")
}

export function parseInternalJsonBody(request) {
	try {
		return JSON.parse(internalHttpRequestBodyText(request) || "{}")
	} catch {
		throw Object.assign(new Error("Invalid JSON body"), { status: 400 })
	}
}

export function recoveryContinuationOptions(retry, patch) {
	const options = { ...(retry ?? {}) }
	delete options.runId
	return { ...options, ...patch }
}

/** @param {unknown} content */
export function assistantContentHasOutput(content) {
	if (typeof content === "string") return content.trim().length > 0
	if (!Array.isArray(content)) return false
	return /** @type {any[]} */ (content).some((block) => {
		if (!block || typeof block !== "object") return false
		if (block.type === "text") return String(block.text ?? "").trim().length > 0
		if (block.type === "thinking") return String(block.thinking ?? "").trim().length > 0
		return true
	})
}

/** @param {any} message */
export function assistantMessageHasOutput(message) {
	return message?.role === "assistant" && assistantContentHasOutput(message.content)
}

/** @param {any} entry */
export function entryIsAgentOutputBoundary(entry) {
	return (entry?.type === "message" && assistantMessageHasOutput(entry.message))
		|| (entry?.type === "custom" && entry.customType === "tool_execution" && entry.data?.phase === "started")
}

/** @param {string} value @param {number} max */
export function cleanText(value, max = 160) {
	return String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
}

export function cleanPromptText(value, max = 20_000) {
	return String(value || "").trim().slice(0, max)
}

export function cleanStreamingBehavior(value) {
	if (value === undefined || value === "steer" || value === "followUp") return value
	throw Object.assign(new Error("streamingBehavior must be 'steer' or 'followUp' when provided."), { status: 400 })
}

export function activityTextFromContent(content, max = SESSION_ACTIVITY_TEXT_MAX) {
	const limit = Math.max(max * 2, max)
	let value = ""
	const append = (text) => {
		if (value.length >= limit) return
		value += String(text || "").slice(0, limit - value.length)
	}
	if (typeof content === "string") append(content)
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (block?.type === "text" && !isPromptImageMarkerText(block.text ?? "")) append(block.text)
			if (value.length >= limit) break
		}
	}
	return cleanText(value, max)
}

export function sessionActivityFromRuntimeEvent(event) {
	if (!event?.sessionId || event.type === "session_activity") return undefined
	const text = (value, max = SESSION_ACTIVITY_TEXT_MAX) => cleanText(value, max)
	const base = {
		type: "session_activity",
		sessionId: event.sessionId,
		runId: event.runId,
		sourceEventType: event.type,
		sourceSeq: event.seq,
	}
	if (event.type === "agent_start") return { ...base, status: "thinking", text: "Thinking...", sessionListChanged: true }
	if (event.type === "agent_end") return { ...base, status: "idle", clear: true, sessionListChanged: true }
	if (event.type === "error") return { ...base, status: "error", text: text(event.error ?? "error"), sessionListChanged: true }
	if (event.type === "compaction") return { ...base, status: "compacted", sessionListChanged: true }
	if (event.type === "tool_execution_start") return { ...base, status: "tool", text: text(`Running ${event.toolName || "tool"}...`) }
	if (event.type === "message_start" && event.message?.role === "assistant") return { ...base, status: "generating", text: "Generating..." }
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const messageText = activityTextFromContent(event.message.content, 150)
		return {
			...base,
			status: "result",
			...(messageText ? { text: `result: ${messageText}` } : {}),
			sessionListChanged: true,
		}
	}
	if (event.type === "message_end" && event.message?.role === "user") return { ...base, sessionListChanged: true }
	return undefined
}

export function subSessionNoticeMessage({ name, parentSessionId, childSessionId }) {
	return {
		role: "developer",
		content: [{ type: "text", text: [
			`This is Cerex sub-session "${name}" (${childSessionId}), spawned from parent session ${parentSessionId}.`,
			`The user can inspect this session directly with: ${subSessionOpenCommand(childSessionId)}`,
			"Focus on the delegated task. Report durable findings or completion in this session; the parent can wait for or follow up with this sub-session through sub-agent tools.",
		].join("\n") }],
		timestamp: Date.now(),
		hidden: true,
		subSessionNotice: true,
	}
}

export function latestAssistantText(messages) {
	const message = [...(messages ?? [])].reverse().find((item) => item?.role === "assistant")
	return cleanText(textFromContent(message?.content), 400)
}

export function isWorktreeLifecycleState(state) {
	return state === SESSION_READY_FOR_REVIEW_STATE
}

export function sessionPatchNormalizeOptionsForSource(source) {
	if (source?.kind === "worktree_lifecycle") return { allowedStates: SESSION_WORKTREE_MAINTENANCE_STATES, allowNullState: false }
	if (source?.kind === "bridge" || source?.kind === "tool" || source?.kind === "api") return { allowState: false }
	if (source?.kind === "user_mark" || source?.kind === "run_reset" || source?.kind === "branch" || source?.kind === "sub_session_spawn" || source?.kind === "worktree_mode_exit") return { allowedStates: SESSION_PROPERTY_STATES }
	return undefined
}

export function worktreeStatusPath(worktree) {
	return typeof worktree?.path === "string" && worktree.path ? resolve(worktree.path) : undefined
}

export function activeWorktreeStatusForCwd(cwd, worktrees) {
	const cwdPath = typeof cwd === "string" && cwd ? resolve(cwd) : undefined
	const open = (worktrees ?? []).filter((worktree) => !worktree?.removed && worktreeStatusPath(worktree))
	if (cwdPath) {
		const containing = open
			.map((worktree) => ({ worktree, path: worktreeStatusPath(worktree) }))
			.filter(({ path }) => path && pathIsWithin(path, cwdPath))
			.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path))
		if (containing[0]) return containing[0].worktree
	}
	return open.at(-1)
}

/** @param {any[]} messages */
export function firstVisibleUserText(messages) {
	const message = messages.find((m) => m?.role === "user" && visibleMessage(m))
	return cleanText(textFromContent(message?.content), 160)
}

/** @param {string | undefined} updatedAt @param {number} now */
export function olderThanLegacyCompletionWindow(updatedAt, now = Date.now()) {
	const time = new Date(updatedAt || 0).getTime()
	return Number.isFinite(time) && now - time > LEGACY_AGENT_VIEW_COMPLETION_WINDOW_MS
}

/** @param {any} agentView */
export function needsLegacyAgentViewFallback(agentView) {
	if (!agentView?.state) return true
	return agentView.state === "idle" || agentView.state === "failed" || agentView.state === "stopped" || agentView.state === "working" || agentView.state === "experiencing_problems" || !agentView.description
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function cloneWorktreeStatus(status) {
	return {
		...status,
		...(status?.comparison ? { comparison: { ...status.comparison } } : {}),
	}
}

export function cloneWorktreeStatuses(statuses) {
	return Array.isArray(statuses) ? statuses.map(cloneWorktreeStatus) : []
}

export function worktreeStatusTtlMs(sessionMutation, options) {
	const state = sessionMutation?.runtimeState === "running" || sessionMutation?.mutationRunId
		? "running"
		: sessionMutation?.agentViewState
	return worktreeStatusTtlMsForState(state, options)
}

export function worktreeStatusCacheHit(cacheEntry, sessionMutation, options, now = Date.now()) {
	if (!cacheEntry || !sessionMutation) return false
	if (cacheEntry.mutationVersion !== sessionMutation.mutationVersion) return false
	const ttlMs = worktreeStatusTtlMs(sessionMutation, options)
	if (!Number.isFinite(ttlMs) || ttlMs < 0) return false
	return now - cacheEntry.loadedAt <= ttlMs
}

/** @param {any} preview */
export function hasVisibleConversation(preview) {
	return Boolean(preview?.first || preview?.lastUser)
}

/** @param {any} preview */
export function hasVisibleUserPrompt(preview) {
	return Boolean(preview?.lastUser)
}

/** @param {any} entry @param {any} preview @param {boolean} liveRunning */
export function lifecycleStateForSession(entry, preview, liveRunning) {
	if (entry.deletedAt) return "deleted"
	if (liveRunning || entry.runStatus === "running" || entry.runtimeState === "running") return "running"
	if ((entry.runStatus === undefined || entry.runStatus === "idle") && !entry.latestRunStartedAt && !hasVisibleConversation(preview) && !entry.agentView) return "not_started"
	return "stopped"
}

/** @param {any} entry @param {any} preview @param {number} now */
export function fallbackAgentViewState(entry, preview, now) {
	if (!hasVisibleUserPrompt(preview) && !entry.latestRunStartedAt) return undefined
	return olderThanLegacyCompletionWindow(entry.updatedAt, now) ? "completed" : SESSION_DISCUSSING_STATE
}

/** @param {any} entry @param {string | undefined} cwd */
export function sessionMatchesDirectoryFilter(entry, cwd) {
	if (!cwd) return true
	const initialWd = typeof entry.initialWd === "string" && entry.initialWd ? entry.initialWd : entry.cwd
	return typeof initialWd === "string" && initialWd ? pathIsWithin(resolve(cwd), resolve(initialWd)) : false
}

/** @param {any} entry */
export function autoResumableWorkerCrash(entry) {
	return entry.runStatus === "failed"
		&& /Tool executor (?:closed|exited) (?:before init|during executeTool)/.test(entry.latestRunError || "")
}

/** @param {any} entry */
export function autoResumeCandidate(entry) {
	return entry.runStatus === "interrupted" || entry.runtimeState === "interrupted" || autoResumableWorkerCrash(entry)
}

/** @param {any} entry @param {any} preview */
export function completedLegacyMetadata(entry, preview) {
	const previous = entry.agentView
	return {
		state: "completed",
		description: previous?.description || cleanText(preview.first?.text || preview.lastUser?.text || entry.cwd, 160),
		projectTag: previous?.projectTag,
		updatedAt: new Date().toISOString(),
	}
}

/** @param {any} entry */
export function sessionInfoFromEntry(entry) {
	if (!entry) return undefined
	return {
		id: entry.id,
		cwd: entry.cwd,
		projectDir: entry.projectDir,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		hidden: entry.hidden === true,
		sessionKind: entry.sessionKind,
		runStatus: entry.runStatus,
		runtimeState: entry.runtimeState,
		overview: entry.agentView ?? {},
	}
}

/** @param {any} entry */
export function projectCwdForSessionEntry(entry) {
	return entry?.projectDir || entry?.initialWd || entry?.cwd
}

/**
 * @param {any} session
 * @param {any} properties
 * @param {string} fallbackCwd
 */
export function projectCwdForSnapshot(session, properties, fallbackCwd) {
	const config = session?.getSessionConfig?.() ?? {}
	return properties?.projectDir || (typeof config.initialWd === "string" && config.initialWd ? config.initialWd : properties?.cwd ?? fallbackCwd)
}

/** @param {any} entry @param {string} cwd */
export function sessionWorkspaceProjectDirForCwd(entry, cwd) {
	const projectDir = typeof entry?.projectDir === "string" && entry.projectDir ? entry.projectDir : undefined
	if (!entry?.id || !projectDir) return undefined
	return pathIsWithin(resolve(sessionWorkspacePath(entry.id)), resolve(cwd)) ? projectDir : undefined
}

/** @param {string} cwd */
export function cwdIsInsideSessionWorkspacesRoot(cwd) {
	const root = optionalSessionWorkspacesRoot()
	return root ? pathIsWithin(resolve(root), resolve(cwd)) : false
}

export async function initialProjectDirForCwd(cwd, workspace) {
	try {
		const root = await workspace.paths.normalizeStoredCwd(cwd, "project cwd")
		const project = await workspace.project.info(root)
		return await shouldAutoRegisterProjectRoot(root, project, workspace) ? root : undefined
	} catch {
		return undefined
	}
}

export function sessionModelConfigForAgent(agent) {
	return {
		modelRef: agent.state.model ? modelRef(agent.state.model) : undefined,
		model: agent.state.model,
		baseUrl: agent.state.model?.baseUrl,
		toolProfile: toolProfileForModel(agent.state.model),
	}
}

export function sessionConfigForAgent(agent, extra = {}) {
	return {
		...sessionModelConfigForAgent(agent),
		thinkingLevel: agent.state.thinkingLevel,
		serviceTier: agent.state.serviceTier,
		noContextFiles: false,
		permissions: { mode: "default" },
		...extra,
	}
}

export function sessionConfigAt(session, fromId = undefined) {
	const branchConfig = session.getBranch(fromId)
		.filter((entry) => entry.type === "custom" && entry.customType === "config")
		.reduce((config, entry) => ({ ...config, ...(entry.data ?? {}) }), {})
	return { ...branchConfig, ...(session.getGlobalSessionConfig?.() ?? {}) }
}

/** @param {any} mount */
export function sandboxMountSource(mount) {
	if (typeof mount === "string") return mount
	if (mount && typeof mount === "object" && typeof mount.from === "string") return mount.from
	return undefined
}

/** @param {string | undefined} path */
export function localAbsolutePath(path) {
	const text = typeof path === "string" ? path.trim() : ""
	return text && isAbsolute(text) ? resolve(text) : undefined
}

/** @param {Array<{ label: string, path: string | undefined }>} candidates */
export function uniqueLocalPathChecks(candidates) {
	const byPath = new Map()
	for (const candidate of candidates) {
		const path = localAbsolutePath(candidate.path)
		if (!path) continue
		const existing = byPath.get(path)
		if (existing) existing.labels.push(candidate.label)
		else byPath.set(path, { path, labels: [candidate.label] })
	}
	return [...byPath.values()]
}

/** @param {any} props @param {any} config @param {string} fallbackCwd */
export function staleToolCwdPathChecks(props, config, fallbackCwd) {
	const currentCwd = typeof props?.cwd === "string" && props.cwd ? props.cwd : fallbackCwd
	const initialWd = typeof config?.initialWd === "string" && config.initialWd ? config.initialWd : undefined
	const sandboxBaseWd = sessionSandboxBaseWd(config, fallbackCwd)
	return uniqueLocalPathChecks([
		{ label: "cwd", path: currentCwd },
		{ label: "initialWd", path: initialWd },
		{ label: "sandbox base", path: sandboxBaseWd },
		...sessionSandboxMounts(config).map((mount, index) => ({ label: `sandboxMounts[${index}]`, path: sandboxMountSource(mount) })),
	])
}

/** @param {any} props @param {ReturnType<typeof loadEnvironmentRegistry>} registry */
export function sessionUsesLocalTarget(props, registry) {
	const environmentId = resolveConfiguredEnvironmentId(props?.environmentId, registry)
	const environment = getEnvironment(environmentId, registry)
	return environment?.target?.type === "local"
}

/** @param {any} report */
export function cwdFallbackNoticeText(report) {
	const missing = report.missingPaths
		.map((entry) => `- ${entry.labels.join(", ")}: ${entry.path}`)
		.join("\n")
	return [
		"Cerex runtime notice: one or more previous local tool execution paths no longer exist.",
		missing,
		"",
		`Tool execution cwd and session sandbox base were reset to the session workspace: ${report.sessionDir}`,
		"Use `cerex session set cwd <absolute-path>` to choose a project cwd when ready.",
	].join("\n")
}

/** @param {any} report */
export function cwdFallbackNoticeMessage(report) {
	return {
		role: "developer",
		content: [{ type: "text", text: cwdFallbackNoticeText(report) }],
		timestamp: Date.now(),
		hidden: true,
		cwdFallbackNotice: true,
		cwdFallback: {
			version: 1,
			previousCwd: report.previousCwd,
			previousInitialWd: report.previousInitialWd,
			previousSandboxMounts: report.previousSandboxMounts,
			missingPaths: report.missingPaths,
			sessionDir: report.sessionDir,
		},
	}
}

/** @param {any} message @param {any} report */
export function cwdFallbackNoticeMatches(message, report) {
	const fallback = message?.cwdFallback
	return message?.cwdFallbackNotice === true
		&& fallback?.previousCwd === report.previousCwd
		&& fallback?.sessionDir === report.sessionDir
}

/** @param {any} session @param {any} report */
export function sessionHasCwdFallbackNotice(session, report) {
	return (session?.getBranch?.() ?? []).some((entry) => cwdFallbackNoticeMatches(entry.message, report))
}

/** @param {any[]} mounts @param {(path: string) => string | undefined} remapPath */
export function remapSandboxMounts(mounts, remapPath) {
	return mounts.map((mount) => {
		if (typeof mount === "string") return remapPath(mount) ?? mount
		if (mount && typeof mount === "object" && typeof mount.from === "string") {
			const from = remapPath(mount.from) ?? mount.from
			return { ...mount, from }
		}
		return mount
	})
}

/** @param {string | null | undefined} projectDir @param {(path: string) => string | undefined} remapPath */
export function remapProjectDir(projectDir, remapPath) {
	if (!projectDir) return projectDir
	return remapPath(projectDir) ?? projectDir
}

export function sessionWorkspacePathMappingsForEnvironment(sourceId, targetId, sourceProps, sourceConfig, sourceRuntime) {
	const registry = loadEnvironmentRegistry()
	const environmentId = resolveConfiguredEnvironmentId(sourceProps.environmentId, registry)
	const environment = getEnvironment(environmentId, registry)
	const sandboxBaseWd = sessionSandboxBaseWd(sourceConfig, sourceRuntime.session.getMetadata?.()?.cwd ?? sourceRuntime.cwd)
	const sourceDir = sessionWorkspacePath(sourceId)
	const targetDir = sessionWorkspacePath(targetId)
	const stateMount = stateMountFromSettings(sourceRuntime.getSettings?.())
	const sandboxMounts = sessionSandboxMounts(sourceConfig)
	const sourceToolDir = sessionWorkspaceToolPathForEnvironment(environment, sandboxBaseWd, undefined, sourceDir, undefined, stateMount, sandboxMounts)
	const targetToolDir = sessionWorkspaceToolPathForEnvironment(environment, sandboxBaseWd, undefined, targetDir, undefined, stateMount, sandboxMounts)
	if (!sourceToolDir || !targetToolDir) return []
	if (sourceToolDir === sourceDir && targetToolDir === targetDir) return []
	return [{ sourceDir: sourceToolDir, targetDir: targetToolDir, ensureTargetDir: targetDir }]
}

export function applyAgentModel(agent, cwd, nextModel) {
	agent.state.model = nextModel
	agent.state.systemPrompt = systemPromptFor(cwd, agent.state.model)
	agent.refreshToolsForModel?.(agent.state.model)
}

export function applySessionConfig(agent, session, cwd) {
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

export async function applySessionProviderMetadata(agent, session, cwd, settings = undefined) {
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
