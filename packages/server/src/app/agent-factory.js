import { streamSimple as openaiStreamSimple } from "../agent-core/index.js"
import { Agent } from "../agent-core/agent.js"
import { normalizeReasoningLevel } from "../../../protocol/src/reasoning.js"
import { createDefaultTools } from "../tools/index.js"
import { makeAutoCompactTransform } from "./auto-compact.js"
import { resolveModelStreamOptions } from "./model-auth.js"
import { LazyContextLoader, formatLazyContextNotice, extractToolPaths } from "./lazy-context.js"
import { activeContextFiles } from "./session-context.js"
import { recordFileCheckpoint } from "./file-checkpoints.js"
import { createExecutorProxyTools } from "./tool-executor-tools.js"
import { modelInstructionsForContext, toolProfileForModel } from "./model-instructions.js"
import { prependEnvironmentContext } from "./environment-context.js"
import { getEffectiveSessionProperties } from "./session-properties.js"
import { prependSkillsContext } from "./skills.js"
import { updatePlanToolsForModel } from "./update-plan-tool.js"
import { CodeModeRuntime } from "./code-mode/runtime.js"

const AUTO_COMPACT_THRESHOLD = 0.85

/**
 * Build a streamFn that resolves app-level credentials, then lets the shared
 * ai-apis dispatcher pick the right transport for the model.
 */
export function buildDefaultStreamFn() {
	return async (/** @type {any} */ model, /** @type {any} */ ctx, /** @type {any} */ options) => {
		const streamOptions = await resolveModelStreamOptions(model, options)
		return openaiStreamSimple(model, ctx, streamOptions)
	}
}

/**
 * Build a streamFn for workers. The worker drives the agent loop, but the
 * service owns model I/O (credentials, HTTP requests, logging, and aborts).
 * @param {(model: any, context: any, options: any) => any} startModelStream
 */
export function buildWorkerStreamFn(startModelStream) {
	const fn = (/** @type {any} */ model, /** @type {any} */ ctx, /** @type {any} */ options) => startModelStream(model, ctx, options)
	fn.serviceMediated = true
	return fn
}

/**
 * @param {string} cwd
 * @param {{ baseInstructionsKey?: string, baseInstructions?: string, toolProfile?: string }} [model]
 */
export function systemPromptFor(cwd, model = undefined) {
	const now = new Date()
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
	let prompt = modelInstructionsForContext({ model })
	prompt += `\n\nCurrent date: ${date}`
	prompt += `\nInitial working directory: ${cwd} (change when convenient)`
	return prompt
}

function effectiveSessionCwd(agent, fallback) {
	return agent?.session ? getEffectiveSessionProperties(agent.session).cwd ?? fallback : fallback
}

function environmentContextProvider(value) {
	if (!value) return undefined
	return typeof value === "function" ? value : () => value
}

