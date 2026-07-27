import { createDefaultTools } from "../../../tools/index.js"

const EXECUTOR_PROXY = Symbol("toolExecutor.proxy")

/** @param {any} tool */
function serializableTool(tool) {
	const { execute: _execute, ...rest } = tool
	return rest
}

/**
 * Build service-side proxy tools. Metadata and argument preparation stay local;
 * execution is delegated to a ToolExecutor so effectful code stays outside the service.
 * @param {string} cwd
 * @param {{ executeTool: (name: string, id: string, args: any, signal?: AbortSignal, onUpdate?: (update: any) => void, options?: { scope?: any, toolProfile?: "default" | "codex" }) => Promise<any> }} executor
 * @param {{ getScope?: () => any, toolProfile?: "default" | "codex" }} [options]
 */
export function createExecutorProxyTools(cwd, executor, options = {}) {
	return createDefaultTools(cwd, { toolProfile: options.toolProfile }).map((tool) => {
		const proxy = {
			...serializableTool(tool),
			execute: (id, args, signal, onUpdate) => executor.executeTool(tool.name, id, args, signal, onUpdate, {
				scope: options.getScope?.(),
				toolProfile: options.toolProfile,
			}),
		}
		Object.defineProperty(proxy, EXECUTOR_PROXY, {
			value: {
				executor,
				getScope: options.getScope,
				toolProfile: options.toolProfile,
			},
		})
		return proxy
	})
}

/** @param {any} tool */
export function executorProxyInfo(tool) {
	return tool?.[EXECUTOR_PROXY]
}
