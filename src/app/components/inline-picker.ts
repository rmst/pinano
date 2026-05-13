// Inline option picker — full-width SelectList wrapped in a titled frame and
// shown in place of the editor via the `showSelector` swap.
//
// Use this for short, prompt-style option lists ("Summarize? [No / Yes / Yes
// with custom prompt]") where a centered modal would feel cramped relative
// to the rest of the UI.

import { Container, SelectList, Spacer, Text } from "../../tui/index.ts"
import type { Component, Focusable, SelectItem } from "../../tui/index.ts"
import { selectListTheme, theme } from "../theme.ts"

class DynamicBorder implements Component {
	private color: (s: string) => string
	constructor(color: (s: string) => string = (s) => theme.fg("border", s)) {
		this.color = color
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))]
	}
}

export class InlinePickerComponent extends Container implements Focusable {
	private list: SelectList
	focused = false

	public onSelect?: (item: SelectItem) => void
	public onCancel?: () => void

	constructor(
		items: SelectItem[],
		opts: { title?: string; subtitle?: string; maxVisible?: number } = {},
	) {
		super()
		if (opts.title) {
			this.addChild(new Spacer(1))
			this.addChild(new Text(theme.bold(opts.title), 1, 0))
			if (opts.subtitle) {
				this.addChild(new Text(theme.fg("muted", opts.subtitle), 1, 0))
			}
			this.addChild(new Spacer(1))
			this.addChild(new DynamicBorder())
			this.addChild(new Spacer(1))
		}

		this.list = new SelectList(items, opts.maxVisible ?? Math.max(items.length, 5), selectListTheme as any)
		this.list.onSelect = (item) => this.onSelect?.(item)
		this.list.onCancel = () => this.onCancel?.()
		this.addChild(this.list)

		if (opts.title) {
			this.addChild(new Spacer(1))
			this.addChild(new DynamicBorder())
		}
	}

	getList(): SelectList {
		return this.list
	}

	handleInput(data: string | Buffer): void {
		this.list.handleInput(data as any)
	}
}

interface ShowSelectorCtx {
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component },
	) => void
}

/**
 * Promise wrapper. Resolves with the picked item's `value`, or `null` on
 * Esc / cancel.
 */
export async function pickInline(
	ctx: ShowSelectorCtx,
	items: SelectItem[],
	opts: { title?: string; subtitle?: string; maxVisible?: number } = {},
): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		ctx.showSelector((done) => {
			const picker = new InlinePickerComponent(items, opts)
			picker.onSelect = (item) => {
				done()
				resolve(item.value)
			}
			picker.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: picker, focus: picker.getList() }
		})
	})
}
