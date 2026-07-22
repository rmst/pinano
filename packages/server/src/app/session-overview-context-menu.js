/**
 * @typedef {"open" | "markCompleted" | "markDeferred" | "lifecycle"} SessionOverviewContextMenuHandler
 * @typedef {{ type: "separator" }} SessionOverviewContextMenuSeparator
 * @typedef {{ id: "open" | "complete" | "defer" | "stop" | "delete" | "restore", label: string, handler: SessionOverviewContextMenuHandler, danger?: boolean }} SessionOverviewContextMenuAction
 * @typedef {SessionOverviewContextMenuAction | SessionOverviewContextMenuSeparator} SessionOverviewContextMenuItem
 */

/**
 * @param {{ deleted?: boolean, running?: boolean, state?: string }} session
 * @returns {SessionOverviewContextMenuItem[]}
 */
export function sessionOverviewContextMenuItems(session) {
	if (session.deleted) {
		return [{ id: "restore", label: "Restore", handler: "lifecycle" }]
	}
	const items = [
		{ id: "open", label: "Open", handler: "open" },
	]
	if (!session.running) {
		items.push(
			{
				id: "complete",
				label: session.state === "completed" ? "Reopen for review" : "Mark completed",
				handler: "markCompleted",
			},
			{
				id: "defer",
				label: session.state === "deferred" ? "Reopen for review" : "Defer",
				handler: "markDeferred",
			},
		)
	}
	items.push(
		{ type: "separator" },
		session.running
			? { id: "stop", label: "Stop", handler: "lifecycle", danger: true }
			: { id: "delete", label: "Delete", handler: "lifecycle", danger: true },
	)
	return items
}
