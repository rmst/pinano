import { normalizeReasoningLevel } from "../../../protocol/src/reasoning.js"
import { parseBashShortcut, recordBashShortcut, runAgentBashShortcut } from "./bash-shortcut.js"
import { availableModelEntries, buildModel, canonicalModelRef, eligibleSessionModelEntries, modelChoice, modelEntryMatches, modelRef, parseModelRef, sessionModelEligibilityError } from "./model/registry.js"
import { overviewModelStatus } from "./overview/model-status.js"
import { SESSION_ATTACHMENT_VARIANT_DISPLAY, SESSION_ATTACHMENT_VARIANT_ORIGINAL } from "./session/attachments.js"
import { loadSettings, redactedSettings, updateSetting, updateSettings } from "./settings.js"
import { overviewDirectoryFilterUiStateKey, overviewDirectoryStateKey } from "./ui-state.js"
import { WEB_CHAT_COMMANDS, WEB_COMMANDS, WEB_OVERVIEW_COMMANDS } from "../../../protocol/src/web-commands.js"
import { webInitialRouteCwd, webInitialRouteFromSettings } from "./web/initial-route.js"

export function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	})
}

export function bytes(data, contentType, status = 200, headers = {}) {
	return new Response(data, {
		status,
		headers: {
			"content-type": contentType || "application/octet-stream",
			"cache-control": "private, max-age=31536000, immutable",
			...headers,
		},
	})
}

export function error(message, status = 400) {
	return json({ error: message }, status)
}

export function routeError(err) {
	const value = /** @type {any} */ (err)
	return json({
		error: value?.message ?? String(err),
		...(typeof value?.code === "string" && value.code ? { code: value.code } : {}),
	}, value?.status ?? 400)
}

