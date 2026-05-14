/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 *
 * @template S
 */
export class UndoStack {
	/** @type {S[]} */
	stack = [];

	/**
	 * Push a deep clone of the given state onto the stack.
	 * @param {S} state
	 * @returns {void}
	 */
	push(state) {
		this.stack.push(structuredClone(state));
	}

	/**
	 * Pop and return the most recent snapshot, or undefined if empty.
	 * @returns {S | undefined}
	 */
	pop() {
		return this.stack.pop();
	}

	/**
	 * Remove all snapshots.
	 * @returns {void}
	 */
	clear() {
		this.stack.length = 0;
	}

	get length() {
		return this.stack.length;
	}
}
