import { resolve } from "node:path"
import { ListViewportController, MouseWheelDeltaTracker, TUI, clickableRowSpan, clipLinesToViewport, truncateToWidth, visibleWidth } from "../../../tui/index.js"
import { OVERVIEW_AGENT_PRIORITY, OVERVIEW_FOLDED_GROUP_LIMIT, overviewLifecycleStateFor, overviewSortTimestampFor, overviewStateFor } from "../../../../../server/src/app/overview/state.js"
import { projectHeaderLabel } from "../../../../../server/src/app/project/display.js"
import { projectNamesEqual } from "../../../../../server/src/app/project/labels.js"
import { runAcknowledgementKind } from "../../../../../server/src/app/overview/run-acknowledgement.js"
import { sessionMatchesDirectoryFilter } from "../../../../../server/src/app/session/directory-filter.js"
import { sessionOverviewContextMenuItems } from "../../../../../server/src/app/session/overview-context-menu.js"
import { theme } from "../../theme.js"
import { compactHomePath, explicitProjectOverrideLabel, fit, leftRightLine, projectLabel, sessionRowCanStillBeQueued, sessionRowIsRunning, shortSessionId, singleLine, stripAnsi } from "../format.js"
import { formatOverviewWorktreeInfo, worktreeRowSignalText } from "../session/status.js"
import { overviewAgeText } from "../time-format.js"
const OVERVIEW_WORKTREE_STATUS_RUNNING_MAX_AGE_MS = 10 * 1000
const OVERVIEW_WORKTREE_STATUS_ACTIVE_MAX_AGE_MS = 30 * 1000
const OVERVIEW_WORKTREE_STATUS_DEFERRED_MAX_AGE_MS = 10 * 60 * 1000
const OVERVIEW_WORKTREE_STATUS_COMPLETED_MAX_AGE_MS = 60 * 60 * 1000
const SESSION_WORKTREE_STATUS_REFRESH_INTERVAL_MS = 10 * 1000
const OVERVIEW_REFRESH_ERROR_NOTICE_PREFIX = "refresh error:"
const OVERVIEW_WORKTREE_STATUS_ERROR_NOTICE_PREFIX = "worktree status error:"
const OVERVIEW_DOUBLE_CLICK_MS = TUI.DOUBLE_CLICK_INTERVAL_MS
const TRANSIENT_RUNNING_ACTIVITY_RE = /^(Thinking|Generating|Running)/

/** @param {any} row */
const overviewRowSelectionKey = (row) => row?.type === "more" ? undefined : row?.id

/** @param {any} row */
const overviewRowIsFallbackSelectable = (row) => row?.type !== "more"

/**
 * @typedef {{ type: "session", session: any } | { type: "more", row: any }} AgentTableActivation
 * @typedef {{ type: "session", session: any, event: import("../../../tui/tui.js").TuiMouseEvent }} AgentTableContextMenu
 */

export class AgentTable {
	/** @param {{ cwd?: string, project?: any, directoryFilterEnabled?: boolean, getMaxLines?: (width: number) => number, getEmptyText?: () => string, getEmptyLines?: () => Array<string | { text: string, highlight?: boolean }>, spinnerFrame?: () => string, now?: () => number, onSelectionChange?: () => void, onActivate?: (action: AgentTableActivation) => void, onContextMenu?: (action: AgentTableContextMenu) => void }} [options] */
	constructor(options = {}) {
		/** @type {any[]} */
		this.sessions = []
		/** @type {Map<string, string>} */
		this.activity = new Map()
		this.viewportSelection = new ListViewportController({
			keyForItem: overviewRowSelectionKey,
			isFallbackSelectable: overviewRowIsFallbackSelectable,
		})
		this.peekSessionId = undefined
		this.wheelDeltas = new MouseWheelDeltaTracker()
		this.filter = ""
		this.notice = ""
		this.expandedGroups = new Set()
		this.worktrees = new Map()
		this.worktreeSessionVersions = new Map()
		this.worktreeLoadedVersions = new Map()
		this.worktreeLoadedAt = new Map()
		this.lastRowClick = undefined
		this.getMaxLines = options.getMaxLines
		this.getEmptyText = options.getEmptyText
		this.getEmptyLines = options.getEmptyLines
		this.now = options.now ?? (() => Date.now())
		this.onSelectionChange = options.onSelectionChange
		this.onActivate = options.onActivate
		this.onContextMenu = options.onContextMenu
		this.spinnerFrame = options.spinnerFrame ?? (() => "✽")
		this.cwd = resolve(options.cwd ?? process.cwd())
		this.project = options.project
		this.directoryFilterEnabled = options.directoryFilterEnabled === true
	}