export async function jsonBody(context) {
	return context.req.json().catch(() => ({}))
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const validImageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

function promptImageOriginalFromBody(image, index, options = {}) {
	const original = image.original
	if (original === undefined) return undefined
	if (!original || typeof original !== "object") {
		throw Object.assign(new Error(`images[${index}].original must be an image object`), { status: 400 })
	}
	if (options.requireData === false && typeof original.data !== "string") return undefined
	if (typeof original.data !== "string" || original.data.length === 0) {
		throw Object.assign(new Error(`images[${index}].original.data is required`), { status: 400 })
	}
	if (!validImageMimeTypes.has(original.mimeType)) {
		throw Object.assign(new Error(`images[${index}].original.mimeType must be PNG, JPEG, GIF, or WebP`), { status: 400 })
	}
	const widthPx = Number(original.widthPx)
	const heightPx = Number(original.heightPx)
	return {
		data: original.data,
		mimeType: original.mimeType,
		...(Number.isFinite(widthPx) && widthPx > 0 ? { widthPx } : {}),
		...(Number.isFinite(heightPx) && heightPx > 0 ? { heightPx } : {}),
	}
}

function promptImagesFromBody(body) {
	if (body.images === undefined) return []
	if (!Array.isArray(body.images)) throw Object.assign(new Error("images must be an array"), { status: 400 })
	return body.images.map((image, index) => {
		if (!image || typeof image !== "object" || image.type !== "image") {
			throw Object.assign(new Error(`images[${index}] must be an image content block`), { status: 400 })
		}
		const hasInlineData = typeof image.data === "string" && image.data.length > 0
		const hasAttachmentRef = typeof image.attachmentId === "string" && image.attachmentId.length > 0
		if (!hasInlineData && !hasAttachmentRef) {
			throw Object.assign(new Error(`images[${index}].data is required`), { status: 400 })
		}
		if (hasInlineData && !validImageMimeTypes.has(image.mimeType)) {
			throw Object.assign(new Error(`images[${index}].mimeType must be PNG, JPEG, GIF, or WebP`), { status: 400 })
		}
		if (!hasInlineData && image.mimeType !== undefined && !validImageMimeTypes.has(image.mimeType)) {
			throw Object.assign(new Error(`images[${index}].mimeType must be PNG, JPEG, GIF, or WebP`), { status: 400 })
		}
		if (image.detail !== undefined && image.detail !== "high" && image.detail !== "original") {
			throw Object.assign(new Error(`images[${index}].detail must be high or original`), { status: 400 })
		}
		const widthPx = Number(image.widthPx)
		const heightPx = Number(image.heightPx)
		const original = promptImageOriginalFromBody(image, index, { requireData: hasInlineData })
		return {
			type: "image",
			...(hasInlineData ? { data: image.data } : {}),
			...(hasAttachmentRef ? { attachmentId: image.attachmentId } : {}),
			...(typeof image.attachmentSessionId === "string" && image.attachmentSessionId ? { attachmentSessionId: image.attachmentSessionId } : {}),
			...(Number.isInteger(Number(image.imageNumber)) && Number(image.imageNumber) > 0 ? { imageNumber: Number(image.imageNumber) } : {}),
			...(image.mimeType ? { mimeType: image.mimeType } : {}),
			...(image.detail ? { detail: image.detail } : {}),
			...(Number.isFinite(widthPx) && widthPx > 0 ? { widthPx } : {}),
			...(Number.isFinite(heightPx) && heightPx > 0 ? { heightPx } : {}),
			...(original ? { original } : {}),
		}
	})
}

const apiPath = (prefix, path) => {
	if (!prefix) return path
	if (path === "/") return prefix
	return `${prefix}${path}`
}

const sessionId = (context) => context.req.param("id") ?? ""

const attachmentId = (context) => context.req.param("attachmentId") ?? ""

const urlFor = (context) => new URL(context.req.url)

const attachmentVariantFromQuery = (context) =>
	urlFor(context).searchParams.get("variant") === SESSION_ATTACHMENT_VARIANT_ORIGINAL
		? SESSION_ATTACHMENT_VARIANT_ORIGINAL
		: SESSION_ATTACHMENT_VARIANT_DISPLAY

const snapshotOptions = (options) => ({
	...(options.includeSessionsInSnapshots ? { includeSessions: true } : {}),
	...(options.includeContextMessagesInSnapshots ? { includeContextMessages: true } : {}),
})

const cwdFilter = (context) => urlFor(context).searchParams.get("cwd") || undefined

const includeDeletedSessions = (context) => urlFor(context).searchParams.get("includeDeleted") === "1"

const includeHiddenSessions = (context) => urlFor(context).searchParams.get("includeHidden") === "1"

const contextCwdFilter = (context) => urlFor(context).searchParams.get("contextCwd") || cwdFilter(context)

const clientContextResponse = (cwd, initialRoute = undefined) => {
	const overviewCwd = overviewDirectoryStateKey(cwd)
	return {
		cwd: overviewCwd,
		overviewDirectoryFilterKey: overviewDirectoryFilterUiStateKey(overviewCwd),
		...(initialRoute ? { initialRoute } : {}),
	}
}

const entryIdFromBody = (body) => {
	const value = body.entryId ?? body.id
	return typeof value === "string" ? value : String(value ?? "")
}

const optionalEntryIdFromBody = (body) => {
	const source = body && typeof body === "object" ? body : {}
	const key = hasOwn(source, "entryId") ? "entryId" : hasOwn(source, "id") ? "id" : ""
	if (!key) return undefined
	const value = source[key]
	if (typeof value !== "string" || !value) throw Object.assign(new Error("valid branch entryId is required"), { status: 400 })
	return value
}

const settingsResponse = async (settings) => {
	const resolved = await settings
	return { settings: resolved, overview: { modelStatus: overviewModelStatus(resolved) } }
}

const redactedSettingsResponse = (response) => {
	const settings = response?.settings
	if (!settings || typeof settings !== "object") return response
	return {
		...response,
		settings: redactedSettings(settings),
	}
}

function cleanUiStateKey(value) {
	const key = typeof value === "string" ? value : ""
	if (!key) throw Object.assign(new Error("ui state key is required"), { status: 400 })
	if (key.length > 2048) throw Object.assign(new Error("ui state key is too long"), { status: 400 })
	return key
}

function uiStateResponse(key, value) {
	const found = value !== undefined
	return {
		key,
		found,
		...(found ? { value } : {}),
	}
}

/**
 * @param {string} ref
 * @returns {Promise<import("./settings.js").Settings>}
 */
async function updateDefaultModel(ref) {
	const current = await loadSettings()
	const currentProvider = parseModelRef(current.defaultModel).provider
	return updateSettings({ defaultModel: canonicalModelRef(ref, { provider: currentProvider, providers: current.providers }) })
}

const snapshotCursor = (snapshot) => {
	const cursor = {}
	if (typeof snapshot?.cursorGeneration === "string" && snapshot.cursorGeneration) cursor.cursorGeneration = snapshot.cursorGeneration
	if (typeof snapshot?.seq === "number") cursor.seq = snapshot.seq
	if (typeof snapshot?.viewEpoch === "number") cursor.viewEpoch = snapshot.viewEpoch
	return Object.keys(cursor).length > 0 ? cursor : undefined
}

const invalidation = (sessionId, scopes, snapshot = undefined) => {
	const cursor = snapshotCursor(snapshot)
	return {
		sessionId,
		scopes,
		...(cursor ? { cursor } : {}),
	}
}

const mutationResult = (sessionId, data = {}, scopes = ["session"]) => {
	const {
		invalidates,
		ok: _ok,
		sessionId: dataSessionId,
		sessions: _sessions,
		snapshot,
		...commandResult
	} = data ?? {}
	const resolvedSessionId = dataSessionId || snapshot?.sessionId || sessionId
	return {
		ok: true,
		...commandResult,
		...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
		invalidates: Array.isArray(invalidates) ? invalidates : (resolvedSessionId ? [invalidation(resolvedSessionId, scopes, snapshot)] : []),
	}
}

export function createManagerClientApi(options) {
	const { manager } = options
	const sessionListCwd = options.sessionListCwd
	const resolveSessionId = options.resolveSessionId || (async (id) => {
		if (typeof manager.sessionStatus === "function") await manager.sessionStatus(id)
		return id
	})
	const uiStateStore = options.uiStateStore ?? options.db ?? manager.db
	const currentSettings = () => options.getSettings ? options.getSettings() : loadSettings()
	const setSettings = options.setSettings || (async (body) => {
		if (hasOwn(body, "model")) {
			const model = typeof body.model === "string" ? body.model.trim() : ""
			if (!model) throw Object.assign(new Error("model is required"), { status: 400 })
			if (options.setDefaultModel) return options.setDefaultModel(model)
			return updateDefaultModel(model)
		}
		if (hasOwn(body, "thinkingLevel")) {
			const level = normalizeReasoningLevel(typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : "")
			if (!level) throw Object.assign(new Error("valid reasoning level is required"), { status: 400 })
			if (options.setDefaultReasoning) return options.setDefaultReasoning(level)
			return updateSetting("thinkingLevel", /** @type {any} */ (level))
		}
		throw Object.assign(new Error("no supported settings provided"), { status: 400 })
	})
	const snapshot = (id, options = {}) => manager.snapshot(id || manager.initialSessionId, options)
	const runtimeFor = (id) => manager.getRuntime(id)
	const resolveInitialRoute = async () => options.initialRoute || await webInitialRouteFromSettings(await currentSettings(), {
		workspaceRoot: manager.workspaceRoot,
		resolveDirectory: (path) => manager.workspace.paths.resolveDirectory(path, "Web initial route directory"),
	})
	const resolveOverviewCwd = async (cwd = undefined, fallback = options.cwd) => {
		const requested = cwd ?? sessionListCwd ?? fallback
		if (typeof manager.overviewCwd === "function") return manager.overviewCwd(requested)
		return requested
	}
	const resolveSessionListCwd = async (cwd = undefined) => {
		const requested = cwd ?? sessionListCwd
		return requested === undefined ? undefined : await resolveOverviewCwd(requested)
	}
	const availableModels = async () => availableModelEntries(await currentSettings())
	const modelChoices = (entries) => entries.map(modelChoice)
	const overviewProject = async (cwd = undefined) => manager.overviewProject(await resolveOverviewCwd(cwd)).catch((err) => {
		if (err?.status) throw err
		return undefined
	})

	return {
		clientContext: async (cwd = undefined) => {
			const initialRoute = await resolveInitialRoute()
			const requestedCwd = cwd ?? webInitialRouteCwd(initialRoute)
			const context = clientContextResponse(await resolveOverviewCwd(requestedCwd, options.cwd), initialRoute)
			return { ...context, project: await overviewProject(context.cwd) }
		},
		sessions: async (cwd, options = {}) => manager.sessions(await resolveSessionListCwd(cwd), { includeDeleted: options.includeDeleted === true, includeHidden: options.includeHidden === true }),
		sessionListEntry: async (id, cwd, options = {}) => manager.sessionListEntry(id, await resolveSessionListCwd(cwd), { includeDeleted: options.includeDeleted === true, includeHidden: options.includeHidden === true }),
		sessionsStatus: async (cwd, options = {}) => manager.sessionsStatus(await resolveSessionListCwd(cwd), { includeDeleted: options.includeDeleted === true, includeHidden: options.includeHidden === true }),
		ensureProjectMaintenance: async (projectDir, options = {}) => ({
			ok: true,
			maintenance: await manager.ensureProjectMaintenanceSession(projectDir, {
				bestEffortPrompt: true,
				runPrompt: options.runPrompt !== false,
				onlyIfNeeded: options.onlyIfNeeded === true,
				waitForCompletion: options.waitForCompletion === true,
			}),
		}),
		projectPreviews: async (projectDir, previewOptions = {}) => manager.projectPreviewList(projectDir, previewOptions),
		resolveSessionId: async (id) => {
			const requestedSessionId = typeof id === "string" ? id.trim() : ""
			if (!requestedSessionId) throw Object.assign(new Error("session id is required"), { status: 400 })
			const sessionId = await resolveSessionId(requestedSessionId)
			if (!sessionId) throw Object.assign(new Error(`Session not found: ${requestedSessionId}`), { status: 404 })
			return { sessionId, requestedSessionId, exact: sessionId === requestedSessionId }
		},
		sessionPreviews: async (id) => manager.sessionPreviewList(id || manager.initialSessionId),
		resolvePreviewUrl: async (url) => manager.resolvePreviewUrl(url),
		resolvePreviewSource: async (request) => manager.resolvePreviewSource(request),
		previewLog: async (url) => manager.previewLogForUrl(url),
		previewSource: async (url) => manager.previewSourceForUrl(url),
		overviewProject,
		snapshot,
		sessionStatus: (id) => manager.sessionStatus(id || manager.initialSessionId),
		contextReport: (id) => manager.contextReport(id || manager.initialSessionId),
		systemReport: (id) => manager.systemReport(id || manager.initialSessionId),
		worktrees: (id) => manager.worktrees(id || manager.initialSessionId),

		models: async () => {
			const settings = await currentSettings()
			return {
				models: modelChoices(await availableModelEntries(settings)),
				currentModel: settings.defaultModel ? canonicalModelRef(settings.defaultModel, { providers: settings.providers }) : "",
			}
		},
		sessionModels: async (id) => {
			const runtime = await runtimeFor(id)
			const currentModel = runtime.agent.state.model
			return {
				models: modelChoices(eligibleSessionModelEntries(currentModel, await availableModels())),
				currentModel: modelRef(currentModel),
			}
		},
		getSettings: () => settingsResponse(currentSettings()),
		setSettings: async (body) => ({ ok: true, settings: await setSettings(body) }),
		getUiState: async (key) => {
			const cleanedKey = cleanUiStateKey(key)
			return uiStateResponse(cleanedKey, uiStateStore.getUiState(cleanedKey))
		},
		setUiState: async (key, value) => {
			const cleanedKey = cleanUiStateKey(key)
			return { ok: true, ...uiStateResponse(cleanedKey, uiStateStore.setUiState(cleanedKey, value)) }
		},
		deleteUiState: async (key) => {
			const cleanedKey = cleanUiStateKey(key)
			return { ok: true, key: cleanedKey, deleted: uiStateStore.deleteUiState(cleanedKey) }
		},
		attachmentContent: async (id, attachmentId, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY) => {
			const store = options.db ?? manager.db
			const content = store?.getAttachmentVariant?.(id, attachmentId, variant)
			if (!content) throw Object.assign(new Error("Attachment not found"), { status: 404 })
			return content
		},
		createSession: async (body) => {
			const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : sessionListCwd || options.cwd
			const prompt = typeof body.prompt === "string" ? body.prompt : ""
			const images = promptImagesFromBody(body)
			const runtime = await manager.createSession(cwd)
			if (prompt.trim() || images.length > 0) {
				const submission = await runtime.beginPrompt(prompt, body.streamingBehavior, images)
				runtime.observePromptAccepted(submission)
			}
			return mutationResult(runtime.sessionId, {}, ["session", "sessions"])
		},
		prompt: async (id, body) => {
			const message = typeof body.message === "string" ? body.message : ""
			const images = promptImagesFromBody(body)
			if (!message.trim() && images.length === 0) throw Object.assign(new Error("message is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			const submission = await runtime.beginPrompt(message, body.streamingBehavior, images)
			if (submission.streamingBehavior) runtime.observePromptAccepted(submission)
			else await runtime.waitForPromptAccepted(submission)
			await manager.setPromptDraft(id, "", { clientId: body.draftClientId, clientSeq: body.draftClientSeq })
			return mutationResult(id)
		},
		draft: async (id, body) => ({
			ok: true,
			draft: await manager.setPromptDraft(id, typeof body.text === "string" ? body.text : "", { clientId: body.clientId, clientSeq: body.clientSeq }),
		}),
		continueRun: async (id) => {
			const runtime = await runtimeFor(id)
			await runtime.continueRun()
			return mutationResult(id)
		},
		abort: async (id) => {
			const runtime = await runtimeFor(id)
			await runtime.abort()
			return mutationResult(id)
		},
		cancelPrompt: async (id, body = {}) => {
			const response = await (await runtimeFor(id)).cancelCurrentPrompt({
				restoreCurrentPrompt: body.restoreCurrentPrompt !== false,
			})
			return mutationResult(id, response)
		},
		markCompleted: async (id) => {
			const metadata = await manager.markCompleted(id)
			return mutationResult(id, { metadata }, ["session", "sessions"])
		},
		markDeferred: async (id) => {
			const metadata = await manager.markDeferred(id)
			return mutationResult(id, { metadata }, ["session", "sessions"])
		},
		markReadyForReview: async (id) => {
			const metadata = await manager.markReadyForReview(id)
			return mutationResult(id, { metadata }, ["session", "sessions"])
		},
		deleteStoppedSession: async (id) => {
			await manager.deleteStoppedSession(id)
			return mutationResult(id, {}, ["session", "sessions"])
		},
		restoreDeletedSession: async (id) => {
			await manager.restoreDeletedSession(id)
			return mutationResult(id, {}, ["session", "sessions"])
		},
		setReasoning: async (id, body) => {
			const level = normalizeReasoningLevel(typeof body.level === "string" ? body.level.trim() : "")
			if (!level) throw Object.assign(new Error("valid reasoning level is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			runtime.agent.state.thinkingLevel = /** @type {any} */ (level)
			await runtime.session.appendConfigPatch({ thinkingLevel: runtime.agent.state.thinkingLevel })
			await manager.invalidateSnapshot(id)
			return mutationResult(id)
		},
		setModel: async (id, body) => {
			const requested = typeof body.model === "string" ? body.model.trim() : ""
			if (!requested) throw Object.assign(new Error("model is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			const currentModel = runtime.agent.state.model
			const entries = await availableModels()
			const candidate = entries.find((entry) => modelRef(entry) === requested)
				?? entries.find((entry) => modelEntryMatches(entry, requested, currentModel.provider))
			if (!candidate) throw Object.assign(new Error(`Model is not available: ${requested}`), { status: 400 })
			const eligibilityError = sessionModelEligibilityError(currentModel, candidate)
			if (eligibilityError) throw Object.assign(new Error(eligibilityError), { status: 400 })
			const result = await runtime.setModel(buildModel(candidate))
			return mutationResult(id, {
				...result,
				model: modelChoice(candidate),
			})
		},
		setFast: async (id, body) => {
			const runtime = await runtimeFor(id)
			const message = await runtime.setFastMode(typeof body.args === "string" ? body.args : "")
			await manager.invalidateSnapshot(id)
			return mutationResult(id, { message })
		},
		compact: async (id) => {
			const runtime = await runtimeFor(id)
			const result = await runtime.compact()
			await manager.invalidateSnapshot(id)
			return mutationResult(id, { result })
		},
		bash: async (id, body) => {
			const shortcut = parseBashShortcut(typeof body.text === "string" ? body.text : "")
			if (!shortcut) throw Object.assign(new Error("valid bash shortcut is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			const result = await runAgentBashShortcut(runtime.agent, shortcut.command, { excludeFromContext: shortcut.excludeFromContext })
			await recordBashShortcut(runtime.agent, runtime.session, result)
			await manager.setPromptDraft(id, "", { clientId: body.draftClientId, clientSeq: body.draftClientSeq })
			await manager.invalidateSnapshot(id)
			return mutationResult(id, { result })
		},
		rewindTargets: async (id) => ({ targets: (await runtimeFor(id)).rewindTargets() }),
		rewind: async (id, body) => {
			const runtime = await runtimeFor(id)
			const entryId = entryIdFromBody(body)
			const targetKind = body.kind === "leaf" || body.targetKind === "leaf" ? "leaf" : body.targetKind
			if (targetKind === "leaf") {
				await runtime.switchBranchTip(entryId)
				return mutationResult(id, { text: "", editorText: "", targetKind: "leaf" })
			}
			const text = await runtime.rewind(entryId, {
				summary: body.summary === true,
				restoreFiles: body.restoreFiles === true,
				restoreConversation: body.restoreConversation !== false,
			})
			return mutationResult(id, { text, editorText: text, targetKind: "message" })
		},
		branch: async (id, body = {}) => {
			const runtime = await manager.branchSession(id, {
				cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined,
				entryId: optionalEntryIdFromBody(body),
				restoreDraft: body.restoreDraft !== false,
			})
			return mutationResult(runtime.sessionId, {}, ["session", "sessions"])
		},
		spawnSubSession: async (id, body = {}) => {
			const item = await manager.spawnSubSession(id, {
				task: body.task,
				name: body.name,
				forkTurns: body.forkTurns,
				origin: body.origin === "agent" ? "agent" : "user",
				cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined,
			})
			return mutationResult(item.childSessionId, { subSession: item }, ["session", "sessions"])
		},
		subSessions: async (id, body = {}) => ({ agents: await manager.listSubSessions(id, { includeClosed: body.includeClosed === true }) }),
		waitSubSession: async (id, body = {}) => {
			const item = await manager.waitSubSession(id, body)
			return mutationResult(item.childSessionId, { subSession: item }, ["session"])
		},
		followupSubSession: async (id, body = {}) => {
			const item = await manager.followupSubSession(id, body)
			return mutationResult(item.childSessionId, { subSession: item }, ["session"])
		},
		resumeSubSession: async (id, body = {}) => {
			const item = await manager.resumeSubSession(id, body)
			return mutationResult(item.childSessionId, { subSession: item }, ["session", "sessions"])
		},
		closeSubSession: async (id, body = {}) => {
			const item = await manager.closeSubSession(id, body)
			return mutationResult(item.childSessionId, { subSession: item }, ["session", "sessions"])
		},
	}
}

export function createServiceClientApi(options) {
	const { client } = options
	let initialSessionId = options.initialSessionId || client.initialSessionId || ""
	const ensureInitialSessionId = async () => {
		if (initialSessionId) return initialSessionId
		const list = await client.sessions()
		if (list[0]?.id) {
			initialSessionId = list[0].id
			return initialSessionId
		}
		const created = await client.createSession()
		initialSessionId = created.sessionId || created.snapshot?.sessionId
		return initialSessionId
	}
	const snapshot = async (id, snapshotOptions = {}) => client.snapshot(id || await ensureInitialSessionId(), snapshotOptions)
	const overviewProject = (cwd = undefined) => {
		const path = cwd ?? options.cwd
		if (typeof client.overviewProject === "function") return client.overviewProject(path).catch(() => undefined)
		if (client.workspace?.project?.info) return client.workspace.project.info(path).catch(() => undefined)
		return Promise.resolve(undefined)
	}
	const resolveInitialRoute = async () => options.initialRoute || await webInitialRouteFromSettings((await client.getSettings())?.settings, {
		workspaceRoot: options.workspaceRoot,
		...(client.workspace?.paths?.resolveDirectory ? {
			resolveDirectory: (path) => client.workspace.paths.resolveDirectory(path, "Web initial route directory"),
			home: "",
		} : {}),
	})

	return {
		clientContext: async (cwd = undefined) => {
			const initialRoute = await resolveInitialRoute()
			const requestedCwd = cwd ?? webInitialRouteCwd(initialRoute) ?? options.cwd
			if (typeof client.clientContext === "function") {
				const context = await client.clientContext(requestedCwd)
				return { ...context, ...(initialRoute ? { initialRoute } : {}) }
			}
			const context = clientContextResponse(requestedCwd, initialRoute)
			return { ...context, project: await overviewProject(context.cwd) }
		},
		sessions: (cwd, options = {}) => client.sessions(cwd, options),
		sessionsStatus: (cwd, options = {}) => client.sessionsStatus(cwd, options),
		ensureProjectMaintenance: (projectDir, options = {}) => client.ensureProjectMaintenance(projectDir, options),
		projectPreviews: (projectDir, previewOptions = {}) => client.projectPreviews(projectDir, previewOptions),
		sessionPreviews: async (id) => client.sessionPreviews(id || await ensureInitialSessionId()),
		resolveSessionId: async (id) => {
			if (typeof client.resolveSessionId === "function") return client.resolveSessionId(id)
			const requestedSessionId = typeof id === "string" ? id.trim() : ""
			if (!requestedSessionId) throw Object.assign(new Error("session id is required"), { status: 400 })
			return { sessionId: requestedSessionId, requestedSessionId, exact: true }
		},
		resolvePreviewUrl: (url) => client.resolvePreviewUrl(url),
		resolvePreviewSource: (request) => client.resolvePreviewSource(request),
		previewLog: (url) => client.previewLog(url),
		previewSource: (url) => client.previewSource(url),
		overviewProject,
		snapshot,
		sessionStatus: async (id) => client.sessionStatus(id || await ensureInitialSessionId()),
		contextReport: async (id) => client.contextReport(id || await ensureInitialSessionId()),
		systemReport: async (id) => client.systemReport(id || await ensureInitialSessionId()),
		worktrees: async (id) => client.worktrees(id || await ensureInitialSessionId()),
		models: () => client.models(),
		sessionModels: (id) => client.sessionModels(id),
		getSettings: () => client.getSettings(),
		setSettings: async (body) => {
			if (hasOwn(body, "model")) {
				const model = typeof body.model === "string" ? body.model.trim() : ""
				if (!model) throw Object.assign(new Error("model is required"), { status: 400 })
				return client.setDefaultModel(model)
			}
			if (hasOwn(body, "thinkingLevel")) {
				const level = normalizeReasoningLevel(typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : "")
				if (!level) throw Object.assign(new Error("valid reasoning level is required"), { status: 400 })
				if (!client.setDefaultReasoning) throw Object.assign(new Error("reasoning settings are not supported by this service client"), { status: 400 })
				return client.setDefaultReasoning(level)
			}
			throw Object.assign(new Error("no supported settings provided"), { status: 400 })
		},
		getUiState: async (key) => {
			const cleanedKey = cleanUiStateKey(key)
			const value = await client.getUiState(cleanedKey)
			return uiStateResponse(cleanedKey, value)
		},
		setUiState: async (key, value) => {
			const cleanedKey = cleanUiStateKey(key)
			return client.setUiState(cleanedKey, value)
		},
		deleteUiState: async (key) => {
			const cleanedKey = cleanUiStateKey(key)
			return client.deleteUiState(cleanedKey)
		},
		attachmentContent: async (id, attachmentId, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY) => {
			if (typeof client.attachmentContent !== "function") throw Object.assign(new Error("attachment content is not supported by this service client"), { status: 501 })
			const content = await client.attachmentContent(id, attachmentId, variant)
			if (!content) throw Object.assign(new Error("Attachment not found"), { status: 404 })
			return content
		},
		createSession: async (body) => {
			const images = promptImagesFromBody(body)
			const created = await client.createSession({ prompt: body.prompt, cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : options.cwd, images })
			const id = created.sessionId || created.snapshot?.sessionId
			if (id && !initialSessionId) initialSessionId = id
			return mutationResult(id, created, ["session", "sessions"])
		},
		prompt: async (id, body) => {
			const message = typeof body.message === "string" ? body.message : ""
			const images = promptImagesFromBody(body)
			if (!message.trim() && images.length === 0) throw Object.assign(new Error("message is required"), { status: 400 })
			const response = await client.prompt(id, message, body.streamingBehavior, {
				draftClientId: body.draftClientId,
				draftClientSeq: body.draftClientSeq,
				images,
			})
			return mutationResult(id, response)
		},
		draft: (id, body) => client.setPromptDraft(id, typeof body.text === "string" ? body.text : "", { clientId: body.clientId, clientSeq: body.clientSeq }),
		continueRun: async (id) => {
			const response = await client.continueRun(id)
			return mutationResult(id, response)
		},
		abort: async (id) => {
			const response = await client.abort(id)
			return mutationResult(id, response)
		},
		cancelPrompt: async (id, body = {}) => {
			const response = await client.cancelPrompt(id, {
				restoreCurrentPrompt: body.restoreCurrentPrompt !== false,
			})
			return mutationResult(id, response)
		},
		markCompleted: async (id) => mutationResult(id, await client.markCompleted(id), ["session", "sessions"]),
		markDeferred: async (id) => mutationResult(id, await client.markDeferred(id), ["session", "sessions"]),
		markReadyForReview: async (id) => mutationResult(id, await client.markReadyForReview(id), ["session", "sessions"]),
		deleteStoppedSession: async (id) => mutationResult(id, await client.deleteSession(id), ["session", "sessions"]),
		restoreDeletedSession: async (id) => mutationResult(id, await client.restoreSession(id), ["session", "sessions"]),
		setReasoning: async (id, body) => {
			const response = await client.setReasoning(id, body.level)
			return mutationResult(id, response)
		},
		setModel: async (id, body) => {
			const response = await client.setModel(id, body.model)
			return mutationResult(id, response)
		},
		setFast: async (id, body) => {
			const response = await client.setFast(id, typeof body.args === "string" ? body.args : "")
			return mutationResult(id, response)
		},
		compact: async (id) => {
			const response = await client.compact(id)
			return mutationResult(id, response)
		},
		bash: async (id, body) => {
			const response = await client.bash(id, typeof body.text === "string" ? body.text : "", {
				draftClientId: body.draftClientId,
				draftClientSeq: body.draftClientSeq,
			})
			return mutationResult(id, response)
		},
		rewindTargets: async (id) => ({ targets: await client.rewindTargets(id) }),
		rewind: async (id, body) => {
			const targetKind = body.kind === "leaf" || body.targetKind === "leaf" ? "leaf" : body.targetKind
			const response = await client.rewind(id, entryIdFromBody(body), {
				targetKind,
				summary: body.summary === true,
				restoreFiles: body.restoreFiles === true,
				restoreConversation: body.restoreConversation !== false,
			})
			const text = response.text ?? response.editorText ?? ""
			return mutationResult(id, { ...response, text, editorText: text, targetKind: response.targetKind ?? targetKind ?? "message" })
		},
		branch: async (id, body = {}) => {
			const response = await client.branchSession(id, {
				cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined,
				entryId: optionalEntryIdFromBody(body),
				restoreDraft: body.restoreDraft !== false,
			})
			const nextId = response.sessionId || response.snapshot?.sessionId
			return mutationResult(nextId, response, ["session", "sessions"])
		},
		spawnSubSession: async (id, body = {}) => {
			const response = await client.spawnSubSession(id, body)
			const nextId = response.subSession?.childSessionId || response.sessionId
			return mutationResult(nextId, response, ["session", "sessions"])
		},
		subSessions: async (id, body = {}) => client.subSessions(id, body),
		waitSubSession: async (id, body = {}) => {
			const response = await client.waitSubSession(id, body)
			const nextId = response.subSession?.childSessionId || response.sessionId || id
			return mutationResult(nextId, response, ["session"])
		},
		followupSubSession: async (id, body = {}) => {
			const response = await client.followupSubSession(id, body)
			const nextId = response.subSession?.childSessionId || response.sessionId || id
			return mutationResult(nextId, response, ["session"])
		},
		resumeSubSession: async (id, body = {}) => {
			const response = await client.resumeSubSession(id, body)
			const nextId = response.subSession?.childSessionId || response.sessionId || id
			return mutationResult(nextId, response, ["session", "sessions"])
		},
		closeSubSession: async (id, body = {}) => {
			const response = await client.closeSubSession(id, body)
			const nextId = response.subSession?.childSessionId || response.sessionId || id
			return mutationResult(nextId, response, ["session", "sessions"])
		},
	}
}

export function registerClientApiRoutes(app, api, options = {}) {
	const prefix = options.prefix || ""
	const path = (suffix) => apiPath(prefix, suffix)
	const routeSnapshotOptions = () => snapshotOptions(options)
	const routeSnapshotOptionsFromQuery = (context) => {
		const params = urlFor(context).searchParams
		const defaults = routeSnapshotOptions()
		return {
			...defaults,
			includeSessions: params.get("includeSessions") === "1" || defaults.includeSessions === true,
			includeContextMessages: params.get("includeContextMessages") === "1" || defaults.includeContextMessages === true,
		}
	}

	const safe = (handler) => async (context) => {
		try {
			return await handler(context)
		} catch (err) {
			return routeError(err)
		}
	}

	app.get(path("/client-context"), safe(async (context) => json(await api.clientContext(cwdFilter(context)))))
	if (options.includeSnapshotRoute) {
		app.get(path("/snapshot"), safe(async (context) => json(await api.snapshot(urlFor(context).searchParams.get("sessionId") || undefined, routeSnapshotOptionsFromQuery(context)))))
	}
	app.get(path("/sessions"), safe(async (context) => {
		const cwd = cwdFilter(context)
		return json({ sessions: await api.sessions(cwd, { includeDeleted: includeDeletedSessions(context), includeHidden: includeHiddenSessions(context) }), project: await api.overviewProject?.(cwd) })
	}))
	app.get(path("/sessions/status"), safe(async (context) => json(await api.sessionsStatus(cwdFilter(context), { includeDeleted: includeDeletedSessions(context), includeHidden: includeHiddenSessions(context) }))))
	app.post(path("/projects/maintenance"), safe(async (context) => {
		const body = await jsonBody(context)
		const projectDir = typeof body.projectDir === "string" && body.projectDir ? body.projectDir : body.path
		if (typeof projectDir !== "string" || !projectDir) throw Object.assign(new Error("projectDir is required"), { status: 400 })
		if (typeof api.ensureProjectMaintenance !== "function") throw Object.assign(new Error("project maintenance is not supported"), { status: 501 })
		return json(await api.ensureProjectMaintenance(projectDir, {
			runPrompt: body.runPrompt !== false,
			onlyIfNeeded: body.onlyIfNeeded === true,
			waitForCompletion: body.waitForCompletion === true,
		}), 201)
	}))
	app.get(path("/projects/previews"), safe(async (context) => {
		const searchParams = urlFor(context).searchParams
		const projectDir = searchParams.get("projectDir") || undefined
		const sessionId = searchParams.get("sessionId") || undefined
		if (typeof projectDir !== "string" || !projectDir) throw Object.assign(new Error("projectDir is required"), { status: 400 })
		if (typeof api.projectPreviews !== "function") throw Object.assign(new Error("project previews are not supported"), { status: 501 })
		return json(await api.projectPreviews(projectDir, { sessionId }))
	}))
	app.get(path("/previews/resolve"), safe(async (context) => {
		const previewUrl = urlFor(context).searchParams.get("url") || undefined
		if (typeof previewUrl !== "string" || !previewUrl) throw Object.assign(new Error("url is required"), { status: 400 })
		if (typeof api.resolvePreviewUrl !== "function") throw Object.assign(new Error("preview resolution is not supported"), { status: 501 })
		return json(await api.resolvePreviewUrl(previewUrl))
	}))
	app.get(path("/previews/resolve-source"), safe(async (context) => {
		const url = urlFor(context)
		const sourcePath = url.searchParams.get("path") || undefined
		if (typeof sourcePath !== "string" || !sourcePath) throw Object.assign(new Error("path is required"), { status: 400 })
		if (typeof api.resolvePreviewSource !== "function") throw Object.assign(new Error("preview source resolution is not supported"), { status: 501 })
		return json(await api.resolvePreviewSource({
			path: sourcePath,
			projectDir: url.searchParams.get("projectDir") || undefined,
			sessionId: url.searchParams.get("sessionId") || undefined,
		}))
	}))
	app.get(path("/previews/log"), safe(async (context) => {
		const previewUrl = urlFor(context).searchParams.get("url") || undefined
		if (typeof previewUrl !== "string" || !previewUrl) throw Object.assign(new Error("url is required"), { status: 400 })
		if (typeof api.previewLog !== "function") throw Object.assign(new Error("preview logs are not supported"), { status: 501 })
		return json(await api.previewLog(previewUrl))
	}))
	app.get(path("/previews/source"), safe(async (context) => {
		const previewUrl = urlFor(context).searchParams.get("url") || undefined
		if (typeof previewUrl !== "string" || !previewUrl) throw Object.assign(new Error("url is required"), { status: 400 })
		if (typeof api.previewSource !== "function") throw Object.assign(new Error("preview sources are not supported"), { status: 501 })
		return json(await api.previewSource(previewUrl))
	}))
	app.post(path("/sessions"), safe(async (context) => json(await api.createSession(await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.get(path("/models"), safe(async () => json(await api.models())))
	app.get(path("/settings"), safe(async () => {
		const response = await api.getSettings()
		return json(options.redactSettings ? redactedSettingsResponse(response) : response)
	}))
	app.post(path("/settings"), safe(async (context) => {
		const response = await api.setSettings(await jsonBody(context))
		return json(options.redactSettings ? redactedSettingsResponse(response) : response)
	}))
	app.get(path("/ui-state"), safe(async (context) => json(await api.getUiState(cleanUiStateKey(urlFor(context).searchParams.get("key"))))))
	app.post(path("/ui-state"), safe(async (context) => {
		const body = await jsonBody(context)
		const key = cleanUiStateKey(body.key ?? urlFor(context).searchParams.get("key"))
		if (!hasOwn(body, "value")) throw Object.assign(new Error("ui state value is required"), { status: 400 })
		return json(await api.setUiState(key, body.value))
	}))
	app.delete(path("/ui-state"), safe(async (context) => json(await api.deleteUiState(cleanUiStateKey(urlFor(context).searchParams.get("key"))))))
	if (options.includeCommands) app.get(path("/commands"), () => json({
		commands: WEB_COMMANDS,
		overviewCommands: WEB_OVERVIEW_COMMANDS,
		chatCommands: WEB_CHAT_COMMANDS,
	}))

	app.get(path("/sessions/resolve"), safe(async (context) => {
		if (typeof api.resolveSessionId !== "function") throw Object.assign(new Error("session id resolution is not supported"), { status: 501 })
		return json(await api.resolveSessionId(urlFor(context).searchParams.get("id") || ""))
	}))
	const snapshotById = safe(async (context) => json(await api.snapshot(sessionId(context), routeSnapshotOptionsFromQuery(context))))
	app.get(path("/sessions/:id/status"), safe(async (context) => json(await api.sessionStatus(sessionId(context)))))
	app.get(path("/sessions/:id/previews"), safe(async (context) => {
		if (typeof api.sessionPreviews !== "function") throw Object.assign(new Error("session previews are not supported"), { status: 501 })
		return json(await api.sessionPreviews(sessionId(context)))
	}))
	app.get(path("/sessions/:id"), snapshotById)
	app.get(path("/sessions/:id/snapshot"), snapshotById)
	app.get(path("/sessions/:id/context-report"), safe(async (context) => json({ lines: await api.contextReport(sessionId(context)) })))
	app.get(path("/sessions/:id/system-report"), safe(async (context) => json({ lines: await api.systemReport(sessionId(context)) })))
	app.get(path("/sessions/:id/worktrees"), safe(async (context) => json({ worktrees: await api.worktrees(sessionId(context)) })))
	app.get(path("/sessions/:id/attachments/:attachmentId/content"), safe(async (context) => {
		if (typeof api.attachmentContent !== "function") throw Object.assign(new Error("attachment content is not supported"), { status: 501 })
		const content = await api.attachmentContent(sessionId(context), attachmentId(context), attachmentVariantFromQuery(context))
		return bytes(content.data, content.mimeType)
	}))
	app.post(path("/sessions/:id/prompt"), safe(async (context) => json(await api.prompt(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/draft"), safe(async (context) => json(await api.draft(sessionId(context), await jsonBody(context)))))
	app.post(path("/sessions/:id/continue"), safe(async (context) => json(await api.continueRun(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/abort"), safe(async (context) => json(await api.abort(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/cancel-prompt"), safe(async (context) => json(await api.cancelPrompt(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/complete"), safe(async (context) => json(await api.markCompleted(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/defer"), safe(async (context) => json(await api.markDeferred(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/review"), safe(async (context) => json(await api.markReadyForReview(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/delete"), safe(async (context) => json(await api.deleteStoppedSession(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/restore"), safe(async (context) => json(await api.restoreDeletedSession(sessionId(context), { cwd: cwdFilter(context) }))))
	app.get(path("/sessions/:id/models"), safe(async (context) => json(await api.sessionModels(sessionId(context)))))
	app.post(path("/sessions/:id/model"), safe(async (context) => json(await api.setModel(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/reasoning"), safe(async (context) => json(await api.setReasoning(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/fast"), safe(async (context) => json(await api.setFast(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/compact"), safe(async (context) => json(await api.compact(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/bash"), safe(async (context) => json(await api.bash(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.get(path("/sessions/:id/rewind-targets"), safe(async (context) => json(await api.rewindTargets(sessionId(context)))))
	app.post(path("/sessions/:id/rewind"), safe(async (context) => json(await api.rewind(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/branch"), safe(async (context) => {
		const cwd = cwdFilter(context)
		return json(await api.branch(sessionId(context), {
			...(await jsonBody(context)),
			...(cwd ? { cwd } : {}),
		}, { snapshotOptions: routeSnapshotOptions() }))
	}))
	app.get(path("/sessions/:id/sub-sessions"), safe(async (context) => json(await api.subSessions(sessionId(context), { includeClosed: urlFor(context).searchParams.get("includeClosed") === "1" }))))
	app.post(path("/sessions/:id/sub-sessions"), safe(async (context) => json(await api.spawnSubSession(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/sub-sessions/wait"), safe(async (context) => json(await api.waitSubSession(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/sub-sessions/followup"), safe(async (context) => json(await api.followupSubSession(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/sub-sessions/resume"), safe(async (context) => json(await api.resumeSubSession(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/sub-sessions/close"), safe(async (context) => json(await api.closeSubSession(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
}
