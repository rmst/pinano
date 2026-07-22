export const REWIND_PICKER_SUBTITLE = "Pick a prompt to rewind before, or a branch tip to continue from."

export function rewindPromptActionItems(target = {}) {
	const items = [
		{ value: "conversation", label: "Rewind before this prompt", description: "Drops later conversation in this session and restores this prompt in the composer. No model call." },
		{ value: "conversation-summary", label: "Rewind with summary", description: "Summarizes the discarded branch first, then rewinds before this prompt." },
	]
	if (target.hasFileCheckpoints) {
		items.push(
			{ value: "files-conversation", label: "Restore files and rewind", description: "Restores edited files to their checkpoint preimages, then rewinds before this prompt." },
			{ value: "files", label: "Restore files only", description: "Restores edited files to their checkpoint preimages and leaves the conversation where it is." },
		)
	}
	items.push({ value: "branch", label: "Branch new session from here", description: "Leaves this session unchanged and starts a new session with this prompt restored." })
	return items
}