	get selectedIndex() {
		return this.viewportSelection.selectedIndex
	}

	/** @param {number} index */
	set selectedIndex(index) {
		this.viewportSelection.setSelectionIndexPreservingIntent(index, this.rows())
	}

	get selectedSessionId() {
		return this.viewportSelection.selectedKey
	}

	/** @param {string | undefined} id */
	set selectedSessionId(id) {
		this.viewportSelection.selectedKey = typeof id === "string" && id ? id : undefined
	}

	get scrollOffset() {
		return this.viewportSelection.scrollOffset
	}

	/** @param {number} offset */
	set scrollOffset(offset) {
		this.viewportSelection.commitScrollOffset(offset)
	}

	get anchorSelectionInViewport() {
		return this.viewportSelection.followSelection
	}

	/** @param {boolean} enabled */
	set anchorSelectionInViewport(enabled) {
		this.viewportSelection.followSelection = enabled !== false
	}

	clampedIndex(index, rows = this.rows()) {
		return this.viewportSelection.clampedIndex(index, rows)
	}

	clampSelection() {
		this.viewportSelection.setSelectionIndexPreservingIntent(this.selectedIndex, this.rows())
	}

	resetRowClick() {
		this.lastRowClick = undefined
	}

	/** @param {string | undefined} id */
	visibleSessionIndex(id) {
		if (!id) return -1
		return this.rows().findIndex((row) => row.type !== "more" && row.id === id)
	}

	/**
	 * @param {number} preferredIndex
	 * @param {{ excludeSessionId?: string, anchorSelection?: boolean, preserveRowClick?: boolean }} [options]
	 */
	selectFallback(preferredIndex = this.selectedIndex, options = {}) {
		const update = this.viewportSelection.selectFallback(this.rows(), {
			preferredIndex,
			excludeKey: options.excludeSessionId,
			revealSelection: options.anchorSelection !== false,
		})
		if (!options.preserveRowClick) this.resetRowClick()
		return update.selected && this.selectedSessionId !== undefined
	}

	/**
	 * @param {string | undefined} id
	 * @param {{ expandGroups?: boolean, anchorSelection?: boolean, preserveRowClick?: boolean }} [options]
	 */
	selectSession(id, options = {}) {
		if (!id) return false
		const selectVisible = () => {
			const update = this.viewportSelection.selectKey(id, this.rows(), {
				revealSelection: options.anchorSelection !== false,
			})
			if (!update.selected) return false
			if (!options.preserveRowClick) this.resetRowClick()
			return true
		}
		if (selectVisible()) return true
		if (options.expandGroups !== false) {
			const session = this.sessions.find((s) => s.id === id)
			if (session) {
				this.expandedGroups.add(this.groupFor(session))
				if (selectVisible()) return true
			}
		}
		return false
	}

	/** @param {string | undefined} id */
	selectRouteTargetSession(id) {
		if (!id || id === this.selectedSessionId) return false
		return this.selectSession(id)
	}

	/** @param {number} index @param {{ anchorSelection?: boolean, preserveRowClick?: boolean }} [options] */
	setSelectedIndex(index, options = {}) {
		const update = this.viewportSelection.selectIndex(index, this.rows(), {
			revealSelection: options.anchorSelection !== false,
		})
		if (!options.preserveRowClick) this.resetRowClick()
		if (update.changed) this.onSelectionChange?.()
		return update.changed
	}

