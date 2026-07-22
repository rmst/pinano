import { envWithFallbackTools } from "./fallback-tools.js"
import { envWithInternalProxyTools } from "./internal-proxy-tools.js"
import { envWithPinanoCommands } from "./pinano-commands.js"

function withToolCallId(baseEnv, toolCallId) {
	if (toolCallId === undefined || toolCallId === null) return { ...baseEnv }
	return { ...baseEnv, PINANO_TOOL_CALL_ID: String(toolCallId) }
}

export function envForToolSubprocess(baseEnv = process.env, options = {}) {
	return envWithFallbackTools(envWithInternalProxyTools(envWithPinanoCommands(withToolCallId(baseEnv, options.toolCallId))))
}
