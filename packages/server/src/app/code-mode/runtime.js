import { randomUUID } from "node:crypto"

import { validateToolArguments } from "../../ai-apis/validate.js"
import { isUncertainToolExecutionError } from "../../agent-core/tool-errors.js"
import { executorProxyInfo } from "../workers/tool/executor-tools.js"
import { UPDATE_PLAN_TOOL_NAME } from "../update-plan-tool.js"
import { codeModeToolMetadata, createCodeModeToolDefinitions, parseExecSource } from "./description.js"
import { ToolDispatchGate } from "./dispatch-gate.js"

const DEFAULT_YIELD_TIME_MS = 10_000
const DEFAULT_OUTPUT_TOKENS = 10_000
const MAX_OUTPUT_TOKENS = 10_000
const APPROX_CHARS_PER_TOKEN = 4
const OUTPUT_TRUNCATION_MARKER = "[Code-mode output truncated]"

function normalizeDuration(value, fallback = DEFAULT_YIELD_TIME_MS) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeOutputTokens(value) {
	if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_OUTPUT_TOKENS
	return Math.min(value, MAX_OUTPUT_TOKENS)
}

function syntheticAssistantMessage(agent) {
	const messages = agent?.state?.messages ?? []
	return [...messages].reverse().find((message) => message?.role === "assistant") ?? {
		role: "assistant",
		content: [],
		provider: agent?.state?.model?.provider ?? "unknown",
		model: agent?.state?.model?.id ?? "unknown",
		stopReason: "toolUse",
		timestamp: Date.now(),
	}
}

function codeModeResult(tool, result) {
	if (tool.codeMode?.projectResult) return tool.codeMode.projectResult(result)
	const content = Array.isArray(result?.content) ? result.content : []
	const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n")
	const images = content.filter((item) => item?.type === "image")
	const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details)
		? result.details
		: {}
	if (Object.keys(details).length === 0 && images.length === 0) return text
	return {
		...details,
		...(text ? { output: text } : {}),
		...(content.length > 0 ? { content } : {}),
	}
}

function mergeAfterToolResult(result, after) {
	if (!after) return { result, isError: false }
	return {
		result: {
			content: after.content ?? result.content,
			details: after.details ?? result.details,
			terminate: after.terminate ?? result.terminate,
		},
		isError: after.isError === true,
	}
}

function resultErrorText(result) {
	const text = result?.content?.filter?.((item) => item?.type === "text").map((item) => item.text).join("\n")
	return text || "Nested tool call failed"
}

function truncateContent(items, maxTokens) {
	let runnerTruncated = false
	const source = items.filter((item) => {
		if (item?.type === "text" && item.text === "[Cell output truncated]") {
			runnerTruncated = true
			return false
		}
		return item?.type !== "text" || item.text.length > 0
	})
	const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN
	let textItems = 0
	const totalChars = source.reduce((total, item) => {
		if (item?.type !== "text") return total
		const separatorChars = textItems > 0 ? 1 : 0
		textItems++
		return total + item.text.length + separatorChars
	}, 0)
	if (!runnerTruncated && totalChars <= maxChars) return { content: source, truncated: false }
	if (totalChars <= maxChars) {
		return {
			content: [...source, { type: "text", text: OUTPUT_TRUNCATION_MARKER }],
			truncated: true,
		}
	}

	const headChars = Math.ceil(maxChars / 2)
	const tailStart = totalChars - Math.floor(maxChars / 2)
	const content = []
	let textOffset = 0
	let sawText = false
	let markerAdded = false
	const addMarker = () => {
		if (markerAdded) return
		markerAdded = true
		content.push({ type: "text", text: OUTPUT_TRUNCATION_MARKER })
	}
	for (const item of source) {
		if (item?.type !== "text") {
			content.push(item)
			continue
		}
		if (sawText) textOffset++
		sawText = true
		const start = textOffset
		const end = start + item.text.length
		const headEnd = Math.min(end, headChars)
		if (headEnd > start) content.push({ ...item, text: item.text.slice(0, headEnd - start) })
		const itemTailStart = Math.max(start, tailStart)
		if (itemTailStart < end) {
			addMarker()
			content.push({ ...item, text: item.text.slice(itemTailStart - start) })
		}
		textOffset = end
	}
	addMarker()
	return { content, truncated: true }
}