	/** @param {any[]} sessions */
	setSessions(sessions) {
		this.clearNotice((notice) => notice.startsWith(OVERVIEW_REFRESH_ERROR_NOTICE_PREFIX))
		const previousSelectedId = this.selectedSessionId
		const previousSelectedIndex = this.selectedIndex
		const nextWorktreeVersions = new Map()
		const nextSessionIds = new Set()
		for (const session of sessions) {
			if (!session?.id) continue
			if (session.deletedAt) {
				this.worktrees.delete(session.id)
				this.worktreeLoadedVersions.delete(session.id)
				this.worktreeLoadedAt.delete(session.id)
				continue
			}
			nextSessionIds.add(session.id)
			const version = `${session.updatedAt ?? ""}:${session.agentView?.updatedAt ?? ""}:${session.latestRunStartedAt ?? ""}:${session.latestRunEndedAt ?? ""}:${session.runStatus ?? ""}:${session.runtimeState ?? ""}:${session.runtimeNeedsInput === true}`
			nextWorktreeVersions.set(session.id, version)
		}
		for (const sessionId of this.worktrees.keys()) {
			if (!nextSessionIds.has(sessionId)) {
				this.worktrees.delete(sessionId)
				this.worktreeLoadedVersions.delete(sessionId)
				this.worktreeLoadedAt.delete(sessionId)
			}
		}
		this.worktreeSessionVersions = nextWorktreeVersions
		this.sessions = sessions
		this.reconcileActivityWithSessions(sessions)

		this.reconcileRowsAfterDataMutation(previousSelectedIndex, previousSelectedId)
	}

	/**
	 * Reconcile row-affecting data changes while preserving explicit viewport intent.
	 *
	 * @param {number} previousSelectedIndex
	 * @param {string | undefined} previousSelectedId
	 */
	reconcileRowsAfterDataMutation(previousSelectedIndex = this.selectedIndex, previousSelectedId = this.selectedSessionId) {
		if (previousSelectedId) {
			const nextSelected = this.sessions.find((s) => s.id === previousSelectedId)
			if (nextSelected) {
				const alreadyVisible = this.visibleSessionIndex(previousSelectedId) !== -1
				if (!alreadyVisible) this.expandedGroups.add(this.groupFor(nextSelected))
			}
		}
		this.viewportSelection.reconcileItems(this.rows(), {
			preferredIndex: previousSelectedIndex,
			excludeKey: previousSelectedId,
		})
	}

	/** @param {any[]} sessions */
	reconcileActivityWithSessions(sessions) {
		const sessionById = new Map(sessions.map((session) => [session.id, session]))
		for (const [sessionId, activity] of this.activity) {
			const session = sessionById.get(sessionId)
			if (!session) {
				this.activity.delete(sessionId)
				continue
			}
			if (activity === "queued" && !sessionRowCanStillBeQueued(session)) this.activity.delete(sessionId)
			else if (TRANSIENT_RUNNING_ACTIVITY_RE.test(activity) && !sessionRowIsRunning(session)) this.activity.delete(sessionId)
		}
	}

	/** @param {string} filter */
	setFilter(filter) {
		this.filter = filter.trim().toLowerCase()
		if (this.selectedSessionId && this.visibleSessionIndex(this.selectedSessionId) !== -1) {
			this.selectSession(this.selectedSessionId)
			return
		}
		this.selectFallback(0)
	}

	/** @param {boolean} enabled */
	setDirectoryFilterEnabled(enabled) {
		this.directoryFilterEnabled = enabled
		if (this.selectedSessionId && this.visibleSessionIndex(this.selectedSessionId) !== -1) {
			this.selectSession(this.selectedSessionId)
			return
		}
		this.selectFallback(0)
	}

	/**
	 * @param {string} sessionId
	 * @param {string} text
	 */
	setActivity(sessionId, text) {
		const previousSelectedIndex = this.selectedIndex
		const previousSelectedId = this.selectedSessionId
		this.activity.set(sessionId, text)
		this.reconcileRowsAfterDataMutation(previousSelectedIndex, previousSelectedId)
	}

	clearActivity(sessionId) {
		const previousSelectedIndex = this.selectedIndex
		const previousSelectedId = this.selectedSessionId
		this.activity.delete(sessionId)
		this.reconcileRowsAfterDataMutation(previousSelectedIndex, previousSelectedId)
	}

	/** @param {string} text */
	setNotice(text) {
		this.notice = text
	}

	/** @param {(text: string) => boolean} [predicate] */
	clearNotice(predicate) {
		if (!this.notice) return
		if (!predicate || predicate(this.notice)) this.notice = ""
	}

