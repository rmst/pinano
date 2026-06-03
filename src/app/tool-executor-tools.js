import { createDefaultTools } from "../tools/index.js"

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
	return createDefaultTools(cwd, { toolProfile: options.toolProfile }).map((tool) => ({
		...serializableTool(tool),
		execute: (id, args, signal, onUpdate) => executor.executeTool(tool.name, id, args, signal, onUpdate, {
			scope: options.getScope?.(),
			toolProfile: options.toolProfile,
		}),
	}))
}
