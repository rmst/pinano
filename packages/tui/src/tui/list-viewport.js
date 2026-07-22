/**
 * Coordinate list selection with viewport scroll intent.
 *
 * List-like components often need two different behaviours that look similar at the call site: user navigation should reveal the selected row, while data refreshes should preserve whatever viewport mode the user had chosen. This controller keeps that intent explicit instead of letting selection reconciliation accidentally become a scroll-to-selection interaction.
 */

/**
 * @typedef {object} ListViewportUpdate
 * @property {boolean} selected Whether the operation selected an item.
 * @property {boolean} changed Whether selected index or selected key changed.
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/** @param {unknown} value */
const finiteInteger = (value) => Number.isFinite(value) ? Math.trunc(value) : 0

/** @param {unknown} value */
const normalizedKey = (value) => typeof value === "string" && value ? value : undefined

export class ListViewportController {
	/**
	 * @param {object} [options]
	 * @param {(item: any) => string | undefined} [options.keyForItem]
	 * @param {(item: any, index: number) => boolean} [options.isFallbackSelectable]
	 * @param {number} [options.selectedIndex]
	 * @param {string} [options.selectedKey]
	 * @param {number} [options.scrollOffset]
	 * @param {boolean} [options.followSelection]
	 */
	constructor(options = {}) {
		this.keyForItem = options.keyForItem ?? ((item) => normalizedKey(item?.id))
		this.isFallbackSelectable = options.isFallbackSelectable ?? (() => true)
		this.selectedIndex = finiteInteger(options.selectedIndex ?? 0)
		this.selectedKey = normalizedKey(options.selectedKey)
		this.scrollOffset = Math.max(0, finiteInteger(options.scrollOffset ?? 0))
		this.followSelection = options.followSelection !== false
	}

	/** @param {any} item */
	itemKey(item) {
		return normalizedKey(this.keyForItem(item))
	}

	/** @param {number} index @param {any[]} items */
	clampedIndex(index, items) {
		return items.length === 0 ? 0 : clamp(finiteInteger(index), 0, items.length - 1)
	}

	selectionSnapshot() {
		return { selectedIndex: this.selectedIndex, selectedKey: this.selectedKey }
	}

	/** @param {{ selectedIndex: number, selectedKey: string | undefined }} previous @param {boolean} selected */
	updateFrom(previous, selected = true) {
		return {
			selected,
			changed: this.selectedIndex !== previous.selectedIndex || this.selectedKey !== previous.selectedKey,
		}
	}

	/** @param {number} index @param {any[]} items */
	setSelectionIndexPreservingIntent(index, items) {
		const previous = this.selectionSnapshot()
		this.selectedIndex = this.clampedIndex(index, items)
		this.selectedKey = this.itemKey(items[this.selectedIndex])
		return this.updateFrom(previous, items.length > 0)
	}

	/**
	 * @param {number} index
	 * @param {any[]} items
	 * @param {{ revealSelection?: boolean }} [options]
	 */
	selectIndex(index, items, options = {}) {
		const update = this.setSelectionIndexPreservingIntent(index, items)
		this.followSelection = options.revealSelection !== false
		return update
	}

	/**
	 * @param {string | undefined} key
	 * @param {any[]} items
	 * @param {{ revealSelection?: boolean }} [options]
	 */
	selectKey(key, items, options = {}) {
		const wanted = normalizedKey(key)
		if (!wanted) return { selected: false, changed: false }
		const index = items.findIndex((item) => this.itemKey(item) === wanted)
		if (index === -1) return { selected: false, changed: false }
		return this.selectIndex(index, items, options)
	}

	/**
	 * @param {any[]} items
	 * @param {{ preferredIndex?: number, excludeKey?: string, revealSelection?: boolean }} [options]
	 */
	selectFallback(items, options = {}) {
		const previous = this.selectionSnapshot()
		if (items.length === 0) {
			this.selectedIndex = 0
			this.selectedKey = undefined
			this.followSelection = options.revealSelection !== false
			return this.updateFrom(previous, false)
		}

		const anchor = this.clampedIndex(options.preferredIndex ?? this.selectedIndex, items)
		const excludeKey = normalizedKey(options.excludeKey)
		const candidates = items
			.map((item, index) => ({ item, index, key: this.itemKey(item) }))
			.filter(({ item, index, key }) => this.isFallbackSelectable(item, index) && key !== excludeKey)
		const selected = candidates.length > 0
			? candidates.reduce((best, candidate) => {
				const bestDistance = Math.abs(best.index - anchor)
				const candidateDistance = Math.abs(candidate.index - anchor)
				return candidateDistance < bestDistance ? candidate : best
			})
			: { item: items[anchor], index: anchor, key: this.itemKey(items[anchor]) }

		this.selectedIndex = selected.index
		this.selectedKey = selected.key
		this.followSelection = options.revealSelection !== false
		return this.updateFrom(previous)
	}

	/**
	 * Reconcile a changed item list without changing viewport intent. This is for data updates: selected identity should remain sticky, but manual scroll should stay manual until an explicit navigation action says otherwise.
	 *
	 * @param {any[]} items
	 * @param {{ preferredIndex?: number, excludeKey?: string }} [options]
	 */
	reconcileItems(items, options = {}) {
		const followSelection = this.followSelection
		const previous = this.selectionSnapshot()
		if (this.selectedKey) {
			const index = items.findIndex((item) => this.itemKey(item) === this.selectedKey)
			if (index !== -1) {
				this.selectedIndex = index
				this.followSelection = followSelection
				return this.updateFrom(previous)
			}
		} else {
			const update = this.setSelectionIndexPreservingIntent(options.preferredIndex ?? this.selectedIndex, items)
			this.followSelection = followSelection
			return update
		}

		const update = this.selectFallback(items, {
			preferredIndex: options.preferredIndex,
			excludeKey: options.excludeKey,
			revealSelection: followSelection,
		})
		this.followSelection = followSelection
		return update
	}

	/** @param {number} delta */
	scrollBy(delta) {
		const previousOffset = this.scrollOffset
		const previousFollowSelection = this.followSelection
		this.scrollOffset = Math.max(0, this.scrollOffset + finiteInteger(delta))
		this.followSelection = false
		return this.scrollOffset !== previousOffset || previousFollowSelection
	}

	/** @param {number} scrollOffset */
	commitScrollOffset(scrollOffset) {
		this.scrollOffset = Math.max(0, finiteInteger(scrollOffset))
	}

	/** @param {number} selectedLine */
	clipOptions(selectedLine) {
		return {
			anchorLine: this.followSelection ? selectedLine : undefined,
			scrollOffset: this.scrollOffset,
			preferScrollOffset: !this.followSelection,
		}
	}
}