	rows() {
		let sessions = this.sessions
		if (this.directoryFilterEnabled) {
			sessions = sessions.filter((session) => sessionMatchesDirectoryFilter(session, this.cwd))
		}
		if (this.filter) {
			sessions = sessions.filter((s) => {
				const haystack = [s.id, s.cwd, s.project?.label, s.agentView?.projectTag, s.agentView?.descriptionInUi, s.agentView?.description, s.preview?.first?.text, s.preview?.lastUser?.text]
					.filter(Boolean)
					.join("\n")
					.toLowerCase()
				return haystack.includes(this.filter)
			})
		}
		const sorted = sessions
			.slice()
			.sort((a, b) => {
				const stateA = this.stateFor(a)
				const stateB = this.stateFor(b)
				const pa = OVERVIEW_AGENT_PRIORITY[stateA] ?? 7
				const pb = OVERVIEW_AGENT_PRIORITY[stateB] ?? 7
				if (pa !== pb) return pa - pb
				const timestampA = overviewSortTimestampFor(a, stateA)
				const timestampB = overviewSortTimestampFor(b, stateB)
				return String(timestampB ?? "").localeCompare(String(timestampA ?? ""))
			})
		const out = []
		let group = ""
		let groupSessions = []
		const flush = () => {
			if (!group) return
			const foldable = group === "Deferred"
			const expanded = this.expandedGroups.has(group) || this.filter
			const visible = foldable && !expanded ? groupSessions.slice(0, OVERVIEW_FOLDED_GROUP_LIMIT) : groupSessions
			out.push(...visible)
			const hidden = groupSessions.length - visible.length
			if (hidden > 0) out.push({ type: "more", id: `more:${group}`, group, count: hidden })
		}
		for (const session of sorted) {
			const nextGroup = this.groupFor(session)
			if (nextGroup !== group) {
				flush()
				group = nextGroup
				groupSessions = []
			}
			groupSessions.push(session)
		}
		flush()
		return out
	}

	selectedEntry() {
		return this.rows()[this.selectedIndex]
	}

	selected() {
		const entry = this.selectedEntry()
		return entry?.type === "more" ? undefined : entry
	}

	activateMore() {
		const entry = this.selectedEntry()
		if (entry?.type !== "more") return false
		this.expandedGroups.add(entry.group)
		return true
	}

	activateSelected() {
		const entry = this.selectedEntry()
		if (!entry) return false
		if (entry.type === "more") {
			if (!this.activateMore()) return false
			this.onActivate?.({ type: "more", row: entry })
			return true
		}
		this.onActivate?.({ type: "session", session: entry })
		return true
	}

	/** @param {string} id */
	selectSessionId(id, options = {}) {
		const index = this.visibleSessionIndex(id)
		if (index === -1) return false
		this.setSelectedIndex(index, options)
		return true
	}

	/** @param {string} group */
	selectMoreGroup(group, options = {}) {
		const index = this.rows().findIndex((row) => row?.type === "more" && row.group === group)
		if (index === -1) return false
		this.setSelectedIndex(index, options)
		return true
	}

	/** @param {string} key */
	rowClickIsDouble(key) {
		const now = this.now()
		const previous = this.lastRowClick
		if (previous?.key === key && now >= previous.at && now - previous.at <= OVERVIEW_DOUBLE_CLICK_MS) {
			this.resetRowClick()
			return true
		}
		this.lastRowClick = { key, at: now }
		return false
	}

	/**
	 * @param {string} key
	 * @param {() => boolean} select
	 * @param {() => boolean} activate
	 */
	handleRowClick(key, select, activate) {
		if (!select()) {
			this.resetRowClick()
			return { consume: true }
		}
		if (this.rowClickIsDouble(key)) activate()
		return { consume: true }
	}

	/** @param {string} id */
	handleSessionRowClick(id) {
		return this.handleRowClick(
			`session:${id}`,
			() => this.selectSessionId(id, { anchorSelection: false, preserveRowClick: true }),
			() => this.activateSessionId(id),
		)
	}

