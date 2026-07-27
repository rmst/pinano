export const REWIND_PICKER_SUBTITLE = "Pick a prompt to rewind before, or a branch tip to continue from."

export function rewindPromptActionItems(target = {}) {
	const items = [
		{ value: "conversation", label: "Rewind", description: "Drops later conversation in this session and restores this prompt in the composer. No model call." },
	]
	if (target.hasFileCheckpoints) {
		items.push({ value: "files-conversation", label: "Rewind and restore files", description: "Restores edited files to their checkpoint preimages, then rewinds before this prompt." })
	}
	items.push({ value: "branch", label: "Branch new session from here", description: "Leaves this session unchanged and starts a new session with this prompt restored." })
	return items
}
