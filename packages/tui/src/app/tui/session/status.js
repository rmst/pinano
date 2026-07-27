import { isAbsolute, resolve } from "node:path"
import { truncateToWidth, visibleWidth } from "../../../tui/index.js"
import { reasoningLevelLabel } from "../../../../../protocol/src/reasoning.js"
import { isFastModeEligibleModel } from "../../../../../server/src/app/agent/fast-mode.js"
import { pathIsWithin } from "../../../../../server/src/app/sandbox/paths.js"
import { theme } from "../../theme.js"
import { compactHomePath, effectiveProjectLabel, fit, modelLineDivider, singleLine, truncateLeftToWidth } from "../format.js"
import { flattenContent } from "./transcript-state.js"
export class SessionInfoLine {
	/** @param {() => any} getSnapshot */
	constructor(getSnapshot) {
		this.getSnapshot = getSnapshot
	}

	/** @param {any} snapshot */
	descriptionFor(snapshot) {
		const explicit = singleLine(snapshot?.agentView?.descriptionInUi ?? snapshot?.agentView?.description)
		if (explicit) return explicit
		const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
		const firstUser = messages.find((message) => message?.role === "user")
		return singleLine(flattenContent(firstUser?.content)) || "ready"
	}

	/** @param {number} width */
	render(width) {
		const snapshot = this.getSnapshot()
		const project = effectiveProjectLabel(snapshot)
		const description = this.descriptionFor(snapshot)
		const parts = []
		if (project) parts.push(theme.bold(theme.cyan(project)))
		if (description) parts.push(theme.bold(description))
		return [fit(parts.join(modelLineDivider(" │ ")), Math.max(1, width))]
	}
}

export class AccentDividerLine {
	invalidate() {}
	/** @param {number} width */
	render(width) {
		return [theme.cyan("─".repeat(Math.max(0, Math.floor(width))))]
	}
}

/**
 * @param {{ cwd: string, detail?: string }} status
 * @param {number} width
 */
export function renderSessionCwdStatusLine(status, width) {
	const terminalWidth = Math.max(0, Math.floor(width))
	if (terminalWidth <= 0) return ""
	// Leave the last terminal column empty; printing styled text into it can render as clipped or pending-wrap in some terminals.
	const contentWidth = terminalWidth > 1 ? terminalWidth - 1 : terminalWidth
	const prefixWidth = visibleWidth("─ ")
	const minPathWidth = 1
	const pathSuffixWidth = visibleWidth(" ")
	const rightRuleWidth = visibleWidth("─")
	const detailMaxWidth = Math.max(0, contentWidth - prefixWidth - minPathWidth - pathSuffixWidth - rightRuleWidth)
	const detailText = status.detail && detailMaxWidth > 0 ? truncateLeftToWidth(` ${status.detail} `, detailMaxWidth) : ""
	const detail = detailText ? theme.dim(detailText) : ""
	const rightRule = theme.cyan("─")
	const fixedWidth = prefixWidth + pathSuffixWidth + visibleWidth(detailText) + rightRuleWidth
	const minRuleWidth = detailText ? 1 : 0
	const pathWidth = Math.max(1, contentWidth - fixedWidth - minRuleWidth)
	const path = theme.gray(truncateLeftToWidth(status.cwd, pathWidth))
	const left = `${theme.cyan("─ ")}${path}${theme.cyan(" ")}`
	const right = `${detail}${rightRule}`
	const ruleWidth = Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(right))
	return truncateToWidth(`${left}${theme.cyan("─".repeat(ruleWidth))}${right}`, contentWidth, "")
}

export class SessionCwdLine {
	/** @param {() => { snapshot?: any, worktrees?: any[] }} state */
	constructor(state) {
		this.state = state
	}
	invalidate() {}
	/** @param {number} width */
	render(width) {
		const state = this.state()
		const status = sessionCwdStatus(state.snapshot, state.worktrees)
		if (!status) return []
		return [renderSessionCwdStatusLine(status, width), ""]
	}
}

function worktreePathText(worktree) {
	const path = singleLine(worktree?.path)
	return path ? compactHomePath(path) : ""
}

function worktreeLifecycleSignal(worktrees) {
	if (!Array.isArray(worktrees) || worktrees.length === 0) return ""
	let hasApplied = false
	for (const worktree of worktrees) {
		const status = singleLine(worktree?.status)
		if (!worktree?.removed && (status === "dirty" || status === "conflicts")) return "dirty"
		const unapplied = Number(worktree?.comparison?.unapplied)
		if (!worktree?.removed && Number.isSafeInteger(unapplied) && unapplied > 0) return "unapplied"
		if (worktree?.removed && worktree?.terminalState === "applied") hasApplied = true
	}
	return hasApplied ? "applied" : ""
}

export function worktreeRowSignalText(worktrees) {
	const signal = worktreeLifecycleSignal(worktrees)
	if (signal === "dirty") return theme.yellow("·")
	if (signal === "unapplied") return theme.yellow("↑")
	if (signal === "applied") return theme.green("✓")
	return ""
}

function commitCountText(count) {
	return `${count} ${count === 1 ? "commit" : "commits"}`
}

function worktreeStatusDisplayText(status) {
	return status === "dirty" ? "uncommitted changes" : status
}

