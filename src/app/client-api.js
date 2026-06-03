import { normalizeReasoningLevel } from "../reasoning.js"
import { parseBashShortcut, recordBashShortcut, runBashShortcut } from "./bash-shortcut.js"
import { loadSettings, updateSetting } from "./settings.js"

export const WEB_COMMANDS = [
	{ name: "help", description: "show available slash commands" },
	{ name: "hotkeys", description: "show keyboard shortcuts" },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "model", description: "select default model for new sessions" },
	{ name: "session", description: "show info about the current session" },
	{ name: "fast", description: "set Codex Fast mode for this session: /fast on|off|status" },
	{ name: "compact", description: "summarize older messages for agent context" },
	{ name: "branch", description: "create a new session from the current conversation branch" },
	{ name: "rewind", description: "rewind to a previous user message or switch to a branch tip" },
	{ name: "abort", description: "abort the running turn" },
]

const encoder = new TextEncoder()

export function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	})
}

export function error(message, status = 400) {
	return json({ error: message }, status)
}

export function routeError(err) {
	return error(/** @type {any} */ (err)?.message ?? String(err), /** @type {any} */ (err)?.status ?? 400)
}

export async function jsonBody(context) {
	return context.req.json().catch(() => ({}))
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const validImageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

function promptImagesFromBody(body) {
	if (body.images === undefined) return []
	if (!Array.isArray(body.images)) throw Object.assign(new Error("images must be an array"), { status: 400 })
	return body.images.map((image, index) => {
		if (!image || typeof image !== "object" || image.type !== "image") {
			throw Object.assign(new Error(`images[${index}] must be an image content block`), { status: 400 })
		}
		if (typeof image.data !== "string" || image.data.length === 0) {
			throw Object.assign(new Error(`images[${index}].data is required`), { status: 400 })
		}
		if (!validImageMimeTypes.has(image.mimeType)) {
			throw Object.assign(new Error(`images[${index}].mimeType must be PNG, JPEG, GIF, or WebP`), { status: 400 })
		}
		if (image.detail !== undefined && image.detail !== "high" && image.detail !== "original") {
			throw Object.assign(new Error(`images[${index}].detail must be high or original`), { status: 400 })
		}
		const widthPx = Number(image.widthPx)
		const heightPx = Number(image.heightPx)
		return {
			type: "image",
			data: image.data,
			mimeType: image.mimeType,
			...(image.detail ? { detail: image.detail } : {}),
			...(Number.isFinite(widthPx) && widthPx > 0 ? { widthPx } : {}),
			...(Number.isFinite(heightPx) && heightPx > 0 ? { heightPx } : {}),
		}
	})
}

const apiPath = (prefix, path) => {
	if (!prefix) return path
	if (path === "/") return prefix
	return `${prefix}${path}`
}

const sessionId = (context) => context.req.param("id") ?? ""

const urlFor = (context) => new URL(context.req.url)

const snapshotOptions = (options) => ({
	...(options.includeSessionsInSnapshots ? { includeSessions: true } : {}),
	...(options.includeContextMessagesInSnapshots ? { includeContextMessages: true } : {}),
})

const cwdFilter = (context) => urlFor(context).searchParams.get("cwd") || undefined

const entryIdFromBody = (body) => {
	const value = body.entryId ?? body.id
	return typeof value === "string" ? value : String(value ?? "")
}

const settingsResponse = async (settings) => ({ settings: await settings })

const snapshotCursor = (snapshot) => {
	const cursor = {}
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
	const { manager, hub } = options
	const sessionListCwd = options.sessionListCwd
	const resolveId = options.resolveId || ((id) => id)
	const currentSettings = () => options.getSettings ? options.getSettings() : loadSettings()
	const setSettings = options.setSettings || (async (body) => {
		if (hasOwn(body, "model")) {
			const model = typeof body.model === "string" ? body.model.trim() : ""
			if (!model) throw Object.assign(new Error("model is required"), { status: 400 })
			if (options.setDefaultModel) return options.setDefaultModel(model)
			return updateSetting("model", model)
		}
		if (hasOwn(body, "thinkingLevel")) {
			const level = normalizeReasoningLevel(typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : "")
			if (!level) throw Object.assign(new Error("valid reasoning level is required"), { status: 400 })
			if (options.setDefaultReasoning) return options.setDefaultReasoning(level)
			return updateSetting("thinkingLevel", /** @type {any} */ (level))
		}
		throw Object.assign(new Error("no supported settings provided"), { status: 400 })
	})
	const snapshot = (id, options = {}) => manager.snapshot(resolveId(id || manager.initialSessionId), options)
	const runtimeFor = (id) => manager.getRuntime(resolveId(id))

	return {
		sessions: (cwd) => manager.sessions(cwd ?? sessionListCwd),
		snapshot,
		contextReport: (id) => manager.contextReport(resolveId(id || manager.initialSessionId)),
		systemReport: (id) => manager.systemReport(resolveId(id || manager.initialSessionId)),
		streamEvents: async (id, signal, options = {}) => {
			if (id) return hub.stream({ type: "snapshot", sessionId: id, snapshot: await snapshot(id, options) }, signal)
			return hub.stream({ type: "sessions", sessions: await manager.sessions(sessionListCwd) }, signal)
		},
		getSettings: () => settingsResponse(currentSettings()),
		setSettings: async (body) => ({ ok: true, settings: await setSettings(body) }),
		createSession: async (body) => {
			const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : sessionListCwd || options.cwd
			const prompt = typeof body.prompt === "string" ? body.prompt : ""
			const images = promptImagesFromBody(body)
			const runtime = await manager.createSession(cwd)
			if (prompt.trim() || images.length > 0) await runtime.prompt(prompt, body.streamingBehavior, images)
			return mutationResult(runtime.sessionId, {}, ["session", "sessions"])
		},
		prompt: async (id, body) => {
			const message = typeof body.message === "string" ? body.message : ""
			const images = promptImagesFromBody(body)
			if (!message.trim() && images.length === 0) throw Object.assign(new Error("message is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			await runtime.prompt(message, body.streamingBehavior, images)
			manager.setPromptDraft(resolveId(id), "", { clientId: body.draftClientId, clientSeq: body.draftClientSeq })
			return mutationResult(resolveId(id))
		},
		draft: async (id, body) => ({
			ok: true,
			draft: manager.setPromptDraft(resolveId(id), typeof body.text === "string" ? body.text : "", { clientId: body.clientId, clientSeq: body.clientSeq }),
		}),
		continueRun: async (id) => {
			const runtime = await runtimeFor(id)
			await runtime.continueRun()
			return mutationResult(resolveId(id))
		},
		abort: async (id) => {
			const runtime = await runtimeFor(id)
			await runtime.abort()
			return mutationResult(resolveId(id))
		},
		cancelPrompt: async (id) => {
			const response = await (await runtimeFor(id)).cancelCurrentPrompt()
			return mutationResult(resolveId(id), response)
		},
		markCompleted: async (id) => {
			const metadata = await manager.markCompleted(resolveId(id))
			return mutationResult(resolveId(id), { metadata }, ["session", "sessions"])
		},
		markDeferred: async (id) => {
			const metadata = await manager.markDeferred(resolveId(id))
			return mutationResult(resolveId(id), { metadata }, ["session", "sessions"])
		},
		markReadyForReview: async (id) => {
			const metadata = await manager.markReadyForReview(resolveId(id))
			return mutationResult(resolveId(id), { metadata }, ["session", "sessions"])
		},
		deleteStoppedSession: async (id) => {
			await manager.deleteStoppedSession(resolveId(id))
			return mutationResult(resolveId(id), {}, ["session", "sessions"])
		},
		setReasoning: async (id, body) => {
			const level = normalizeReasoningLevel(typeof body.level === "string" ? body.level.trim() : "")
			if (!level) throw Object.assign(new Error("valid reasoning level is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			runtime.agent.state.thinkingLevel = /** @type {any} */ (level)
			await runtime.session.appendConfigPatch({ version: 1, thinkingLevel: runtime.agent.state.thinkingLevel })
			await manager.invalidateSnapshot(resolveId(id))
			return mutationResult(resolveId(id))
		},
		setFast: async (id, body) => {
			const runtime = await runtimeFor(id)
			const message = await runtime.setFastMode(typeof body.args === "string" ? body.args : "")
			await manager.invalidateSnapshot(resolveId(id))
			return mutationResult(resolveId(id), { message })
		},
		compact: async (id) => {
			const runtime = await runtimeFor(id)
			const result = await runtime.compact()
			await manager.invalidateSnapshot(resolveId(id))
			return mutationResult(resolveId(id), { result })
		},
		bash: async (id, body) => {
			const shortcut = parseBashShortcut(typeof body.text === "string" ? body.text : "")
			if (!shortcut) throw Object.assign(new Error("valid bash shortcut is required"), { status: 400 })
			const runtime = await runtimeFor(id)
			const result = await runBashShortcut(runtime.agent, shortcut.command, { excludeFromContext: shortcut.excludeFromContext })
			await recordBashShortcut(runtime.agent, runtime.session, result)
			await manager.invalidateSnapshot(resolveId(id))
			return mutationResult(resolveId(id), { result })
		},
		rewindTargets: async (id) => ({ targets: (await runtimeFor(id)).rewindTargets() }),
		rewind: async (id, body) => {
			const runtime = await runtimeFor(id)
			const entryId = entryIdFromBody(body)
			const targetKind = body.kind === "leaf" || body.targetKind === "leaf" ? "leaf" : body.targetKind
			if (targetKind === "leaf") {
				await runtime.switchBranchTip(entryId)
				return mutationResult(resolveId(id), { text: "", editorText: "", targetKind: "leaf" })
			}
			const text = await runtime.rewind(entryId, {
				summary: body.summary === true,
				restoreFiles: body.restoreFiles === true,
				restoreConversation: body.restoreConversation !== false,
			})
			return mutationResult(resolveId(id), { text, editorText: text, targetKind: "message" })
		},
		branch: async (id) => {
			const runtime = await manager.branchSession(resolveId(id))
			return mutationResult(runtime.sessionId, {}, ["session", "sessions"])
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

	return {
		sessions: () => client.sessions(),
		snapshot,
		contextReport: async (id) => client.contextReport(id || await ensureInitialSessionId()),
		systemReport: async (id) => client.systemReport(id || await ensureInitialSessionId()),
		streamEvents: async (id) => {
			let unsubscribe = () => {}
			const stream = new ReadableStream({
				start(controller) {
					let closed = false
					const close = () => {
						if (closed) return
						closed = true
						unsubscribe()
						try { controller.close() } catch {}
					}
					const send = (event) => {
						if (closed) return
						try {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
						} catch {
							close()
						}
					}
					Promise.resolve(id ? client.snapshot(id, { includeSessions: true }) : client.sessions())
						.then((value) => send(id ? { type: "snapshot", sessionId: id, snapshot: value } : { type: "sessions", sessions: value }))
						.catch((err) => send({ type: "error", error: err?.message ?? String(err) }))
					unsubscribe = client.subscribe((event) => {
						if (!id || event?.snapshot?.sessionId === id || event?.sessionId === id) send(event)
					})
				},
				cancel() {
					unsubscribe()
				},
			})
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-store",
					"connection": "keep-alive",
				},
			})
		},
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
		cancelPrompt: async (id) => {
			const response = await client.cancelPrompt(id)
			return mutationResult(id, response)
		},
		markCompleted: async (id) => mutationResult(id, await client.markCompleted(id), ["session", "sessions"]),
		markDeferred: async (id) => mutationResult(id, await client.markDeferred(id), ["session", "sessions"]),
		markReadyForReview: async (id) => mutationResult(id, await client.markReadyForReview(id), ["session", "sessions"]),
		deleteStoppedSession: async (id) => mutationResult(id, await client.deleteSession(id), ["session", "sessions"]),
		setReasoning: async (id, body) => {
			const response = await client.setThinking(id, body.level)
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
			const response = await client.bash(id, typeof body.text === "string" ? body.text : "")
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
		branch: async (id) => {
			const response = await client.branchSession(id)
			const nextId = response.sessionId || response.snapshot?.sessionId
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

	app.get(path("/events"), safe(async (context) => {
		const id = urlFor(context).searchParams.get("sessionId") || undefined
		return api.streamEvents(id, context.req.signal, routeSnapshotOptions())
	}))
	if (options.includeSnapshotRoute) {
		app.get(path("/snapshot"), safe(async (context) => json(await api.snapshot(urlFor(context).searchParams.get("sessionId") || undefined, routeSnapshotOptionsFromQuery(context)))))
	}
	app.get(path("/sessions"), safe(async (context) => json({ sessions: await api.sessions(cwdFilter(context)) })))
	app.post(path("/sessions"), safe(async (context) => json(await api.createSession(await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.get(path("/settings"), safe(async () => json(await api.getSettings())))
	app.post(path("/settings"), safe(async (context) => json(await api.setSettings(await jsonBody(context)))))
	if (options.includeCommands) app.get(path("/commands"), () => json({ commands: WEB_COMMANDS }))

	const snapshotById = safe(async (context) => json(await api.snapshot(sessionId(context), routeSnapshotOptionsFromQuery(context))))
	app.get(path("/sessions/:id"), snapshotById)
	app.get(path("/sessions/:id/snapshot"), snapshotById)
	app.get(path("/sessions/:id/context-report"), safe(async (context) => json({ lines: await api.contextReport(sessionId(context)) })))
	app.get(path("/sessions/:id/system-report"), safe(async (context) => json({ lines: await api.systemReport(sessionId(context)) })))
	app.post(path("/sessions/:id/prompt"), safe(async (context) => json(await api.prompt(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/draft"), safe(async (context) => json(await api.draft(sessionId(context), await jsonBody(context)))))
	app.post(path("/sessions/:id/continue"), safe(async (context) => json(await api.continueRun(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/abort"), safe(async (context) => json(await api.abort(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/cancel-prompt"), safe(async (context) => json(await api.cancelPrompt(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/complete"), safe(async (context) => json(await api.markCompleted(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/defer"), safe(async (context) => json(await api.markDeferred(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/review"), safe(async (context) => json(await api.markReadyForReview(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/delete"), safe(async (context) => json(await api.deleteStoppedSession(sessionId(context), { cwd: cwdFilter(context) }))))
	app.post(path("/sessions/:id/reasoning"), safe(async (context) => json(await api.setReasoning(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/fast"), safe(async (context) => json(await api.setFast(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/compact"), safe(async (context) => json(await api.compact(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/bash"), safe(async (context) => json(await api.bash(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.get(path("/sessions/:id/rewind-targets"), safe(async (context) => json(await api.rewindTargets(sessionId(context)))))
	app.post(path("/sessions/:id/rewind"), safe(async (context) => json(await api.rewind(sessionId(context), await jsonBody(context), { snapshotOptions: routeSnapshotOptions() }))))
	app.post(path("/sessions/:id/branch"), safe(async (context) => json(await api.branch(sessionId(context), { cwd: cwdFilter(context) }, { snapshotOptions: routeSnapshotOptions() }))))
}
