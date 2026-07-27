/** Retained component tree, dirty propagation, and incremental subtree rendering. */

import { normalizeRenderFrame, offsetRegions, offsetSourceSpans, offsetSpans } from "./render-frame.js";

/**
 * @typedef {object} Component
 * @property {(width: number) => string[]} render
 * @property {(width: number) => import("./render-frame.js").RenderFrame} [renderFrame]
 * @property {() => void} invalidate
 */
/** @typedef {{ line: number; col: number }} SelectionPoint */

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 * @typedef {object} Focusable
 * @property {boolean} focused Set by TUI when focus changes. Component should emit CURSOR_MARKER when true.
 */

/**
 * Type guard to check if a component implements Focusable
 * @param {Component | null} component
 * @returns {component is Component & Focusable}
 */
export function isFocusable(component) {
	return component !== null && "focused" in component;
}


const RETAINED = Symbol("tui.retained");
const DIRTY_PARENT = Symbol("tui.dirtyParent");
const DIRTY = Symbol("tui.dirty");
const RENDER_CACHE = Symbol("tui.renderCache");
const CHILDREN_CACHE = Symbol("tui.childrenCache");
const VOLATILE_CHILDREN = Symbol("tui.volatileChildren");
const STRUCTURE_DIRTY = Symbol("tui.structureDirty");
const STRUCTURE_DIRTY_START = Symbol("tui.structureDirtyStart");

/** @typedef {{ lines: string[], spans?: import("./render-frame.js").RenderSpan[], sourceSpans?: import("./render-frame.js").RenderSourceSpan[], regions?: import("./render-frame.js").RenderRegion[], dirtyStart: number }} IncrementalRenderResult */
/** @typedef {{ component: Component, start: number, length: number }} ChildRenderRecord */

/** @param {Component} component @param {Component | null} parent */
export function setComponentParent(component, parent) {
	component[DIRTY_PARENT] = parent;
	if (parent && component[DIRTY]) markComponentDirty(parent);
}

/** @param {Component | null | undefined} component @returns {Component | null} */
export function componentParent(component) {
	return component?.[DIRTY_PARENT] ?? null;
}

/** @param {Component | null | undefined} component @returns {void} */
export function markComponentDirty(component) {
	if (!component) return;
	const wasDirty = !!component[DIRTY];
	component[DIRTY] = true;
	const parent = component[DIRTY_PARENT];
	if (parent && (!wasDirty || !parent[DIRTY])) {
		markComponentDirty(parent);
	}
}

/** @param {Component | null | undefined} component @param {number} [childIndex] @returns {void} */
function markComponentStructureDirty(component, childIndex = 0) {
	if (!component) return;
	component[STRUCTURE_DIRTY] = true;
	component[STRUCTURE_DIRTY_START] = Math.min(component[STRUCTURE_DIRTY_START] ?? childIndex, childIndex);
	markComponentDirty(component);
}

/** @param {Component | null | undefined} component @returns {boolean} */
function isRetainedComponent(component) {
	return !!component?.[RETAINED];
}

/** @param {Component | null | undefined} component @returns {boolean} */
function componentHasVolatileRender(component) {
	return !isRetainedComponent(component) || !!component?.[VOLATILE_CHILDREN];
}

/** @param {Component | null | undefined} component @returns {boolean} */
function isComponentDirty(component) {
	return !!component?.[DIRTY];
}

/** @param {Component | null | undefined} component @returns {void} */
function clearComponentDirty(component) {
	if (!component) return;
	component[DIRTY] = false;
	component[STRUCTURE_DIRTY] = false;
	component[STRUCTURE_DIRTY_START] = undefined;
}

/** @param {Component} component @param {number} width @returns {{ lines: string[], spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }} */
export function renderComponentFrame(component, width) {
	return normalizeRenderFrame(typeof component.renderFrame === "function"
		? component.renderFrame(width)
		: component.render(width));
}

