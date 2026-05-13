// Promise-wrapped Input overlay for one-shot text prompts (API key entry,
// session rename, etc).

import { Input } from "../../tui/index.ts"
import type { TUI } from "../../tui/index.ts"

export async function promptForInput(tui: TUI, _label: string): Promise<string | null> {
	const input = new Input()
	return new Promise<string | null>((resolve) => {
		const handle = tui.showOverlay(input, { width: "60%", anchor: "center" })
		const finish = (v: string | null) => {
			handle.hide()
			resolve(v)
		}
		input.onSubmit = (v) => finish(v)
		input.onEscape = () => finish(null)
	})
}
