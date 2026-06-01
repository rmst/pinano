import { SESSION_SET_TOOL_NAME } from "./session-properties.js"

/** @param {Record<string, any> | undefined} values */
function propertyNames(values) {
	return Object.keys(values ?? {})
}

/** @param {Record<string, any> | undefined} values */
function jsonObject(values) {
	return JSON.stringify(values ?? {}, null, "\t")
}

/** @param {any} info */
export function formatSessionSetToolResult(info) {
	const write = info?.sessionWrite
	if (!write || typeof write !== "object") return `Updated session properties: ${jsonObject(info?.properties ?? info?.overview ?? info)}`

	const changedNames = propertyNames(write.changed)
	const unchangedNames = propertyNames(write.unchanged)
	const lines = [write.noChange || changedNames.length === 0 ? "No session properties changed." : "Session properties updated."]
	if (unchangedNames.length > 0) {
		const fields = unchangedNames.join(", ")
		const prefix = changedNames.length === 0
			? "Warning: this sessionWrite call was unnecessary because all supplied fields were unchanged"
			: "Warning: unchanged fields were included and should be omitted next time"
		lines.push(`${prefix}: ${fields}.`)
	}
	return lines.join("\n")
}

/**
 * @param {{ request?: () => ((request: any) => Promise<any>) | undefined }} options
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createSessionSetTool(options = {}) {
	return {
		name: SESSION_SET_TOOL_NAME,
		label: SESSION_SET_TOOL_NAME,
		description: `Update Pinano session properties. Never include properties whose values should remain unchanged! The "state", "descriptionInUi" and "projectTag" properties are checked after every turn during an automated session metadata check, they usually shouldn't be updated otherwise.`,
		parameters: {
			type: "object",
			properties: {
				state: {
					type: "string",
					enum: ["readyForReview", "needs_input", "completed"],
					description: "Current session state shown in Pinano UI. It automatically resets to readyForReview at the start of every turn. Use needs_input when blocked on the user. Use completed only when it is unlikely that the user will return to the session, e.g. when everything that has ever been discussed has been fully addressed and all changes have been committed/merged and ongoing discussions have been resolved.",
				},
				descriptionInUi: {
					type: "string",
					description: "Short stable label for the session shown in the UI, ideally 6–12 words. Don't include minutiae. It must capture the overarching long-term goal(s) of the entire session not just the most recent goal.",
				},
				projectTag: {
					type: "string",
					description: "Short stable project tag shown in the UI.",
				},
				cwd: {
					type: "string",
					description: "Absolute working directory for subsequent tool calls, interpreted inside the selected environment.",
				},
				environmentId: {
					type: "string",
					description: "Configured environment id for subsequent tool calls. Switching to an environment with a configured cwd also switches cwd unless cwd is supplied explicitly.",
				},
			},
			additionalProperties: false,
		},
		executionMode: "sequential",
		async execute(toolCallId, args, signal) {
			if (signal?.aborted) throw new Error("Operation aborted")
			if (args?.state === "deferred") throw new Error("deferred cannot be set through sessionWrite; use the Pinano UI")
			if (args?.state === null || args?.state === "null") throw new Error("state cannot be null; omit state instead")
			if (args?.descriptionInUi === null) throw new Error("descriptionInUi cannot be null; omit it instead")
			if (args?.projectTag === null) throw new Error("projectTag cannot be null; omit it instead")
			const request = options.request?.()
			if (!request) throw new Error("sessionWrite is unavailable in this context")
			const info = await request({
				op: "sessionWrite",
				patch: args,
				source: { kind: "tool", name: SESSION_SET_TOOL_NAME, toolCallId },
			})
			return {
				content: [{ type: "text", text: formatSessionSetToolResult(info) }],
				details: { session: info },
			}
		},
	}
}
