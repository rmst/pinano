import { envWithFallbackTools } from "./fallback-tools.js"
import { envWithInternalProxyTools } from "./internal-proxy-tools.js"
import { envWithAgentCommands } from "./agent-command-bin.js"
import { applyProductEnvAliases, writeProductEnv } from "../../../protocol/src/product.js"

function withToolCallId(baseEnv, toolCallId) {
	if (toolCallId === undefined || toolCallId === null) return { ...baseEnv }
	return writeProductEnv(baseEnv, "TOOL_CALL_ID", String(toolCallId))
}

export function envForToolSubprocess(baseEnv = process.env, options = {}) {
	return applyProductEnvAliases(envWithFallbackTools(envWithInternalProxyTools(envWithAgentCommands(withToolCallId(baseEnv, options.toolCallId)))))
}