	/** @param {string} id @param {import("../../../tui/tui.js").TuiMouseEvent} event */
	handleSessionRowContextMenu(id, event) {
		if (!this.selectSessionId(id, { anchorSelection: false })) {
			this.resetRowClick()
			return { consume: true }
		}
		this.resetRowClick()
		const entry = this.selectedEntry()
		if (entry && entry.type !== "more" && entry.id === id) {
			this.onContextMenu?.({ type: "session", session: entry, event })
		}
		return { consume: true }
	}

	/** @param {string} group */
	handleMoreRowClick(group) {
		return this.handleRowClick(
			`more:${group}`,
			() => this.selectMoreGroup(group, { anchorSelection: false, preserveRowClick: true }),
			() => this.activateMoreGroup(group),
		)
	}

	/** @param {string} id */
	activateSessionId(id) {
		if (!this.selectSessionId(id)) return false
		const entry = this.selectedEntry()
		if (!entry || entry.type === "more" || entry.id !== id) return false
		this.onActivate?.({ type: "session", session: entry })
		return true
	}

	/** @param {string} group */
	activateMoreGroup(group) {
		if (!this.selectMoreGroup(group)) return false
		return this.activateSelected()
	}

	/** @param {number} index */
	activateIndex(index) {
		this.setSelectedIndex(index)
		return this.activateSelected()
	}

	move(delta) {
		const n = this.rows().length
		if (n === 0) {
			const changed = this.selectedIndex !== 0 || this.selectedSessionId !== undefined
			this.selectedIndex = 0
			this.selectedSessionId = undefined
			if (changed) this.onSelectionChange?.()
			return changed
		}
		return this.setSelectedIndex(this.selectedIndex + delta)
	}

	page(delta) {
		return this.move(delta * 10)
	}

	scrollViewport(delta) {
		const changed = this.viewportSelection.scrollBy(delta)
		this.resetRowClick()
		return changed
	}

	/** @param {import("../../../tui/tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		const delta = this.wheelDeltas.deltaFromEvent(event)
		if (delta === 0) return { consume: false }
		this.scrollViewport(delta)
		return { consume: true }
	}

	togglePeek() {
		const selected = this.selected()
		if (!selected) return
		this.peekSessionId = this.peekSessionId === selected.id ? undefined : selected.id
	}

	/**
	 * @param {string} sessionId
	 * @param {any[]} worktrees
	 * @param {{ loadedAt?: number }} [options]
	 */
	setWorktrees(sessionId, worktrees, options = {}) {
		if (!sessionId) return
		this.worktrees.set(sessionId, Array.isArray(worktrees) ? worktrees : [])
		this.worktreeLoadedVersions.set(sessionId, this.worktreeSessionVersions.get(sessionId) ?? "")
		this.worktreeLoadedAt.set(sessionId, options.loadedAt ?? Date.now())
	}

	/** @param {string} sessionId */
	hasWorktreeInfo(sessionId) {
		return this.worktrees.has(sessionId)
	}

	/** @param {string} sessionId */
	worktreeStatusMaxAgeMs(sessionId) {
		const session = this.sessions.find((s) => s.id === sessionId)
		const state = session ? this.stateFor(session) : undefined
		if (state === "working") return OVERVIEW_WORKTREE_STATUS_RUNNING_MAX_AGE_MS
		if (state === "completed") return OVERVIEW_WORKTREE_STATUS_COMPLETED_MAX_AGE_MS
		if (state === "deferred") return OVERVIEW_WORKTREE_STATUS_DEFERRED_MAX_AGE_MS
		return OVERVIEW_WORKTREE_STATUS_ACTIVE_MAX_AGE_MS
	}

	/** @param {string} sessionId @param {number} [now] */
	hasFreshWorktreeInfo(sessionId, now = Date.now()) {
		if (!this.worktrees.has(sessionId)) return false
		if ((this.worktreeLoadedVersions.get(sessionId) ?? "") !== (this.worktreeSessionVersions.get(sessionId) ?? "")) return false
		const loadedAt = this.worktreeLoadedAt.get(sessionId)
		if (!Number.isFinite(loadedAt)) return false
		return now - loadedAt <= this.worktreeStatusMaxAgeMs(sessionId)
	}

