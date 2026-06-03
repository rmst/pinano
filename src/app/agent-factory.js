import { streamSimple as openaiStreamSimple } from "../agent-core/index.js"
import { Agent } from "../agent-core/agent.js"
import { normalizeReasoningLevel } from "../reasoning.js"
import { createDefaultTools } from "../tools/index.js"
import { makeAutoCompactTransform } from "./auto-compact.js"
import { resolveModelStreamOptions } from "./model-auth.js"
import { LazyContextLoader, formatLazyContextNotice, extractToolPaths } from "./lazy-context.js"
import { activeContextFiles } from "./session-context.js"
import { recordFileCheckpoint } from "./file-checkpoints.js"
import { createSessionSetTool } from "./session-set-tool.js"
import { createExecutorProxyTools } from "./tool-executor-tools.js"
import { baseInstructionsForModel, toolProfileForModel } from "./model-instructions.js"
import { prependEnvironmentContext } from "./environment-context.js"
import { getEffectiveSessionProperties } from "./session-properties.js"


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

// Keep the fallback global prompt small. Concrete tool capabilities and
// argument contracts are supplied separately through the model API tool definitions.
const DEFAULT_BASE_INSTRUCTIONS_PREFIX = `You are an expert coding assistant operating inside pinano, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`

const DEFAULT_DIRECT_TOOL_INSTRUCTIONS = `- Prefer grep/find/ls tools over shell commands for file exploration (faster, respects .gitignore)
- Use read to examine files instead of cat or sed.
- Use direct tools for file reads/searches, file mutations, and shell commands.
- Use write for new files or full-file rewrites.
- Use edit for precise changes to existing files (edits[].oldText must match exactly).
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.`

const CODEX_TOOL_INSTRUCTIONS = `- Use exec_command for text file reads, file searches, directory listing, shell commands, long-running processes, stdin/EOF, polling, and process-group signals.
- Use view_image to inspect local image files.
- Use apply_patch for file mutations.
- Prefer rg or rg --files for searching when using shell commands.`

const DEFAULT_BASE_INSTRUCTIONS_SUFFIX = `- Be concise in your responses
- For reversible actions (reads, edits to tracked files, running tests) be proactive. Save confirmation for actions that can't be cleanly undone: destructive deletes, \`git reset --hard\`, force-push, pushing to remotes, modifying CI/CD, dropping data.`

function fallbackBaseInstructionsForToolProfile(toolProfile) {
	const toolInstructions = toolProfile === "codex" ? CODEX_TOOL_INSTRUCTIONS
		: DEFAULT_DIRECT_TOOL_INSTRUCTIONS
	return `${DEFAULT_BASE_INSTRUCTIONS_PREFIX}

Guidelines:
${toolInstructions}
${DEFAULT_BASE_INSTRUCTIONS_SUFFIX}`
}

/**
 * @param {string} cwd
 * @param {{ baseInstructionsKey?: string, baseInstructions?: string }} [model]
 */
export function systemPromptFor(cwd, model = undefined) {
	const now = new Date()
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
	const base = baseInstructionsForModel(model) ?? fallbackBaseInstructionsForToolProfile(toolProfileForModel(model))

	let prompt = base
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

function withEnvironmentContextTransform(getEnvironmentContext, transformContext) {
	return async (messages, signal) => {
		const transformed = transformContext ? await transformContext(messages, signal) : messages
		return prependEnvironmentContext(getEnvironmentContext?.(), transformed)
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
	const toolsForModel = (/** @type {any} */ model) => [
		...baseToolsForModel(model),
		createSessionSetTool({ request: () => agent?.pinanoApiRequest }),
	]
	const baseStreamFn = options.streamFn ?? buildDefaultStreamFn()
	const streamFn = (/** @type {any} */ model, /** @type {any} */ ctx, /** @type {any} */ streamOptions) => baseStreamFn(model, ctx, {
		...streamOptions,
		autocompactThreshold: options.settings.autocompactThreshold,
	})
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
		transformContext: withEnvironmentContextTransform(
			() => agent?.pinanoEnvironmentContext?.(),
			makeAutoCompactTransform(() => agent, () => options.settings.autocompactThreshold),
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
			const extracted = extractToolPaths(ctx.toolCall.name, ctx.args, cwd, ctx.isError ? undefined : ctx.result)
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
	agent.pinanoEnvironmentContext = initialEnvironmentContext
	agent.contextFilesDisabled = options.noContextFiles === true
	agent.activeContextSnapshotFiles = []
	agent.markContextFilesLoaded = (paths) => lazyContext.markLoaded(paths)
	agent.refreshToolsForModel = (model = agent.state.model) => {
		agent.state.tools = toolsForModel(model)
	}
	if (options.toolExecutor) {
		Object.defineProperty(agent, "isDead", { get: () => options.toolExecutor.isDead === true && agent.state.isStreaming !== true })
		if (options.toolExecutor.dispose) agent.dispose = () => options.toolExecutor.dispose()
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
			autocompactThreshold: 1,
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
	sidecar.transformContext = withEnvironmentContextTransform(
		() => sidecar.pinanoEnvironmentContext?.(),
		options.transformContext,
	)
	return sidecar
}