function statusText(status, elapsedMs, cellId) {
	const label = status === "running"
		? `Script running with cell ID ${cellId}`
		: status === "completed"
			? "Script completed"
			: status === "terminated"
				? "Script terminated"
				: "Script failed"
	return `${label}\nWall time ${(elapsedMs / 1000).toFixed(1)} seconds\nOutput:`
}

export class CodeModeRuntime {
	/**
	 * @param {{ getAgent?: () => any, cellHost?: any, recordPlanUpdate?: (update: any, source: any) => Promise<void> }} [options]
	 */
	constructor(options = {}) {
		this.getAgent = options.getAgent
		this.cellHost = options.cellHost
		this.recordPlanUpdate = options.recordPlanUpdate
		this.tools = []
		this.cells = new Map()
		this.nextCellId = 1
		this.storedValues = new Map()
		this.dispatchGate = new ToolDispatchGate()
		this.dispatchLifecycleSeen = false
		this.dispatchActive = false
		this.dispatchWaiters = new Set()
		this.unsubscribeAgent = undefined
		this.disposed = false
	}

	bindAgent(agent) {
		this.unsubscribeAgent?.()
		this.unsubscribeAgent = agent?.subscribe?.((event) => {
			if (event.type === "agent_start") {
				this.dispatchLifecycleSeen = true
				this.dispatchActive = true
				for (const waiter of this.dispatchWaiters) waiter()
				this.dispatchWaiters.clear()
			} else if (event.type === "agent_end") {
				this.dispatchActive = false
			}
		})
	}

	async waitForDispatchTurn(signal) {
		if (this.disposed) throw new Error("Code-mode runtime is disposed")
		if (!this.dispatchLifecycleSeen || this.dispatchActive) return
		if (signal?.aborted) throw new Error("Operation aborted")
		await new Promise((resolve, reject) => {
			let settled = false
			const finish = (error) => {
				if (settled) return
				settled = true
				this.dispatchWaiters.delete(finish)
				signal?.removeEventListener("abort", aborted)
				if (error) reject(error)
				else resolve()
			}
			const aborted = () => finish(new Error("Operation aborted"))
			this.dispatchWaiters.add(finish)
			signal?.addEventListener("abort", aborted, { once: true })
			if (this.dispatchActive) finish()
			else if (signal?.aborted) aborted()
		})
	}

	async runNestedTool(cell, tool, operation) {
		while (true) {
			await this.waitForDispatchTurn(cell.controller.signal)
			const release = await this.dispatchGate.acquire(tool.executionMode === "sequential", cell.controller.signal)
			if (!this.dispatchLifecycleSeen || this.dispatchActive) {
				try {
					if (cell.controller.signal.aborted) throw new Error("Operation aborted")
					return await operation()
				} finally {
					release()
				}
			}
			release()
		}
	}

	setTools(tools) {
		this.tools = tools.filter((tool) => tool.exposure !== "direct_model_only")
		const definitions = createCodeModeToolDefinitions(this.tools)
		definitions[0].execute = (id, input, signal, onUpdate) => this.execute(id, input, signal, onUpdate)
		definitions[1].execute = (id, args, signal, onUpdate) => this.wait(id, args, signal, onUpdate)
		return definitions
	}