function withModelContextTransforms(getEnvironmentContext, getSkillsContext, transformContext) {
	return async (messages, signal) => {
		const transformed = transformContext ? await transformContext(messages, signal) : messages
		const withSkills = prependSkillsContext(getSkillsContext?.(), transformed)
		return prependEnvironmentContext(getEnvironmentContext?.(), withSkills)
	}
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {any} options.model
 * @param {any} options.settings
 * @param {boolean} [options.noContextFiles]
 * @param {Iterable<string>} [options.alreadyLoadedContextPaths]
 * @param {any} [options.streamFn]
 * @param {string | (() => string | undefined)} [options.environmentContext]
 * @param {{ executeTool: (name: string, id: string, args: any, signal?: AbortSignal, onUpdate?: (update: any) => void, options?: { scope?: any, toolProfile?: "default" | "codex" }) => Promise<any>, dispose?: () => void, isDead?: boolean }} [options.toolExecutor]
 * @param {(info: { absolutePath: string }, agent: Agent) => Promise<any>} [options.beforeFileMutation]
 */
export function createPinanoAgent(options) {
	const lazyContext = new LazyContextLoader({
		cwd: options.cwd,
		alreadyLoaded: options.alreadyLoadedContextPaths ?? [],
	})
	/** @type {Agent} */
	let agent
	const codeModeRuntime = new CodeModeRuntime({
		getAgent: () => agent,
		cellHost: options.toolExecutor,
		recordPlanUpdate: async (update, source) => {
			if (!agent?.pinanoApiRequest) return
			await agent.pinanoApiRequest({ op: "plan.update", update, source })
		},
	})
	const initialEnvironmentContext = environmentContextProvider(options.environmentContext)
	const beforeFileMutation = async (/** @type {{ absolutePath: string }} */ info) => {
		if (options.beforeFileMutation) return options.beforeFileMutation(info, agent)
		return recordFileCheckpoint(agent?.session, info.absolutePath)
	}
	const baseToolsForModel = (/** @type {any} */ model) => {
		const toolProfile = toolProfileForModel(model)
		return options.toolExecutor
			? createExecutorProxyTools(options.cwd, options.toolExecutor, { getScope: () => agent?.pinanoApiScopeForTool?.(), toolProfile })
			: createDefaultTools(options.cwd, { beforeFileMutation, toolProfile })
	}
	const toolsForModel = (/** @type {any} */ model) => {
		const tools = [
			...baseToolsForModel(model),
			...updatePlanToolsForModel(model),
		]
		if (model?.toolMode === "code_mode_only") {
			const directModelOnly = tools.filter((tool) => tool.exposure === "direct_model_only")
			return [...codeModeRuntime.setTools(tools), ...directModelOnly]
		}
		codeModeRuntime.clear()
		return tools
	}
	const baseStreamFn = options.streamFn ?? buildDefaultStreamFn()
	const streamFn = (/** @type {any} */ model, /** @type {any} */ ctx, /** @type {any} */ streamOptions) => baseStreamFn(model, ctx, { ...streamOptions })
	if (baseStreamFn.serviceMediated) streamFn.serviceMediated = true

	agent = new Agent({
		initialState: {
			model: options.model,
			thinkingLevel: /** @type {any} */ (normalizeReasoningLevel(options.settings.thinkingLevel) ?? options.settings.thinkingLevel),
			systemPrompt: systemPromptFor(options.cwd, options.model),
			tools: toolsForModel(options.model),
		},
		streamFn,
		// Auto-compact older messages just before each LLM call when usage is high.
		transformContext: withModelContextTransforms(
			() => agent?.pinanoEnvironmentContext?.(),
			() => agent?.pinanoSkillsContext?.(),
			makeAutoCompactTransform(() => agent, () => AUTO_COMPACT_THRESHOLD),
		),
		afterToolCall: async (ctx) => {
			if (agent.contextFilesDisabled || options.noContextFiles || agent.session?.getSessionConfig?.().noContextFiles) return undefined
			if (agent.session?.getContextLoads) lazyContext.markLoaded(activeContextFiles(agent.session).map((file) => file.path))
			else {
				// Compatibility for hermetic/no-session runs: seed from legacy
				// context notices already present in the replayed message list.
				lazyContext.hydrateFromMessages(ctx.context.messages)
			}
			const cwd = effectiveSessionCwd(agent, options.cwd)
			lazyContext.setCwd(cwd)
			if (ctx.isError) return undefined
			const extracted = extractToolPaths(ctx.toolCall.name, ctx.args, cwd, ctx.result)
			lazyContext.markLoaded(extracted.manuallyLoadedContextPaths)
			const newFiles = extracted.paths.flatMap((path) => lazyContext.loadForPath(path))
			if (newFiles.length === 0) return undefined
			if (agent.session?.appendContextLoad) {
				const load = { source: "lazy", cwd, loadedAt: new Date().toISOString(), files: newFiles }
				const entryId = await agent.session.appendContextLoad(load)
				await agent.onContextLoad?.({ entryId, timestamp: load.loadedAt, contextLoad: load })
				return undefined
			}
			return {
				content: [
					...(ctx.result.content ?? []),
					{ type: "text", text: formatLazyContextNotice(newFiles) },
				],
			}
		},
	})
	codeModeRuntime.bindAgent(agent)
	agent.pinanoEnvironmentContext = initialEnvironmentContext
	agent.pinanoSkillsContext = undefined
	agent.contextFilesDisabled = options.noContextFiles === true
	agent.activeContextSnapshotFiles = []
	agent.markContextFilesLoaded = (paths) => lazyContext.markLoaded(paths)
	agent.refreshToolsForModel = (model = agent.state.model) => {
		agent.state.tools = toolsForModel(model)
	}
	const disposeCodeMode = () => codeModeRuntime.dispose()
	if (options.toolExecutor) {
		Object.defineProperty(agent, "toolExecutor", { value: options.toolExecutor, writable: true, configurable: true })
		Object.defineProperty(agent, "isDead", { get: () => options.toolExecutor.isDead === true && agent.state.isStreaming !== true })
		agent.dispose = () => {
			disposeCodeMode()
			options.toolExecutor.dispose?.()
		}
	} else {
		agent.dispose = disposeCodeMode
	}
	return agent
}

/**
 * Create a Pinano sidecar Agent with model-visible configuration copied from a
 * live session Agent. The caller supplies the message snapshot and any isolated
 * tool executor; this helper keeps the tool schemas/order and model options in
 * sync with ordinary Pinano agents without inheriting visible-run lifecycle
 * state.
 * @param {object} options
 * @param {string} options.cwd
 * @param {Agent} options.baseAgent
 * @param {any[]} options.messages
 * @param {any} [options.toolExecutor]
 * @param {any} [options.transformContext]
 * @param {any} [options.afterToolCall]
 */
export function createPinanoSidecarAgent(options) {
	const base = options.baseAgent
	const sidecar = createPinanoAgent({
		cwd: options.cwd,
		model: base.state.model,
		settings: {
			thinkingLevel: base.state.thinkingLevel,
		},
		noContextFiles: base.contextFilesDisabled === true || base.session?.getSessionConfig?.().noContextFiles === true,
		toolExecutor: options.toolExecutor,
		streamFn: base.streamFn,
	})
	sidecar.state.systemPrompt = base.state.systemPrompt
	sidecar.state.model = base.state.model
	sidecar.state.thinkingLevel = base.state.thinkingLevel
	sidecar.state.serviceTier = base.state.serviceTier
	sidecar.state.messages = options.messages
	sidecar.pinanoEnvironmentContext = base.pinanoEnvironmentContext
	sidecar.sessionId = base.sessionId
	sidecar.session = base.session
	sidecar.toolExecution = base.toolExecution
	sidecar.convertToLlm = base.convertToLlm
	sidecar.getApiKey = base.getApiKey
	sidecar.onPayload = base.onPayload
	sidecar.onResponse = base.onResponse
	sidecar.modelForRequest = base.modelForRequest
	sidecar.beforeToolCall = base.beforeToolCall
	sidecar.afterToolCall = options.afterToolCall
	sidecar.transformContext = withModelContextTransforms(
		() => sidecar.pinanoEnvironmentContext?.(),
		() => sidecar.pinanoSkillsContext?.(),
		options.transformContext,
	)
	return sidecar
}
