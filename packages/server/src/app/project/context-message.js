/** Browser-safe project-context message predicates. Loading project context is Node-only; identifying already-materialized context messages is pure data inspection. */

/** @param {any} message @returns {boolean} */
export function isProjectContextMessage(message) {
	if (message?.role !== "user") return false
	return message.projectContext === true
}

/** @param {ReadonlyArray<any>} messages @returns {boolean} */
export function hasProjectContextMessage(messages) {
	return messages.some(isProjectContextMessage)
}
