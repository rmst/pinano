// Full-width model selector shown via chat-mode's `showSelector` swap.
// Mirrors pi's model selector shape: search input, provider badges, current
// marker, and an optional all/scoped toggle when scoped models are configured.

import {
	Container,
	Input,
	Spacer,
	Text,
	fuzzyFilter,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "../../tui/index.ts"
import type { Component, Focusable } from "../../tui/index.ts"
import { theme } from "../theme.ts"
import type { ModelEntry } from "../models.ts"
import { modelEntryMatches, modelRef, modelRefMatches } from "../models.ts"

export interface ModelRow {
	value: string
	entry: ModelEntry
	current?: boolean
	scoped?: boolean
}

type ModelSelectorMode = "select" | "toggle"
type ModelScope = "all" | "scoped"

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

function providerLabel(entry: ModelEntry): string {
	if (entry.provider === "openai-codex") return "ChatGPT"
	if (entry.provider === "openai") return "OpenAI API"
	if (entry.provider === "llamacpp") return "llama.cpp"
	return entry.provider
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`
	return String(n)
}

function costText(entry: ModelEntry): string {
	if (entry.authProvider === "openai-codex") return "subscription"
	const input = entry.cost.input
	const output = entry.cost.output
	if (!input && !output) return "free/local"
	return `$${input}/$${output}`
}

class ModelList implements Component, Focusable {
	private allRows: ModelRow[]
	private scopedRows: ModelRow[]
	private activeRows: ModelRow[]
	private filteredRows: ModelRow[]
	private selectedIndex = 0
	private scope: ModelScope
	private mode: ModelSelectorMode
	private searchInput: Input
	private onScopeChange: (scope: ModelScope) => void
	focused = false

	public onSelect?: (row: ModelRow) => void
	public onCancel?: () => void

	constructor(
		rows: ModelRow[],
		opts: {
			mode: ModelSelectorMode
			initialSelectedValue?: string
			initialScope?: ModelScope
			searchInput: Input
			onScopeChange: (scope: ModelScope) => void
		},
	) {
		this.allRows = rows
		this.scopedRows = rows.filter((r) => r.scoped)
		this.scope = opts.initialScope ?? "all"
		this.mode = opts.mode
		this.searchInput = opts.searchInput
		this.onScopeChange = opts.onScopeChange
		this.activeRows = this.scope === "scoped" ? this.scopedRows : this.allRows
		this.filteredRows = this.activeRows
		const initial = opts.initialSelectedValue
			? this.filteredRows.findIndex((r) => r.value === opts.initialSelectedValue)
			: this.filteredRows.findIndex((r) => r.current)
		this.selectedIndex = initial >= 0 ? initial : 0
	}

	invalidate(): void {}

	setScope(scope: ModelScope): void {
		if (this.scope === scope) return
		this.scope = scope
		this.activeRows = this.scope === "scoped" ? this.scopedRows : this.allRows
		const currentIndex = this.activeRows.findIndex((r) => r.current)
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0
		this.filter(this.searchInput.getValue())
		this.onScopeChange(this.scope)
	}

	getScope(): ModelScope {
		return this.scope
	}

	hasScopedRows(): boolean {
		return this.scopedRows.length > 0
	}

	filter(query: string): void {
		this.filteredRows = query
			? fuzzyFilter(
					this.activeRows,
					query,
					({ entry, value }) => `${value} ${entry.id} ${entry.displayName} ${entry.provider} ${providerLabel(entry)}`,
				)
			: this.activeRows
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredRows.length - 1))
	}

	private renderRow(row: ModelRow, selected: boolean, width: number): string[] {
		const entry = row.entry
		const cursor = selected ? theme.fg("accent", "› ") : "  "
		const provider = theme.fg("muted", `[${providerLabel(entry)}]`)
		const check = row.current ? theme.fg("success", " ✓") : ""
		const scoped = this.mode === "toggle" && row.scoped ? theme.fg("accent", " scoped") : ""
		const toggle = this.mode === "toggle" ? (row.scoped ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ")) : ""
		const title = selected ? theme.fg("accent", entry.id) : entry.id
		const summaryParts = [
			entry.displayName,
			`${formatTokens(entry.contextWindow)} ctx`,
			`${formatTokens(entry.maxTokens)} out`,
			costText(entry),
		]
		const prefix = `${cursor}${toggle}${title} ${provider}${check}${scoped}`
		const summary = theme.fg("dim", `  ${summaryParts.join(" · ")}`)
		const remaining = Math.max(1, width - visibleWidth(prefix) - 1)
		return [prefix + truncateToWidth(summary, remaining, "…")]
	}

	render(width: number): string[] {
		if (this.filteredRows.length === 0) return [theme.fg("muted", "  No matching models")]

		const maxVisible = 10
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredRows.length - maxVisible),
		)
		const endIndex = Math.min(startIndex + maxVisible, this.filteredRows.length)
		const lines: string[] = []
		for (let i = startIndex; i < endIndex; i++) {
			const row = this.filteredRows[i]
			if (!row) continue
			lines.push(...this.renderRow(row, i === this.selectedIndex, width))
		}
		if (startIndex > 0 || endIndex < this.filteredRows.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredRows.length})`))
		}
		return lines
	}

	handleInput(keyData: string | Buffer): void {
		const data = typeof keyData === "string" ? keyData : keyData.toString("binary")
		const kb = getKeybindings()
		if (kb.matches(data, "tui.input.tab") && this.hasScopedRows()) {
			this.setScope(this.scope === "all" ? "scoped" : "all")
			return
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredRows.length === 0) return
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredRows.length - 1 : this.selectedIndex - 1
			return
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredRows.length === 0) return
			this.selectedIndex = this.selectedIndex === this.filteredRows.length - 1 ? 0 : this.selectedIndex + 1
			return
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const row = this.filteredRows[this.selectedIndex]
			if (row) this.onSelect?.(row)
			return
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.()
			return
		}
		this.searchInput.handleInput(data)
		this.filter(this.searchInput.getValue())
	}
}