/** @param {IncrementalRenderResult} result @returns {IncrementalRenderResult & { spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }} */
function normalizeIncrementalRenderResult(result) {
	const frame = normalizeRenderFrame(result);
	return { ...frame, dirtyStart: result.dirtyStart };
}

/** @param {Component} component @param {number} width @returns {IncrementalRenderResult & { spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }} */
function renderComponentIncremental(component, width) {
	if (!isRetainedComponent(component)) {
		return { ...renderComponentFrame(component, width), dirtyStart: 0 };
	}

	if (typeof component.renderIncremental === "function") {
		return normalizeIncrementalRenderResult(component.renderIncremental(width));
	}

	const cache = component[RENDER_CACHE];
	if (!isComponentDirty(component) && cache?.width === width) {
		return { lines: cache.lines, spans: cache.spans ?? [], sourceSpans: cache.sourceSpans ?? [], regions: cache.regions ?? [], dirtyStart: Infinity };
	}

	const frame = renderComponentFrame(component, width);
	component[RENDER_CACHE] = { width, lines: frame.lines, spans: frame.spans, sourceSpans: frame.sourceSpans, regions: frame.regions };
	clearComponentDirty(component);
	return { ...frame, dirtyStart: 0 };
}

/**
 * @param {Component} component
 * @param {string[]} lines
 * @param {number} width
 * @returns {import("./render-frame.js").RenderRegion[]}
 */
function componentFrameRegions(component, lines, width) {
	const endCol = Math.max(0, Math.floor(width));
	if (endCol <= 0) return [];
	return lines.map((_, line) => ({ line, startCol: 0, endCol, component, componentLine: line, componentStartCol: 0 }));
}

/**
 * @param {SelectionPoint} point
 * @param {import("./render-frame.js").RenderRegion | null} region
 * @returns {SelectionPoint | null}
 */
export function localPointForRegion(point, region) {
	if (!region || !Number.isFinite(region.componentLine)) return null;
	const componentStartCol = Number.isFinite(region.componentStartCol) ? Math.floor(region.componentStartCol) : 0;
	return {
		line: Math.floor(region.componentLine),
		col: Math.max(0, point.col - region.startCol + componentStartCol),
	};
}


/**
 * Base for retained TUI components.
 *
 * Components render raw terminal rows with `render(width) -> string[]`. Plain
 * components are deliberately safe-by-default: they are rendered every frame and
 * never cached, so old ad-hoc mutable widgets keep the old immediate-mode
 * behavior. Components that extend `RetainedComponent` opt into caching by
 * identity. Any method on a retained component that mutates render-affecting
 * state must call `this.markDirty()` before the next `requestRender()`.
 * Containers do this automatically for child add/remove operations and propagate
 * child dirtiness through parent links.
 */
export class RetainedComponent {
	constructor() {
		this[RETAINED] = true;
		this.markDirty();
	}

	markDirty() {
		markComponentDirty(this);
	}

	invalidate() {
		this.markDirty();
	}

	clearDirty() {
		clearComponentDirty(this);
	}
}

/**
 * Shared child-management and child-layout cache for components that own children.
 * Subclasses can either use the plain concatenating `Container` render, or call
 * `renderChildrenIncremental()` from a custom `renderIncremental()` implementation
 * (e.g. `Box`, which pads and backgrounds its children).
 */
export class RetainedContainer extends RetainedComponent {
	/** @type {Component[]} */
	children = [];

	/**
	 * @param {Component} component
	 * @returns {void}
	 */
	addChild(component) {
		const index = this.children.length;
		this.children.push(component);
		setComponentParent(component, this);
		markComponentStructureDirty(this, index);
	}

