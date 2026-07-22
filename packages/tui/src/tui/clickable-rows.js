import { visibleWidth } from "./utils.js";

/**
 * Build a full-row click span for list-like controls.
 *
 * The span covers at least the rendered line text and, when possible, the whole
 * component width. This keeps row selection ergonomic without making callers
 * depend on terminal coordinates.
 *
 * @param {object} options
 * @param {number} options.line
 * @param {string} options.text
 * @param {number} options.width
 * @param {any} options.component
 * @param {string} options.id
 * @param {string} [options.role]
 * @param {string} [options.label]
 * @param {any} [options.metadata]
 * @param {(event: any) => any} options.onClick
 * @param {(event: any) => any} [options.onContextMenu]
 * @param {number} [options.startCol]
 * @returns {import("./render-frame.js").RenderSpan | null}
 */
export function clickableRowSpan(options) {
	const startCol = Math.max(0, Math.floor(options.startCol ?? 0));
	const rowWidth = Math.max(visibleWidth(options.text), Math.floor(options.width));
	const endCol = Math.max(startCol, rowWidth);
	if (endCol <= startCol) return null;
	return {
		line: Math.max(0, Math.floor(options.line)),
		startCol,
		endCol,
		component: options.component,
		id: options.id,
		role: options.role ?? "option",
		label: options.label,
		metadata: options.metadata,
		onClick: options.onClick,
		onContextMenu: options.onContextMenu,
	};
}