function worktreeComparisonText(worktree) {
	if (worktree?.removed && worktree?.terminalState === "applied") return ""
	const comparison = worktree?.comparison
	const ref = singleLine(comparison?.ref)
	const ahead = Number(comparison?.ahead)
	const behind = Number(comparison?.behind)
	const unapplied = Number(comparison?.unapplied)
	if (Number.isSafeInteger(unapplied) && unapplied === 0 && worktreeHasWork(comparison)) return ""
	if (!ref || !Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) return ""
	if (ahead === 0 && behind === 0) return ""
	if (ahead > 0 && behind > 0) return `${ahead} ahead, ${commitCountText(behind)} behind ${ref}`
	if (ahead > 0) return `${commitCountText(ahead)} ahead of ${ref}`
	return `${commitCountText(behind)} behind ${ref}`
}

function worktreeStatusText(worktree) {
	const status = singleLine(worktree?.status)
	if (!status || status === "clean") return ""
	return worktreeStatusDisplayText(status)
}

function worktreeHasWork(comparison) {
	if (comparison?.hasWork === true) return true
	if (comparison?.hasWork === false) return false
	const ahead = Number(comparison?.ahead)
	return Number.isSafeInteger(ahead) && ahead > 0
}

function worktreeIntegrationText(worktree) {
	const comparison = worktree?.comparison
	const ref = singleLine(comparison?.ref) || singleLine(worktree?.integrationTarget)
	const unapplied = Number(comparison?.unapplied)
	if (worktree?.removed) {
		if (worktree?.terminalState !== "applied") return ""
		return ref ? `applied in ${ref}` : "applied"
	}
	if (!ref || !Number.isSafeInteger(unapplied) || unapplied < 0) return ""
	if (unapplied === 0) {
		if (worktreeStatusText(worktree)) return ""
		if (worktree?.terminalState === "applied" || worktreeHasWork(comparison)) return `applied in ${ref}`
		const ahead = Number(comparison?.ahead)
		const behind = Number(comparison?.behind)
		return ahead === 0 && behind === 0 ? `same as ${ref}` : ""
	}
	return `${unapplied} ${unapplied === 1 ? "change" : "changes"} not applied in ${ref}`
}

function formatWorktreeInfoLine(worktree) {
	const status = worktreeStatusText(worktree)
	const path = worktreePathText(worktree)
	const integration = worktreeIntegrationText(worktree)
	const comparison = worktreeComparisonText(worktree)
	return `  ${[status, path, integration, comparison].filter(Boolean).join("  ") || "unknown"}`
}

export function formatOverviewWorktreeInfo(worktree) {
	const path = worktreePathText(worktree) || "unknown"
	const status = worktreeStatusText(worktree)
	const integration = worktreeIntegrationText(worktree)
	const comparison = worktreeComparisonText(worktree)
	const detail = [status, integration, comparison].filter(Boolean).join(", ")
	return detail ? `${path} (${detail})` : path
}

function worktreeDetailText(worktree) {
	const status = worktreeStatusText(worktree)
	if (status) return status
	return worktreeCompactIntegrationText(worktree) || worktreeComparisonText(worktree)
}

function worktreeCompactIntegrationText(worktree) {
	const comparison = worktree?.comparison
	const ref = singleLine(comparison?.ref)
	const unapplied = Number(comparison?.unapplied)
	if (!ref || !Number.isSafeInteger(unapplied) || unapplied < 0) return ""
	if (unapplied > 0) return `${unapplied} ${unapplied === 1 ? "change" : "changes"} not in ${ref}`
	return worktreeIntegrationText(worktree)
}

function currentWorktreeForCwd(cwd, worktrees) {
	const cwdPath = singleLine(cwd)
	if (!cwdPath || !isAbsolute(cwdPath) || !Array.isArray(worktrees)) return undefined
	const resolvedCwd = resolve(cwdPath)
	return worktrees
		.map((worktree) => {
			const path = singleLine(worktree?.path)
			return { worktree, path }
		})
		.filter(({ worktree, path }) => !worktree?.removed && path && isAbsolute(path))
		.map(({ worktree, path }) => ({ worktree, path: resolve(path) }))
		.filter(({ path }) => pathIsWithin(path, resolvedCwd))
		.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path))[0]?.worktree
}

export function sessionCwdStatus(snapshot, worktrees = []) {
	const cwd = singleLine(snapshot?.cwd)
	if (!cwd) return undefined
	const worktree = currentWorktreeForCwd(snapshot?.cwd, worktrees)
	return { cwd: compactHomePath(cwd), detail: worktree ? worktreeDetailText(worktree) : "" }
}

export function sessionCwdStatusText(snapshot, worktrees = []) {
	const status = sessionCwdStatus(snapshot, worktrees)
	if (!status) return ""
	return `${status.cwd}${status.detail ? ` (${status.detail})` : ""}`
}

export function sessionInfoBody(snapshot, sessionId, worktrees = []) {
	const lines = [
		`id:        ${sessionId}`,
		`project:   ${effectiveProjectLabel(snapshot) || "?"}`,
		`cwd:       ${snapshot?.cwd ?? "?"}`,
		`model:     ${snapshot?.model?.id ?? "?"}`,
		`provider:  ${snapshot?.model?.provider ?? "?"}`,
		`reasoning: ${reasoningLevelLabel(snapshot?.thinkingLevel)}`,
		`fast:      ${snapshot?.serviceTier === "priority" && isFastModeEligibleModel(snapshot?.model) ? "on" : "off"}`,
		`streaming: ${snapshot?.isStreaming ? "yes" : "no"}`,
		`messages:  ${snapshot?.messages?.length ?? 0}`,
	]
	if (!Array.isArray(worktrees) || worktrees.length === 0) {
		lines.push("worktrees: none")
	} else {
		lines.push("worktrees:")
		lines.push(...worktrees.map(formatWorktreeInfoLine))
	}
	return lines.join("\n")
}
