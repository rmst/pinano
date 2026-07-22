// Shared selection movement for list-like components with different keyboard and wheel boundary policies.

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * @param {number} value
 * @param {number} modulo
 */
const wrapIndex = (value, modulo) => ((value % modulo) + modulo) % modulo

/**
 * @param {number} currentIndex
 * @param {number} count
 * @param {number} delta Signed number of selectable entries to move.
 * @param {{ wrap?: boolean, isSelectable?: (index: number) => boolean }} [options]
 * @returns {number}
 */
export function nextSelectionIndex(currentIndex, count, delta, options = {}) {
	const itemCount = Math.floor(count)
	const distance = Math.abs(Math.trunc(delta))
	if (!Number.isFinite(currentIndex) || !Number.isFinite(itemCount) || !Number.isFinite(distance)) return currentIndex
	if (itemCount <= 0 || distance === 0) return clamp(Math.floor(currentIndex), 0, Math.max(0, itemCount - 1))

	const direction = delta < 0 ? -1 : 1
	const wrap = options.wrap === true
	const isSelectable = options.isSelectable ?? (() => true)
	let index = clamp(Math.floor(currentIndex), 0, itemCount - 1)

	for (let moved = 0; moved < distance; moved++) {
		let candidate = index
		let found = false
		for (let attempt = 0; attempt < itemCount; attempt++) {
			const next = candidate + direction
			if (!wrap && (next < 0 || next >= itemCount)) return index
			candidate = wrap ? wrapIndex(next, itemCount) : next
			if (isSelectable(candidate)) {
				found = true
				break
			}
		}
		if (!found) return index
		index = candidate
	}

	return index
}
