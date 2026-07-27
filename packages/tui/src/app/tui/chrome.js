import { truncateToWidth, visibleWidth } from "../../tui/index.js"
import { overviewRoute, routeToArg } from "../../../../server/src/app/navigation/routes.js"
import { theme } from "../theme.js"
import { fit, renderKeyHintsFrame, shortSessionId, singleLine, stripAnsi } from "./format.js"

/** @typedef {import("../../../../server/src/app/navigation/routes.js").AppRoute} AppRoute */

export class PromptLabel {
	/** @param {() => string} text */
	constructor(text) {
		this.text = text
	}
	invalidate() {}
	lineCount() {
		return this.text() ? 1 : 0
	}
	/** @param {number} width */
	render(width) {
		const text = this.text()
		return text ? [theme.dim(fit(text, width))] : []
	}
}

export class OverviewModelLine {
	/** @param {() => string} text */
	constructor(text) {
		this.text = text
	}
	invalidate() {}
	lineCount() {
		return this.text() ? 1 : 0
	}
	/** @param {number} width */
	render(width) {
		const text = this.text()
		return text ? [fit(text, width)] : []
	}
}

export class OverviewNoticeLine {
	/** @param {() => ({ text: string, tone?: "normal" | "warn" | "error" } | undefined)} notice */
	constructor(notice) {
		this.notice = notice
	}
	invalidate() {}
	lineCount() {
		return this.notice()?.text ? 1 : 0
	}
	/** @param {number} width */
	render(width) {
		const notice = this.notice()
		if (!notice?.text) return []
		const render = notice.tone === "warn"
			? theme.yellow
			: notice.tone === "error"
				? theme.red
				: theme.dim
		return [render(fit(notice.text, width))]
	}
}

export class StaleRuntimeOverlay {
	/** @param {() => { route?: string, reopening?: boolean, retryScheduled?: boolean, error?: string, retryable?: boolean, height?: number }} state */
	constructor(state) {
		this.state = state
	}
	invalidate() {}
	/** @param {number} width */
	render(width) {
		const state = this.state()
		const height = Math.max(1, state.height ?? 1)
		const center = (line) => {
			const clipped = truncateToWidth(line, Math.max(1, width))
			const padding = Math.max(0, Math.floor((width - visibleWidth(stripAnsi(clipped))) / 2))
			return `${" ".repeat(padding)}${clipped}`
		}
		const action = state.reopening
			? theme.cyan("Reopening...")
			: state.retryScheduled
				? theme.cyan("Retrying...")
				: state.retryable === false
					? theme.red("Reopen failed")
					: `${theme.cyan("Enter")} retry`
		const content = [
			theme.bold("Cerex was updated"),
			"",
			action,
			...(state.error ? [theme.yellow(`Last error: ${state.error}`)] : []),
			...(state.route ? [theme.dim(`Returning to ${state.route}`)] : []),
			`${theme.cyan("Ctrl+C")} exit`,
		]
		const padTop = Math.max(0, Math.floor((height - content.length) / 2))
		const lines = Array.from({ length: padTop }, () => "")
		for (const line of content) lines.push(center(line))
		while (lines.length < height) lines.push("")
		return lines.slice(0, height)
	}
}

export class RouteLoadingShell {
	constructor() {
		this.route = overviewRoute
		this.error = undefined
	}

	/** @param {AppRoute} route @param {{ error?: unknown }} [options] */
	setRoute(route, options = {}) {
		this.route = route
		this.error = options.error
	}

	invalidate() {}

	/** @param {number} width */
	render(width) {
		const target = this.route.type === "session" ? `session ${shortSessionId(this.route.id)}` : routeToArg(this.route)
		const lines = this.error
			? [
				theme.red(`Could not open ${target}.`),
				singleLine(this.error?.message ?? this.error),
				"",
				`${theme.cyan("Enter")} retry | ${theme.cyan("Ctrl+G")} overview`,
			]
			: [
				theme.cyan(`Opening ${target}...`),
				theme.dim("Loading session snapshot."),
			]
		return ["", ...lines.map((line) => fit(line, width))]
	}
}

export class OverviewKeyHints {
	/** @param {() => { filterMode?: boolean, peeking?: boolean, hasText?: boolean }} state @param {{ onHelp?: () => void }} [actions] */
	constructor(state, actions = {}) {
		this.state = state
		this.actions = actions
	}
	invalidate() {}

	/** @param {number} width @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[] }} */
	renderFrame(width) {
		const state = this.state()
		const helpAction = this.actions.onHelp ? {
			id: "overview-hints.help",
			label: "Help",
			metadata: { action: "help" },
			onClick: () => this.actions.onHelp?.(),
		} : undefined
		if (state.filterMode) return renderKeyHintsFrame([
			["Enter", "apply"],
			["Esc", "clear"],
			["Ctrl+F", "close"],
		], width, this)
		if (state.peeking && state.hasText) return renderKeyHintsFrame([
			["Enter", "reply"],
			["Ctrl+J", "newline"],
			["Esc", "clear"],
			["/help", "", helpAction],
		], width, this)
		if (state.hasText) return renderKeyHintsFrame([
			["Enter", "dispatch"],
			["Ctrl+J", "newline"],
			["Esc", "clear"],
			["/help", "", helpAction],
		], width, this)
		if (state.peeking) return renderKeyHintsFrame([
			["Enter/→", "open"],
			["↑/↓", "move"],
			["Ctrl+F", "filter"],
			["Ctrl+D", "done"],
			["Ctrl+E", "defer"],
			["/help", "", helpAction],
		], width, this)
		return renderKeyHintsFrame([
			["Enter/→", "open"],
			["↑/↓", "move"],
			["Ctrl+F", "filter"],
			["Ctrl+D", "done"],
			["Ctrl+E", "defer"],
			["/help", "", helpAction],
		], width, this)
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
}

export class SessionKeyHints {
	/** @param {() => { hasText?: boolean, interruptible?: boolean }} state @param {{ onBack?: () => void, onDetach?: () => void, onHelp?: () => void }} [actions] */
	constructor(state, actions = {}) {
		this.state = state
		this.actions = actions
	}
	invalidate() {}

	/** @param {number} width @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[] }} */
	renderFrame(width) {
		const state = this.state()
		const backAction = this.actions.onBack ? {
			id: "session-hints.back",
			label: "Back",
			metadata: { action: "back" },
			onClick: () => this.actions.onBack?.(),
		} : undefined
		const detachAction = this.actions.onDetach ? {
			id: "session-hints.detach",
			label: "Detach",
			metadata: { action: "detach" },
			onClick: () => this.actions.onDetach?.(),
		} : undefined
		const helpAction = this.actions.onHelp ? {
			id: "session-hints.help",
			label: "Help",
			metadata: { action: "help" },
			onClick: () => this.actions.onHelp?.(),
		} : undefined
		if (state.hasText) return renderKeyHintsFrame([
			["Enter", "send"],
			["Ctrl+J", "newline"],
			["Esc Esc", "clear"],
			["Ctrl+C", "detach", detachAction],
			["/help", "", helpAction],
		], width, this)
		const hints = /** @type {Array<[string, string, KeyHintAction?]>} */ ([
			["←", "back", backAction],
		])
		if (state.interruptible) hints.push(["Esc", "stop"])
		hints.push(["Ctrl+C", "detach", detachAction], ["/help", "", helpAction])
		return renderKeyHintsFrame(hints, width, this)
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
}