export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input
	private list: ModelList
	private scopeText?: Text
	private _focused = false

	public onSelect?: (row: ModelRow) => void
	public onCancel?: () => void

	get focused(): boolean {
		return this._focused
	}
	set focused(value: boolean) {
		this._focused = value
		this.searchInput.focused = value
	}

	constructor(
		rows: ModelRow[],
		opts: {
			mode?: ModelSelectorMode
			initialSelectedValue?: string
			title?: string
			subtitle?: string
			initialSearchInput?: string
		} = {},
	) {
		super()
		const mode = opts.mode ?? "select"
		this.addChild(new Spacer(1))
		this.addChild(new Text(theme.bold(opts.title ?? (mode === "toggle" ? "Scoped models" : "Select model")), 1, 0))
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					opts.subtitle ??
						(mode === "toggle"
							? "Enter toggles the selected model. OAuth-backed models are listed first."
							: "Type to search. OAuth-backed models are listed first."),
				),
				1,
				0,
			),
		)

		this.searchInput = new Input()
		if (opts.initialSearchInput) this.searchInput.setValue(opts.initialSearchInput)
		this.searchInput.onSubmit = () => {
			this.list.handleInput("\r")
		}
		this.searchInput.onEscape = () => this.onCancel?.()

		this.list = new ModelList(rows, {
			mode,
			initialSelectedValue: opts.initialSelectedValue,
			initialScope: mode === "toggle" ? "all" : undefined,
			searchInput: this.searchInput,
			onScopeChange: (scope) => this.updateScopeText(scope),
		})
		this.list.onSelect = (row) => this.onSelect?.(row)
		this.list.onCancel = () => this.onCancel?.()

		if (mode === "toggle" && this.list.hasScopedRows()) {
			this.scopeText = new Text("", 1, 0)
			this.updateScopeText(this.list.getScope())
			this.addChild(this.scopeText)
		}
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())
		this.addChild(new Spacer(1))
		this.addChild(this.searchInput)
		this.addChild(new Spacer(1))
		this.addChild(this.list)
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())

		if (rows.length === 0) {
			setTimeout(() => this.onCancel?.(), 0)
		}
	}

	private updateScopeText(scope: ModelScope): void {
		if (!this.scopeText) return
		const all = scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all")
		const scoped = scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped")
		this.scopeText.setText(`${theme.fg("muted", "Scope: ")}${all}${theme.fg("muted", " | ")}${scoped}${theme.fg("muted", "  Tab to switch")}`)
	}

	getFocus(): Focusable {
		return this
	}

	handleInput(keyData: string | Buffer): void {
		this.list.handleInput(keyData)
	}
}

interface ShowSelectorCtx {
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component },
	) => void
}

export function rowsForModels(
	models: ModelEntry[],
	opts: { currentId?: string; currentProvider?: string; scopedModelIds?: string[] } = {},
): ModelRow[] {
	return models.map((entry) => {
		const value = modelRef(entry)
		return {
			value,
			entry,
			current: opts.currentId ? modelEntryMatches(entry, opts.currentId, opts.currentProvider as any) : false,
			scoped: (opts.scopedModelIds ?? []).some((id) => modelRefMatches(entry, id)),
		}
	})
}

export async function pickModel(
	ctx: ShowSelectorCtx,
	rows: ModelRow[],
	opts: {
		mode?: ModelSelectorMode
		initialSelectedValue?: string
		title?: string
		subtitle?: string
	} = {},
): Promise<string | null> {
	if (rows.length === 0) return null
	return new Promise<string | null>((resolve) => {
		ctx.showSelector((done) => {
			const selector = new ModelSelectorComponent(rows, opts)
			selector.onSelect = (row) => {
				done()
				resolve(row.value)
			}
			selector.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: selector, focus: selector.getFocus() }
		})
	})
}
