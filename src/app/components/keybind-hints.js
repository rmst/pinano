// Single-line keybinding hint chip strip rendered above the editor.

import { Text } from "../../tui/index.js"
import { theme } from "../theme.js"

const HINTS = [
	{ key: "Enter", action: "send" },
	{ key: "Shift+Enter", action: "newline" },
	{ key: "Tab", action: "complete" },
	{ key: "Esc Esc", action: "rewind" },
	{ key: "Ctrl+C", action: "abort/exit" },
	{ key: "Ctrl+L", action: "clear" },
	{ key: "Ctrl+P", action: "cycle model" },
	{ key: "/help", action: "commands" },
]

/** @returns {Text} */
export function buildKeybindHints() {
	const text = HINTS.map((h) => `${theme.cyan(h.key)} ${theme.dim(h.action)}`).join(theme.dim("  ·  "))
	return new Text(text, 0, 0)
}
