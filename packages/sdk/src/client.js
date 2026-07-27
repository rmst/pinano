const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const definedObject = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

const apiPath = (path) => {
	if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("CerexClient API paths must start with /")
	if (path.startsWith("//")) throw new TypeError("CerexClient API paths must not be protocol-relative URLs")
	const pathname = path.split(/[?#]/, 1)[0]
	if (pathname === "/api" || pathname.startsWith("/api/")) throw new TypeError("CerexClient API paths are relative to /api and must not include that prefix")
	return path
}

const queryPath = (path, params) => {
	const query = params.toString()
	return `${path}${query ? `?${query}` : ""}`
}

const sessionPath = (id, suffix = "") => `/sessions/${encodeURIComponent(id)}${suffix}`

const requestControls = (options = {}) => ({
	...(options.signal ? { signal: options.signal } : {}),
	...(hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
	...(hasOwn(options, "retryOnTimeout") ? { retryOnTimeout: options.retryOnTimeout } : {}),
})

const requestOptions = (options, request = {}) => ({
	...requestControls(options),
	...request,
})

const headerValue = (headers, name) => {
	if (typeof headers?.get === "function") return headers.get(name) ?? undefined
	if (!headers || typeof headers !== "object") return undefined
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
	const value = key ? headers[key] : undefined
	return Array.isArray(value) ? value[0] : value
}

/** Runtime-independent client for the Cerex application API. The injected transport owns endpoint discovery, authentication, JSON serialization, retries, and environment lifecycle; this class owns the shared operation vocabulary and wire shapes. */
export class CerexClient {
	#transport
	#cwd
	#sessionListCwd

	/**
	 * @param {{
	 * 	transport: {
	 * 		request(path: string, options?: { method?: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, retryOnTimeout?: boolean }): Promise<any>,
	 * 		requestBytes?: (path: string, options?: { method?: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, retryOnTimeout?: boolean }) => Promise<{ body: any, headers?: any }>,
	 * 		subscribe?: (resource: string, params: Record<string, any>, handlers: Record<string, Function>) => any,
	 * 	},
	 * 	cwd?: string,
	 * 	sessionListCwd?: string,
	 * }} options
	 */
	constructor(options) {
		if (!options || typeof options !== "object") throw new TypeError("CerexClient options are required")
		if (!options.transport || typeof options.transport.request !== "function") throw new TypeError("CerexClient requires a transport.request function")
		this.#transport = options.transport
		this.#cwd = options.cwd
		this.#sessionListCwd = options.sessionListCwd
	}

	/** Send an application-API-relative request with an optional structured JSON body. This is the extension point for API operations not yet represented by a named SDK method. */
	request(path, options = {}) {
		return this.#transport.request(apiPath(path), options)
	}

	/** Send an application-API-relative request whose successful response is binary. */
	requestBytes(path, options = {}) {
		if (typeof this.#transport.requestBytes !== "function") throw new Error("CerexClient transport does not support binary responses")
		return this.#transport.requestBytes(apiPath(path), options)
	}

	/** Subscribe to a named live resource using the transport's shared live connection. */
	subscribeResource(resource, params, handlers) {
		if (typeof this.#transport.subscribe !== "function") throw new Error("CerexClient transport does not support live resources")
		return this.#transport.subscribe(resource, params, handlers)
	}

	async sessions(cwd = undefined, options = {}) {
		const params = new URLSearchParams()
		const requestedCwd = cwd ?? this.#sessionListCwd
		if (requestedCwd) params.set("cwd", requestedCwd)
		if (options.includeDeleted === true) params.set("includeDeleted", "1")
		if (options.includeHidden === true) params.set("includeHidden", "1")
		return (await this.request(queryPath("/sessions", params), requestControls(options))).sessions
	}

	sessionsStatus(cwd = undefined, options = {}) {
		const params = new URLSearchParams()
		const requestedCwd = cwd ?? this.#sessionListCwd
		if (requestedCwd) params.set("cwd", requestedCwd)
		if (options.includeDeleted === true) params.set("includeDeleted", "1")
		if (options.includeHidden === true) params.set("includeHidden", "1")
		return this.request(queryPath("/sessions/status", params), requestControls(options))
	}

	clientContext(cwd = undefined, options = {}) {
		const params = new URLSearchParams()
		if (cwd) params.set("cwd", cwd)
		return this.request(queryPath("/client-context", params), requestControls(options))
	}

	async overviewProject(cwd = undefined, options = {}) {
		return (await this.clientContext(cwd, options)).project
	}

	ensureProjectMaintenance(projectDir, options = {}) {
		return this.request("/projects/maintenance", requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: {
				projectDir,
				runPrompt: options.runPrompt !== false,
				onlyIfNeeded: options.onlyIfNeeded === true,
				waitForCompletion: options.waitForCompletion === true,
			},
		}))
	}

	projectPreviews(projectDir, options = {}) {
		const params = new URLSearchParams({ projectDir })
		if (options.sessionId) params.set("sessionId", options.sessionId)
		return this.request(queryPath("/projects/previews", params), requestControls(options))
	}

	sessionPreviews(id, options = {}) {
		return this.request(sessionPath(id, "/previews"), requestControls(options))
	}

	resolveSessionId(id, options = {}) {
		const requested = typeof id === "string" ? id.trim() : ""
		return this.request(queryPath("/sessions/resolve", new URLSearchParams({ id: requested })), requestControls(options))
	}

	resolvePreviewUrl(url, options = {}) {
		return this.request(queryPath("/previews/resolve", new URLSearchParams({ url })), requestControls(options))
	}

	resolvePreviewSource(request, options = {}) {
		const params = new URLSearchParams()
		if (request?.path) params.set("path", request.path)
		if (request?.projectDir) params.set("projectDir", request.projectDir)
		if (request?.sessionId) params.set("sessionId", request.sessionId)
		return this.request(queryPath("/previews/resolve-source", params), requestControls(options))
	}

	previewLog(url, options = {}) {
		return this.request(queryPath("/previews/log", new URLSearchParams({ url })), requestControls(options))
	}

	previewSource(url, options = {}) {
		return this.request(queryPath("/previews/source", new URLSearchParams({ url })), requestControls(options))
	}

	commands(options = {}) {
		return this.request("/commands", requestControls(options))
	}

	getSettings(options = {}) {
		return this.request("/settings", requestControls(options))
	}

	models(options = {}) {
		return this.request("/models", requestControls(options))
	}

	createSession(options = {}) {
		const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : this.#cwd
		return this.request("/sessions", requestOptions(options, {
			method: "POST",
			body: definedObject({ prompt: options.prompt, cwd, images: options.images }),
		}))
	}

	setDefaultModel(model, options = {}) {
		return this.request("/settings", requestOptions(options, { method: "POST", body: { model } }))
	}

	setDefaultReasoning(level, options = {}) {
		return this.request("/settings", requestOptions(options, { method: "POST", body: { thinkingLevel: level } }))
	}

	async getUiState(key, options = {}) {
		const response = await this.request(queryPath("/ui-state", new URLSearchParams({ key })), requestControls(options))
		return response.found ? response.value : undefined
	}

	setUiState(key, value, options = {}) {
		return this.request("/ui-state", requestOptions(options, { method: "POST", body: { key, value } }))
	}

	deleteUiState(key, options = {}) {
		return this.request(queryPath("/ui-state", new URLSearchParams({ key })), requestOptions(options, { method: "DELETE" }))
	}

	branchSession(id, options = {}) {
		const entryId = typeof options.entryId === "string" && options.entryId ? options.entryId : undefined
		const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : undefined
		return this.request(this.#sessionActionPath(id, "branch"), requestOptions(options, {
			method: "POST",
			body: {
				...(cwd ? { cwd } : {}),
				...(entryId ? { entryId } : {}),
				...(options.restoreDraft === false ? { restoreDraft: false } : {}),
			},
		}))
	}

	spawnSubSession(id, options = {}) {
		return this.request(sessionPath(id, "/sub-sessions"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({
				task: options.task,
				name: options.name,
				forkTurns: options.forkTurns,
				origin: options.origin,
			}),
		}))
	}

	subSessions(id, options = {}) {
		const params = new URLSearchParams()
		if (options.includeClosed === true) params.set("includeClosed", "1")
		return this.request(queryPath(sessionPath(id, "/sub-sessions"), params), requestControls(options))
	}

	waitSubSession(id, options = {}) {
		return this.request(sessionPath(id, "/sub-sessions/wait"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({ agent: options.agent, timeoutMs: options.timeoutMs }),
		}))
	}

	followupSubSession(id, options = {}) {
		return this.request(sessionPath(id, "/sub-sessions/followup"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({ agent: options.agent, task: options.task, interrupt: options.interrupt === true }),
		}))
	}

	resumeSubSession(id, options = {}) {
		return this.request(sessionPath(id, "/sub-sessions/resume"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({ agent: options.agent }),
		}))
	}

	closeSubSession(id, options = {}) {
		return this.request(sessionPath(id, "/sub-sessions/close"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({ agent: options.agent, reason: options.reason }),
		}))
	}

	snapshot(id, options = {}) {
		const params = new URLSearchParams()
		if (options.includeSessions === true) params.set("includeSessions", "1")
		if (options.includeContextMessages === true) params.set("includeContextMessages", "1")
		return this.request(queryPath(sessionPath(id, "/snapshot"), params), requestControls(options))
	}

	sessionStatus(id, options = {}) {
		return this.request(sessionPath(id, "/status"), requestControls(options))
	}

	async contextReport(id, options = {}) {
		return (await this.request(sessionPath(id, "/context-report"), requestControls(options))).lines ?? []
	}

	async systemReport(id, options = {}) {
		return (await this.request(sessionPath(id, "/system-report"), requestControls(options))).lines ?? []
	}

	async worktrees(id, options = {}) {
		return (await this.request(sessionPath(id, "/worktrees"), requestControls(options))).worktrees ?? []
	}

	async attachmentContent(id, attachmentId, variant = "display", options = {}) {
		const params = new URLSearchParams()
		if (variant) params.set("variant", variant)
		const response = await this.requestBytes(queryPath(sessionPath(id, `/attachments/${encodeURIComponent(attachmentId)}/content`), params), requestControls(options))
		return {
			data: response.body,
			mimeType: String(headerValue(response.headers, "content-type") ?? "application/octet-stream"),
		}
	}

	prompt(id, message, streamingBehavior = undefined, options = {}) {
		return this.request(sessionPath(id, "/prompt"), requestOptions(options, {
			method: "POST",
			body: definedObject({
				message,
				streamingBehavior,
				draftClientId: options.draftClientId,
				draftClientSeq: options.draftClientSeq,
				images: options.images,
			}),
		}))
	}

	setPromptDraft(id, text, options = {}) {
		return this.request(sessionPath(id, "/draft"), requestOptions(options, {
			method: "POST",
			body: definedObject({ text, clientId: options.clientId, clientSeq: options.clientSeq }),
		}))
	}

	continueRun(id, options = {}) {
		return this.request(sessionPath(id, "/continue"), requestOptions(options, { method: "POST", body: {} }))
	}

	abort(id, options = {}) {
		return this.request(sessionPath(id, "/abort"), requestOptions(options, { method: "POST", body: {} }))
	}

	cancelPrompt(id, options = {}) {
		return this.request(sessionPath(id, "/cancel-prompt"), requestOptions(options, {
			method: "POST",
			body: { restoreCurrentPrompt: options.restoreCurrentPrompt !== false },
		}))
	}

	markCompleted(id, options = {}) {
		return this.request(this.#sessionActionPath(id, "complete"), requestOptions(options, { method: "POST", body: {} }))
	}

	markDeferred(id, options = {}) {
		return this.request(this.#sessionActionPath(id, "defer"), requestOptions(options, { method: "POST", body: {} }))
	}

	markReadyForReview(id, options = {}) {
		return this.request(this.#sessionActionPath(id, "review"), requestOptions(options, { method: "POST", body: {} }))
	}

	deleteSession(id, options = {}) {
		return this.request(this.#sessionActionPath(id, "delete"), requestOptions(options, { method: "POST", body: {} }))
	}

	restoreSession(id, options = {}) {
		return this.request(this.#sessionActionPath(id, "restore"), requestOptions(options, { method: "POST", body: {} }))
	}

	setReasoning(id, level, options = {}) {
		return this.request(sessionPath(id, "/reasoning"), requestOptions(options, { method: "POST", body: { level } }))
	}

	/** @deprecated Use setReasoning. */
	setThinking(id, level, options = {}) {
		return this.setReasoning(id, level, options)
	}

	sessionModels(id, options = {}) {
		return this.request(sessionPath(id, "/models"), requestControls(options))
	}

	setModel(id, model, options = {}) {
		return this.request(sessionPath(id, "/model"), requestOptions(options, { method: "POST", body: { model } }))
	}

	setFast(id, args, options = {}) {
		return this.request(sessionPath(id, "/fast"), requestOptions(options, { method: "POST", body: { args } }))
	}

	compact(id, options = {}) {
		return this.request(sessionPath(id, "/compact"), requestOptions(options, { method: "POST", body: {}, timeoutMs: 0 }))
	}

	bash(id, text, options = {}) {
		return this.request(sessionPath(id, "/bash"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({
				text,
				draftClientId: options.draftClientId,
				draftClientSeq: options.draftClientSeq,
			}),
		}))
	}

	async rewindTargets(id, options = {}) {
		return (await this.request(sessionPath(id, "/rewind-targets"), requestControls(options))).targets
	}

	rewind(id, entryId, options = {}) {
		return this.request(sessionPath(id, "/rewind"), requestOptions(options, {
			method: "POST",
			timeoutMs: 0,
			body: definedObject({
				entryId,
				targetKind: options.targetKind,
				summary: options.summary === true,
				restoreFiles: options.restoreFiles === true,
				restoreConversation: options.restoreConversation !== false,
			}),
		}))
	}

	#sessionActionPath(id, action) {
		const params = new URLSearchParams()
		if (this.#sessionListCwd) params.set("cwd", this.#sessionListCwd)
		return queryPath(sessionPath(id, `/${action}`), params)
	}
}