	invalidate() {}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../../tui/render-frame.js").RenderSpan[] }}
	 */
	renderFrame(width) {
		const maxLines = this.getMaxLines?.(width)
		const header = this.renderHeader(width)
		const body = this.renderBodyFrame(width)
		if (!Number.isFinite(maxLines)) {
			return {
				lines: [...header, ...body.lines],
				spans: body.spans.map((span) => ({ ...span, line: span.line + header.length })),
			}
		}

		const lineLimit = Math.max(0, Math.floor(maxLines))
		if (lineLimit <= header.length) return { lines: header.slice(0, lineLimit), spans: [] }

		const viewport = clipLinesToViewport({
			lines: body.lines,
			maxLines: lineLimit - header.length,
			...this.viewportSelection.clipOptions(body.selectedLine),
			topIndicator: (hidden) => theme.dim(fit(`↑ ${hidden} more`, width)),
			bottomIndicator: (hidden) => theme.dim(fit(`↓ ${hidden} more`, width)),
		})
		this.viewportSelection.commitScrollOffset(viewport.scrollOffset)
		/** @type {import("../../../tui/render-frame.js").RenderSpan[]} */
		const spans = []
		for (let i = 0; i < viewport.sourceLineIndexes.length; i++) {
			const sourceLine = viewport.sourceLineIndexes[i]
			if (sourceLine === null || sourceLine === undefined) continue
			for (const span of body.spans) {
				if (span.line === sourceLine) spans.push({ ...span, line: header.length + i })
			}
		}
		return { lines: [...header, ...viewport.lines], spans }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}

	/** @param {number} width */
	renderHeader(width) {
		/** @type {string[]} */
		const lines = []
		lines.push(this.renderHeaderLine(width))
		if (this.notice) lines.push(theme.dim(fit(this.notice, width)))
		if (this.filter) lines.push(theme.dim(fit(`filter: ${this.filter}`, width)))
		lines.push("")
		return lines
	}

	headerProjectLabel() {
		return projectHeaderLabel(this.project)
	}

	/** @param {number} width */
	renderHeaderLine(width) {
		const cwd = compactHomePath(this.cwd)
		const project = this.headerProjectLabel()
		const left = project ? theme.bold(theme.cyan(project)) : ""
		const renderPath = this.directoryFilterEnabled ? theme.bold : (text) => text
		return leftRightLine(left, cwd, width, renderPath)
	}