	async dispatchNestedTool(cell, request) {
		const tool = cell.tools.get(request.name)
		if (!tool) throw new Error(`Tool "${request.name}" is not available in this code-mode cell`)
		const toolCallId = `exec-${randomUUID()}`
		const toolCall = tool.kind === "custom"
			? { type: "toolCall", id: toolCallId, name: tool.name, input: request.input }
			: { type: "toolCall", id: toolCallId, name: tool.name, arguments: request.input ?? {} }
		let preparedToolCall = toolCall
		if (tool.kind !== "custom" && tool.prepareArguments) {
			const args = tool.prepareArguments(toolCall.arguments)
			if (args !== toolCall.arguments) preparedToolCall = { ...toolCall, arguments: args }
		}
		const args = validateToolArguments(tool, preparedToolCall)
		return this.runNestedTool(cell, tool, async () => {
			const agent = this.getAgent?.()
			const context = agent?.createContextSnapshot?.() ?? {
				systemPrompt: agent?.state?.systemPrompt ?? "",
				messages: agent?.state?.messages?.slice?.() ?? [],
				tools: agent?.state?.tools?.slice?.() ?? [],
			}
			context.tools = [...cell.tools.values()]
			const baseAssistantMessage = syntheticAssistantMessage(agent)
			const assistantMessage = {
				...baseAssistantMessage,
				content: [toolCall],
			}
			const before = await agent?.beforeToolCall?.({ assistantMessage, toolCall, args, context }, cell.controller.signal)
			if (before?.block) throw new Error(before.reason || "Nested tool execution was blocked")
			const executorOptions = cell.executorToolOptions.get(tool.name)
			let result = executorOptions
				? await cell.host.executeTool(
					tool.name,
					toolCall.id,
					args,
					cell.controller.signal,
					(partial) => cell.onUpdate?.(partial),
					executorOptions,
				)
				: await tool.execute(
					toolCall.id,
					args,
					cell.controller.signal,
					(partial) => cell.onUpdate?.(partial),
				)
			const after = await agent?.afterToolCall?.({
				assistantMessage,
				toolCall,
				args,
				result,
				isError: false,
				context,
			}, cell.controller.signal)
			const finalized = mergeAfterToolResult(result, after)
			result = finalized.result
			if (finalized.isError) throw new Error(resultErrorText(result))
			if (tool.name === UPDATE_PLAN_TOOL_NAME) {
				await this.recordPlanUpdate?.(args, {
					outerToolCallId: cell.outerToolCallId,
					cellId: cell.id,
					runtimeToolCallId: String(request.id),
				})
			}
			return codeModeResult(tool, result)
		})
	}

	allocateCellId() {
		const id = this.nextCellId
		if (!Number.isSafeInteger(id) || id >= Number.MAX_SAFE_INTEGER) {
			throw new Error("Code-mode cell ID space exhausted")
		}
		this.nextCellId = id + 1
		return String(id)
	}

	async startCell(code, ownerSignal, outerToolCallId) {
		if (this.disposed) throw new Error("Code-mode runtime is disposed")
		if (!this.cellHost?.startCodeModeCell) throw new Error("Code mode requires a configured tool executor")
		const id = this.allocateCellId()
		const tools = new Map(this.tools.map((tool) => [tool.name, tool]))
		const executorToolOptions = new Map(this.tools.flatMap((tool) => {
			const info = executorProxyInfo(tool)
			if (!info || info.executor !== this.cellHost) return []
			return [[tool.name, {
				scope: info.getScope?.(),
				toolProfile: info.toolProfile,
			}]]
		}))
		const cell = {
			id,
			outerToolCallId,
			host: undefined,
			controller: new AbortController(),
			tools,
			executorToolOptions,
			startedAt: Date.now(),
			status: "running",
			error: undefined,
			fatalError: undefined,
			output: [],
			events: [],
			storedValueWrites: new Map(),
			listeners: new Set(),
			onUpdate: undefined,
			ownerSignal,
			ownerAbort: undefined,
			aborted: false,
		}
		cell.ownerAbort = () => {
			cell.aborted = true
			this.terminateCell(cell)
			this.closeCell(cell)
		}
		this.cells.set(id, cell)
		this.bindOwnerSignal(cell, ownerSignal)
		try {
			cell.host = await this.cellHost.startCodeModeCell({
				id,
				code,
				tools: codeModeToolMetadata([...cell.tools.values()]),
				storedValues: [...this.storedValues.entries()],
				maxOutputChars: MAX_OUTPUT_TOKENS * APPROX_CHARS_PER_TOKEN,
			}, {
				onToolCall: async (request) => {
					if (cell.status !== "running") throw new Error(`Code-mode cell ${cell.id} is not running`)
					try {
						return await this.dispatchNestedTool(cell, request)
					} catch (error) {
						if (isUncertainToolExecutionError(error)) this.failCell(cell, error)
						throw error
					}
				},
				onEvent: (method, params) => this.handleNotification(cell, method, params),
				onFailure: (error) => this.failCell(cell, error),
			})
			if (cell.aborted || this.disposed || this.cells.get(id) !== cell) {
				cell.host.close()
				throw new Error("Operation aborted")
			}
			return cell
		} catch (error) {
			this.cells.delete(id)
			cell.ownerSignal?.removeEventListener("abort", cell.ownerAbort)
			cell.controller.abort()
			cell.host?.close()
			if (cell.aborted) throw new Error("Operation aborted")
			if (cell.fatalError) throw cell.fatalError
			throw error
		}
	}

