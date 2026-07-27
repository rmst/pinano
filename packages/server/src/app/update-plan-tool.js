import { GPT_5_6_SOL_INSTRUCTIONS_KEY, modelUsesInstructionsKey } from "./model/instructions/index.js"

const updatePlanSchema = {
	type: "object",
	properties: {
		explanation: {
			type: "string",
			description: "Optional explanation for this plan update.",
		},
		plan: {
			type: "array",
			description: "The list of steps.",
			items: {
				type: "object",
				properties: {
					step: {
						type: "string",
						description: "Task step text.",
					},
					status: {
						type: "string",
						enum: ["pending", "in_progress", "completed"],
						description: "Step status.",
					},
				},
				required: ["step", "status"],
				additionalProperties: false,
			},
		},
	},
	required: ["plan"],
	additionalProperties: false,
}

export const UPDATE_PLAN_TOOL_NAME = "update_plan"

/** Build the code-mode task-plan tool. The code-mode runtime durably records successful invocations before returning to the cell.
 * @returns {import("../agent-core/types.js").AgentTool} */
export function createUpdatePlanTool() {
	return {
		name: UPDATE_PLAN_TOOL_NAME,
		label: UPDATE_PLAN_TOOL_NAME,
		description: [
			"Updates the task plan.",
			"Provide an optional explanation and a list of plan items, each with a step and status.",
			"At most one step can be in_progress at a time.",
		].join("\n"),
		parameters: updatePlanSchema,
		executionMode: "sequential",
		codeMode: {
			outputSchema: { type: "object", properties: {}, additionalProperties: false },
			projectResult: () => ({}),
		},
		async execute(_toolCallId, _args, signal) {
			if (signal?.aborted) throw new Error("Operation aborted")
			return {
				content: [{ type: "text", text: "Plan updated" }],
				details: {},
			}
		},
	}
}

/** @param {any} model */
export function updatePlanToolsForModel(model) {
	if (!modelUsesInstructionsKey(model, GPT_5_6_SOL_INSTRUCTIONS_KEY)) return []
	return [createUpdatePlanTool()]
}
