export const PLAN_UPDATE_CUSTOM_TYPE = "plan_update"
export const PLAN_UPDATE_MESSAGE_ROLE = "planUpdate"

const STATUSES = new Set(["pending", "in_progress", "completed"])

const objectOrUndefined = (value) =>
	value && typeof value === "object" && !Array.isArray(value) ? value : undefined

const optionalString = (value) => typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Normalize the durable representation at the service boundary. Invalid updates are rejected rather than persisted as transcript data that cannot be rendered reliably.
 * @param {unknown} value
 */
export function normalizePlanUpdateEntryData(value) {
	const data = objectOrUndefined(value)
	if (!data || !Array.isArray(data.plan)) throw new TypeError("plan must be an array")
	const plan = data.plan.map((item, index) => {
		const step = objectOrUndefined(item)
		if (typeof step?.step !== "string" || !step.step.trim()) throw new TypeError(`plan[${index}].step must be a non-empty string`)
		if (!STATUSES.has(step.status)) throw new TypeError(`plan[${index}].status is invalid`)
		return { step: step.step, status: step.status }
	})
	if (plan.filter((item) => item.status === "in_progress").length > 1) throw new TypeError("at most one plan step can be in_progress")
	const source = objectOrUndefined(data.source)
	const recordedAt = optionalString(data.recordedAt) ?? new Date().toISOString()
	if (!Number.isFinite(Date.parse(recordedAt))) throw new TypeError("recordedAt must be a valid timestamp")
	return {
		version: 1,
		...(optionalString(data.explanation) ? { explanation: data.explanation } : {}),
		plan,
		recordedAt,
		...(optionalString(data.runId) ? { runId: data.runId } : {}),
		...(source ? {
			source: {
				...(optionalString(source.outerToolCallId) ? { outerToolCallId: source.outerToolCallId } : {}),
				...(optionalString(source.cellId) ? { cellId: source.cellId } : {}),
				...(optionalString(source.runtimeToolCallId) ? { runtimeToolCallId: source.runtimeToolCallId } : {}),
			},
		} : {}),
	}
}

export function planUpdateDisplayText(update) {
	const statusMarker = { completed: "✓", in_progress: "→", pending: "○" }
	return [
		update.explanation,
		...update.plan.map((item) => `${statusMarker[item.status]} ${item.step}`),
	].filter(Boolean).join("\n")
}

export function planUpdateDisplayMessage(update) {
	return {
		role: PLAN_UPDATE_MESSAGE_ROLE,
		content: [{ type: "text", text: planUpdateDisplayText(update) }],
		timestamp: Date.parse(update.recordedAt),
		planUpdate: {
			...(update.explanation ? { explanation: update.explanation } : {}),
			plan: update.plan,
		},
	}
}

export function planUpdateDisplayMessageForEntry(entry) {
	if (entry?.type !== "custom" || entry.customType !== PLAN_UPDATE_CUSTOM_TYPE) return null
	try {
		return planUpdateDisplayMessage(normalizePlanUpdateEntryData(entry.data))
	} catch {
		return null
	}
}