	bindOwnerSignal(cell, signal) {
		cell.ownerSignal?.removeEventListener("abort", cell.ownerAbort)
		cell.ownerSignal = signal
		signal?.addEventListener("abort", cell.ownerAbort, { once: true })
	}

	handleNotification(cell, method, params) {
		if (cell.status !== "running") return
		if (method === "output") {
			if (params?.item) cell.output.push(params.item)
			return
		}
		if (method === "store") {
			if (typeof params?.key === "string") cell.storedValueWrites.set(params.key, params.value)
			return
		}
		if (method === "yield") {
			cell.events.push({ status: "running", output: cell.output.splice(0) })
			this.notifyCell(cell)
			return
		}
		if (method === "complete") {
			cell.status = params?.error ? "failed" : "completed"
			cell.error = params?.error
			for (const [key, value] of cell.storedValueWrites) this.storedValues.set(key, value)
			cell.events.push({ status: cell.status, output: cell.output.splice(0), error: cell.error })
			cell.controller.abort()
			this.notifyCell(cell)
		}
	}

	failCell(cell, error) {
		if (cell.status !== "running") return
		cell.status = "failed"
		cell.fatalError = error
		cell.events.length = 0
		cell.controller.abort()
		this.notifyCell(cell)
		cell.host?.terminate()
	}

	notifyCell(cell) {
		for (const listener of cell.listeners) listener()
		cell.listeners.clear()
	}

