export const WEB_OVERVIEW_COMMANDS = [
	{ name: "help", description: "show overview commands" },
	{ name: "hotkeys", description: "show overview hotkeys" },
	{ name: "model", description: "select default model for new sessions" },
	{ name: "reasoning", description: "set default reasoning effort for new sessions", takesArgs: true, argumentHint: "[level]" },
]

export const WEB_CHAT_COMMANDS = [
	{ name: "help", description: "show session commands" },
	{ name: "hotkeys", description: "show session hotkeys" },
	{ name: "branch", description: "create a new session from the current conversation branch" },
	{ name: "rewind", description: "rewind to a previous user message or switch to a branch tip" },
	{ name: "session", description: "show info about the current session" },
	{ name: "model", description: "select model for this session" },
	{ name: "reasoning", description: "set reasoning effort for this session", takesArgs: true, argumentHint: "[level]" },
	{ name: "fast", description: "set Codex Fast mode for this session", takesArgs: true, argumentHint: "on|off|status" },
	{ name: "compact", description: "summarize older messages for agent context" },
	{ name: "context", description: "show context usage estimate" },
	{ name: "system", description: "show system prompt, tools, and project context" },
	{ name: "continue", description: "resume an interrupted turn, or ask the model to continue" },
	{ name: "abort", description: "abort the running turn" },
]

const commandKey = (command) => command.name

export const WEB_COMMANDS = [
	...new Map([...WEB_OVERVIEW_COMMANDS, ...WEB_CHAT_COMMANDS].map((command) => [commandKey(command), command])).values(),
]
