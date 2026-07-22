/** @param {unknown} value */
const singleLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim()

/** @param {any} value */
const projectLabel = (value) => singleLine(value?.label ?? value)

/** @param {any} project */
export function projectHeaderLabel(project) {
	return project?.source === "project-json" ? projectLabel(project) : ""
}