	async waitForCellChange(cell, yieldTimeMs, signal) {
		if (cell.events.length > 0 || cell.fatalError) return "changed"
		if (signal?.aborted) return "aborted"
		return new Promise((resolve) => {
			let settled = false
			const finish = (outcome) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				cell.listeners.delete(changed)
				signal?.removeEventListener("abort", aborted)
				resolve(outcome)
			}
			const changed = () => finish("changed")
			const aborted = () => finish("aborted")
			const timer = setTimeout(() => finish("timeout"), yieldTimeMs)
			cell.listeners.add(changed)
			signal?.addEventListener("abort", aborted, { once: true })
			if (signal?.aborted) aborted()
		})
	}

	consumeCellOutput(cell, items, maxTokens) {
		cell.host?.resetOutput()
		return truncateContent(items, maxTokens)
	}

	resultForCell(cell, event, maxTokens) {
		if (cell.fatalError) throw cell.fatalError
		const elapsedMs = Date.now() - cell.startedAt
		const status = event?.status ?? "running"
		const output = event?.output ?? cell.output.splice(0)
		const rawContent = status === "failed"
			? [...output, { type: "text", text: `Script error:\n${event?.error ?? cell.error ?? "Unknown code-mode error"}` }]
			: output
		const { content, truncated } = this.consumeCellOutput(cell, rawContent, maxTokens)
		const header = { type: "text", text: statusText(status, elapsedMs, cell.id) }
		if (status === "failed") {
			const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
			throw new Error(`${header.text}${text ? `\n${text}` : ""}`)
		}
		return {
			content: [header, ...content],
			details: {
				codeMode: {
					status,
					cellId: status === "running" ? cell.id : undefined,
					wallTimeMs: elapsedMs,
					truncated,
				},
			},
		}
	}

	async observeCell(cell, options) {
		cell.onUpdate = options.onUpdate
		let closeAfter = false
		try {
			if (options.terminate) {
				this.terminateCell(cell)
				if (cell.status !== "running") {
					const terminalIndex = cell.events.findIndex((event) => event.status !== "running")
					if (terminalIndex > 0) {
						const terminal = cell.events[terminalIndex]
						terminal.output = cell.events.slice(0, terminalIndex + 1).flatMap((event) => event.output ?? [])
						cell.events.splice(0, terminalIndex + 1, terminal)
					}
				}
			} else {
				const outcome = await this.waitForCellChange(cell, options.yieldTimeMs, options.signal)
				if (outcome === "aborted") {
					this.terminateCell(cell)
					closeAfter = true
					throw new Error("Operation aborted")
				}
			}
			const event = cell.events.shift()
			if (cell.aborted) {
				closeAfter = true
				throw new Error("Operation aborted")
			}
			closeAfter = (event?.status ?? "running") !== "running"
			const result = this.resultForCell(cell, event, options.maxTokens)
			return result
		} finally {
			cell.onUpdate = undefined
			if (cell.fatalError || closeAfter) this.closeCell(cell)
		}
	}

	async execute(toolCallId, input, signal, onUpdate) {
		if (signal?.aborted) throw new Error("Operation aborted")
		const parsed = parseExecSource(input)
		const maxTokens = normalizeOutputTokens(parsed.maxOutputTokens)
		const cell = await this.startCell(parsed.code, signal, toolCallId)
		return this.observeCell(cell, {
			yieldTimeMs: normalizeDuration(parsed.yieldTimeMs),
			maxTokens,
			signal,
			onUpdate,
		})
	}

	async wait(_toolCallId, args, signal, onUpdate) {
		if (!args || typeof args.cell_id !== "string") throw new Error("cell_id is required")
		const cell = this.cells.get(args.cell_id)
		if (!cell) {
			throw new Error(`${statusText("failed", 0, args.cell_id)}\nScript error:\nexec cell ${args.cell_id} not found`)
		}
		this.bindOwnerSignal(cell, signal)
		return this.observeCell(cell, {
			yieldTimeMs: normalizeDuration(args.yield_time_ms),
			maxTokens: normalizeOutputTokens(args.max_tokens),
			signal,
			onUpdate,
			terminate: args.terminate === true,
		})
	}

	terminateCell(cell) {
		if (cell.status === "running") {
			const queuedOutput = cell.events.flatMap((event) => event.output ?? [])
			cell.events.length = 0
			cell.status = "terminated"
			cell.events.push({ status: "terminated", output: [...queuedOutput, ...cell.output.splice(0)] })
			cell.controller.abort()
			this.notifyCell(cell)
		}
		cell.host?.terminate()
	}

	closeCell(cell) {
		this.cells.delete(cell.id)
		cell.ownerSignal?.removeEventListener("abort", cell.ownerAbort)
		cell.host?.close()
	}

	clear() {
		for (const cell of [...this.cells.values()]) {
			this.terminateCell(cell)
			this.closeCell(cell)
		}
		this.storedValues.clear()
	}

	dispose() {
		if (this.disposed) return
		this.disposed = true
		this.unsubscribeAgent?.()
		this.unsubscribeAgent = undefined
		for (const waiter of this.dispatchWaiters) waiter(new Error("Code-mode runtime is disposed"))
		this.dispatchWaiters.clear()
		this.clear()
	}
}
