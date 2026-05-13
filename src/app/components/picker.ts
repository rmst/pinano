// Promise-wrapped SelectList overlay.
//
// Resolves with the chosen item.value, or null on Esc/cancel.

import { SelectList } from "../../tui/index.ts"
import type { SelectItem, TUI } from "../../tui/index.ts"
import { editorTheme } from "../theme.ts"

export interface PickerOptions {
	maxVisible?: number
	width?: number | string
	maxHeight?: number | string
}

export async function pickFromOverlay(
	tui: TUI,
	items: SelectItem[],
	options: PickerOptions = {},
): Promise<string | null> {
	const list = new SelectList(items, options.maxVisible ?? 10, editorTheme.selectList as any)

	return new Promise<string | null>((resolve) => {
		const handle = tui.showOverlay(list, {
			width: options.width ?? "60%",
			maxHeight: options.maxHeight ?? "70%",
			anchor: "center",
		})
		const finish = (value: string | null) => {
			handle.hide()
			resolve(value)
		}
		list.onSelect = (item) => finish(item.value)
		list.onCancel = () => finish(null)
	})
}