	/** @param {number} width */
	renderBody(width) {
		const frame = this.renderBodyFrame(width)
		return { lines: frame.lines, selectedLine: frame.selectedLine }
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../../tui/render-frame.js").RenderSpan[], selectedLine: number }}
	 */
	renderBodyFrame(width) {
		const rows = this.rows()
		/** @type {string[]} */
		const lines = []
		/** @type {import("../../../tui/render-frame.js").RenderSpan[]} */
		const spans = []
		let selectedLine = 0

		if (rows.length === 0) {
			const emptyLines = this.getEmptyLines?.() ?? [this.getEmptyText?.() ?? "No sessions yet. Type a task below and press Enter to dispatch an agent."]
			for (const entry of emptyLines) {
				const text = typeof entry === "string" ? entry : entry.text
				const render = typeof entry === "string" || !entry.highlight ? theme.dim : theme.yellow
				for (const line of text.split("\n")) lines.push(render(fit(line, width)))
			}
			return { lines, spans, selectedLine }
		}

		let lastGroup = ""
		rows.forEach((entry, index) => {
			const group = entry.type === "more" ? entry.group : this.groupFor(entry)
			if (group !== lastGroup) {
				if (lastGroup) lines.push("")
				lines.push(theme.cyan(fit(group, width)))
				lastGroup = group
			}
			const selected = index === this.selectedIndex
			if (entry.type === "more") {
				const line = this.renderMoreRow(entry, width)
				if (selected) selectedLine = lines.length
				const rendered = selected ? theme.bg("selectedBg", line) : line
				const lineIndex = lines.length
				lines.push(rendered)
				const span = clickableRowSpan({
					line: lineIndex,
					text: rendered,
					width,
					component: this,
					id: `overview.more.${entry.group}`,
					label: `${entry.count} more ${entry.group.toLowerCase()}`,
					metadata: { row: entry, index },
					onClick: () => this.handleMoreRowClick(entry.group),
				})
				if (span) spans.push(span)
				return
			}
			const line = this.renderRow(entry, width)
			if (selected) selectedLine = lines.length
			const rendered = selected ? theme.bg("selectedBg", line) : entry.hidden ? theme.bg("hiddenSessionBg", line) : line
			const lineIndex = lines.length
			lines.push(rendered)
			const span = clickableRowSpan({
				line: lineIndex,
				text: rendered,
				width,
				component: this,
				id: `overview.session.${entry.id}`,
				label: this.summaryFor(entry),
				metadata: { session: entry, index },
				onClick: () => this.handleSessionRowClick(entry.id),
				onContextMenu: (event) => this.handleSessionRowContextMenu(entry.id, event),
			})
			if (span) spans.push(span)
			if (this.peekSessionId === entry.id) {
				for (const peekLine of this.renderPeek(entry, width)) lines.push(peekLine)
			}
		})
		return { lines, spans, selectedLine }
	}

	/** @param {any} session */
	stateFor(session) {
		if (session?.deletedAt) return "deleted"
		if (/^error:/.test(this.activity.get(session.id) || "")) return "needs_input"
		return overviewStateFor(session, { lifecycleState: this.lifecycleStateFor(session) })
	}

	/** @param {any} session */
	lifecycleStateFor(session) {
		const activity = this.activity.get(session.id) || ""
		if (activity === "queued") return "queued"
		if (TRANSIENT_RUNNING_ACTIVITY_RE.test(activity)) return "running"
		return overviewLifecycleStateFor(session)
	}

	/** @param {any} session */
	isRunningSession(session) {
		const lifecycleState = this.lifecycleStateFor(session)
		const runtimeState = session.runtimeState || session.runStatus || "idle"
		return lifecycleState === "running" || runtimeState === "running"
	}

	hasRunningSession() {
		return this.sessions.some((session) => this.isRunningSession(session))
	}

	hasVisibleRunningSession() {
		return this.rows().some((entry) => entry.type !== "more" && this.isRunningSession(entry))
	}

	/** @param {any} session */
	groupFor(session) {
		const state = this.stateFor(session)
		if (state === "needs_input") return "Needs input"
		if (state === "experiencing_problems") return "Experiencing problems"
		if (state === "queued") return "Starting"
		if (state === "ready_for_review") return "Ready for review"
		if (state === "working") return "Working"
		if (state === "discussing") return "Discussing"
		if (state === "not_started") return "Not started"
		if (state === "deferred") return "Deferred"
		if (state === "deleted") return "Deleted"
		return "Completed"
	}

	/** @param {any} session */
	iconFor(session) {
		const lifecycleState = this.lifecycleStateFor(session)
		const runtimeState = session.runtimeState || session.runStatus || "idle"
		if (lifecycleState === "queued") return theme.cyan("◌")
		if (lifecycleState === "deleted") return theme.dim("x")
		if (session.runtimeNeedsInput) return theme.gray("∙")
		if (this.isRunningSession(session)) return theme.cyan(this.spinnerFrame() || "✽")
		const acknowledgementKind = runAcknowledgementKind(session)
		if (acknowledgementKind === "problem") return theme.red("✖")
		if (acknowledgementKind === "stopped") return theme.dim("⏸")
		if (runtimeState === "paused") return theme.dim("⏸")
		return theme.gray("∙")
	}

	/**
	 * @param {any} row
	 * @param {number} width
	 */
	renderMoreRow(row, width) {
		const prefix = `${theme.gray("…")} `
		return fit(`${prefix}${row.count} more ${row.group.toLowerCase()} — press Enter/Space to show`, width)
	}

	/** @param {any} session */
	projectLabelFor(session) {
		const explicit = explicitProjectOverrideLabel(session)
		if (explicit) return explicit
		const associated = projectLabel(session.project)
		if (!associated || projectNamesEqual(associated, this.project?.label)) return ""
		return associated
	}

	/**
	 * @param {any} session
	 * @param {number} width
	 */
	renderRow(session, width) {
		const description = session.agentView?.description || session.preview?.first?.text || session.preview?.lastUser?.text || this.activity.get(session.id) || session.id.slice(0, 8)
		const age = overviewAgeText(session.deletedAt ?? session.updatedAt)
		const worktreeSignal = session.deletedAt ? "" : worktreeRowSignalText(this.worktrees.get(session.id))
		const prefix = `${this.iconFor(session)} `
		const renderedSuffix = [worktreeSignal, age].filter(Boolean).join(" ")
		const suffix = renderedSuffix ? ` ${renderedSuffix}` : ""
		const available = Math.max(10, width - visibleWidth(stripAnsi(prefix)) - visibleWidth(stripAnsi(suffix)))
		const projectLabel = this.projectLabelFor(session)
		const labelWidth = projectLabel ? Math.max(1, Math.min(24, Math.floor(available * 0.3))) : 0
		const renderedLabel = projectLabel ? truncateToWidth(projectLabel, labelWidth, "", false) : ""
		const descriptionWidth = Math.max(1, available - visibleWidth(renderedLabel) - (renderedLabel ? 1 : 0))
		const rowBody = renderedLabel
			? `${theme.dim(renderedLabel)} ${fit(description.replace(/\s+/g, " "), descriptionWidth)}`
			: fit(description.replace(/\s+/g, " "), available)
		const text = `${prefix}${rowBody}${suffix}`
		return fit(text, width)
	}

	/** @param {any} session */
	summaryFor(session) {
		if (session.deletedAt) return "deleted"
		if (session.agentView?.descriptionInUi || session.agentView?.description) return session.agentView.descriptionInUi ?? session.agentView.description
		if (this.lifecycleStateFor(session) === "queued") return "queued"
		if (this.lifecycleStateFor(session) === "not_started") return "not started"
		if (session.runStatus === "running") return "working"
		if (session.runStatus === "failed") return "failed"
		if (session.runStatus === "aborted") return "aborted"
		if (session.runStatus === "interrupted") return "interrupted"
		return session.preview?.first?.text || session.preview?.lastUser?.text || "ready"
	}

	/**
	 * @param {any} session
	 * @param {number} width
	 */
	renderPeek(session, width) {
		const lines = []
		const indent = "    "
		const add = (label, value) => {
			const text = singleLine(value)
			if (!text) return
			lines.push(theme.dim(fit(`${indent}${label}: ${text}`, width)))
		}
		add("id", shortSessionId(session.id))
		add("cwd", session.cwd)
		for (const worktree of this.worktrees.get(session.id) ?? []) add("worktree", formatOverviewWorktreeInfo(worktree))
		return lines
	}
}

/**
 * @param {AgentTable} table
 * @param {{ markReadyForReview(id: string): Promise<any>, markCompleted(id: string): Promise<any>, markDeferred(id: string): Promise<any> }} client
 * @param {any} selected
 * @param {"completed" | "deferred"} targetState
 */
export function selectedAgentStateActionTask(table, client, selected, targetState) {
	if (!selected || selected.deletedAt || table.isRunningSession(selected)) return undefined
	return table.stateFor(selected) === targetState
		? client.markReadyForReview(selected.id)
		: targetState === "completed"
			? client.markCompleted(selected.id)
			: client.markDeferred(selected.id)
}

/** @param {unknown} err */
export function isRunningAgentStateActionRejection(err) {
	const status = /** @type {any} */ (err)?.status
	const message = String(/** @type {any} */ (err)?.message ?? err)
	return status === 409 && /^Cannot (?:mark a running session completed|defer a running session|reopen a running session)\.$/.test(message)
}

export const overviewContextMenuTheme = {
	border: (text) => theme.fg("borderMuted", text),
	item: (text, style) => {
		const styled = style.disabled
			? theme.dim(text)
			: style.danger
				? theme.red(text)
				: text
		return style.selected ? theme.bg("selectedBg", styled) : styled
	},
}

/**
 * @param {AgentTable} table
 * @param {any} session
 * @param {{ open?: () => void, markCompleted?: () => void, markDeferred?: () => void, lifecycle?: () => void }} handlers
 * @returns {import("../../../tui/components/context-menu.js").ContextMenuItem[]}
 */
export function overviewSessionContextMenuItems(table, session, handlers = {}) {
	if (!session) return []
	return sessionOverviewContextMenuItems({
		deleted: Boolean(session.deletedAt),
		running: table.isRunningSession(session),
		state: table.stateFor(session),
	}).map((item) => item.type === "separator" ? item : {
		id: item.id,
		label: item.label,
		danger: item.danger,
		onSelect: handlers[item.handler],
	})
}