	/**
	 * @param {Component} component
	 * @returns {void}
	 */
	removeChild(component) {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			setComponentParent(component, null);
			markComponentStructureDirty(this, index);
		}
	}

	clear() {
		for (const child of this.children) setComponentParent(child, null);
		this.children = [];
		markComponentStructureDirty(this);
	}

	invalidate() {
		markComponentStructureDirty(this);
		for (const child of this.children) {
			child.invalidate?.();
			markComponentDirty(child);
		}
	}

	/**
	 * @param {number} width
	 * @returns {IncrementalRenderResult & { spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[], childRecords: ChildRenderRecord[] }}
	 */
	renderChildrenIncremental(width) {
		const cache = this[CHILDREN_CACHE];
		const widthChanged = cache?.width !== width;
		/** @type {string[]} */
		const lines = [];
		/** @type {import("./render-frame.js").RenderSpan[]} */
		const spans = [];
		/** @type {import("./render-frame.js").RenderSourceSpan[]} */
		const sourceSpans = [];
		/** @type {import("./render-frame.js").RenderRegion[]} */
		const regions = [];
		/** @type {ChildRenderRecord[]} */
		const childRecords = [];
		let dirtyStart = Infinity;
		let offset = 0;
		const structureDirty = this[STRUCTURE_DIRTY] || !cache || widthChanged;

		if (structureDirty) {
			if (!cache || widthChanged) {
				dirtyStart = 0;
			} else {
				const childIndex = Math.max(0, this[STRUCTURE_DIRTY_START] ?? 0);
				const previousRecords = cache.childRecords ?? [];
				const previousRecord = previousRecords[Math.min(childIndex, previousRecords.length - 1)];
				dirtyStart = childIndex >= previousRecords.length ? cache.lines.length : (previousRecord?.start ?? 0);
			}
		}

		let hasVolatileChildren = false;
		for (const child of this.children) {
			const childResult = renderComponentIncremental(child, width);
			if (componentHasVolatileRender(child)) hasVolatileChildren = true;
			if (childResult.dirtyStart !== Infinity) {
				dirtyStart = Math.min(dirtyStart, offset + childResult.dirtyStart);
			}
			for (const line of childResult.lines) lines.push(line);
			for (const region of offsetRegions(componentFrameRegions(child, childResult.lines, width), offset)) regions.push(region);
			for (const region of offsetRegions(childResult.regions, offset)) regions.push(region);
			for (const span of offsetSourceSpans(childResult.sourceSpans, offset)) sourceSpans.push(span);
			for (const span of offsetSpans(childResult.spans, offset)) spans.push(span);
			childRecords.push({ component: child, start: offset, length: childResult.lines.length });
			offset += childResult.lines.length;
		}
		this[VOLATILE_CHILDREN] = hasVolatileChildren;

		this[CHILDREN_CACHE] = { width, lines, spans, sourceSpans, regions, childRecords };
		return { lines, spans, sourceSpans, regions, dirtyStart, childRecords };
	}
}

/**
 * Container - a component that concatenates child render output.
 * @implements {Component}
 */
export class Container extends RetainedContainer {
	/**
	 * @param {number} width
	 * @returns {IncrementalRenderResult}
	 */
	renderIncremental(width) {
		const cache = this[RENDER_CACHE];
		const widthChanged = cache?.width !== width;
		if (!isComponentDirty(this) && !widthChanged && cache && !this[VOLATILE_CHILDREN]) {
			return { lines: cache.lines, spans: cache.spans ?? [], sourceSpans: cache.sourceSpans ?? [], regions: cache.regions ?? [], dirtyStart: Infinity };
		}

		const result = this.renderChildrenIncremental(width);
		this[RENDER_CACHE] = { width, lines: result.lines, spans: result.spans, sourceSpans: result.sourceSpans, regions: result.regions };
		this.clearDirty();
		return { lines: result.lines, spans: result.spans, sourceSpans: result.sourceSpans, regions: result.regions, dirtyStart: result.dirtyStart };
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		return this.renderIncremental(width).lines;
	}
}
