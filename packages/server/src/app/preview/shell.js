function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
}

function escapeAttribute(value) {
	return escapeHtml(value).replaceAll("'", "&#39;")
}

function jsonScript(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function pageHtml(options) {
	const title = escapeHtml(options.title || "Preview logs")
	const targetUrl = escapeAttribute(options.targetUrl)
	const config = jsonScript({
		targetUrl: options.targetUrl,
		statusUrl: options.statusUrl,
		logUrl: options.logUrl,
		restartUrl: options.restartUrl,
		name: options.name,
		autoOpenWhenReady: options.autoOpenWhenReady === true,
	})
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
	color-scheme: dark;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	background: #111;
	color: #f2f2f2;
}
html,
body {
	width: 100%;
	height: 100%;
	margin: 0;
}
body {
	display: grid;
	grid-template-rows: auto auto 1fr;
	overflow: hidden;
	background: #101010;
}
.bar {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
	padding: 12px 16px;
	border-bottom: 1px solid #333;
	background: #181818;
	color: #ddd;
	font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.dot {
	flex: none;
	width: 9px;
	height: 9px;
	border-radius: 50%;
	background: #d7a827;
	box-shadow: 0 0 0 3px rgba(215, 168, 39, .16);
}
.bar[data-state="ready"] .dot {
	background: #6a9955;
	box-shadow: 0 0 0 3px rgba(106, 153, 85, .16);
}
.bar.error .dot {
	background: #d14b4b;
	box-shadow: 0 0 0 3px rgba(209, 75, 75, .16);
}
.title {
	overflow: hidden;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.actions {
	margin-left: auto;
	display: flex;
	gap: 8px;
}
.action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-height: 30px;
	margin: 0;
	padding: 4px 10px;
	border: 1px solid #4a4a4a;
	border-radius: 4px;
	background: #232323;
	color: #e8e8e8;
	font: inherit;
	text-decoration: none;
	white-space: nowrap;
	cursor: pointer;
	transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.action:hover:not(:disabled) {
	border-color: #5d5d5d;
	background: #303030;
	color: #fff;
}
.action:focus-visible {
	outline: 2px solid #75beff;
	outline-offset: 2px;
}
.action.primary {
	border-color: #0e639c;
	background: #0e639c;
	color: #fff;
}
.action.primary:hover {
	border-color: #1177bb;
	background: #1177bb;
}
.action:disabled {
	opacity: .6;
	cursor: default;
}
.info {
	display: grid;
	gap: 6px;
	padding: 12px 16px;
	border-bottom: 1px solid #333;
	background: #151515;
	font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.info-row {
	display: grid;
	grid-template-columns: 4.75rem minmax(0, 1fr);
	align-items: baseline;
	gap: 10px;
	min-width: 0;
}
.info-label {
	color: #777;
	font-size: 10px;
	font-weight: 600;
	letter-spacing: .06em;
	text-transform: uppercase;
}
.info-value {
	overflow: hidden;
	color: #b8b8b8;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.info-value[data-state="ready"] {
	color: #89d185;
}
.info-value[data-state="error"],
.info-value[data-state="failed"] {
	color: #f48771;
}
pre {
	margin: 0;
	padding: 14px;
	overflow: auto;
	white-space: pre-wrap;
	word-break: break-word;
	font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	line-height: 1.45;
	color: #efefef;
	background: #101010;
}
</style>
</head>
<body>
<div id="bar" class="bar"><span class="dot" aria-hidden="true"></span><span id="title" class="title">Starting preview</span><div class="actions"><button id="restart" class="action" type="button">Restart</button><a class="action primary" href="${targetUrl}">Show preview</a></div></div>
<div class="info" aria-label="Preview details">
	<div class="info-row"><span class="info-label">Preview</span><span id="info-url" class="info-value"></span></div>
	<div class="info-row"><span class="info-label">Status</span><span id="info-status" class="info-value"></span></div>
	<div class="info-row"><span class="info-label">Log</span><span id="info-log-path" class="info-value"></span></div>
</div>
<pre id="log"></pre>
<script>
const config = ${config}
const bar = document.getElementById("bar")
const title = document.getElementById("title")
const log = document.getElementById("log")
const logText = document.createTextNode("")
const restart = document.getElementById("restart")
const infoUrl = document.getElementById("info-url")
const infoStatus = document.getElementById("info-status")
const infoLogPath = document.getElementById("info-log-path")
let currentStatus = { state: "starting" }
let currentLog = ""
let renderedLog = ""
let pollDelay = 350
let opened = false
let selectingLog = false

log.appendChild(logText)

function text(value) {
	return value == null ? "" : String(value)
}

function selectionTouches(element) {
	const selection = window.getSelection?.()
	if (!selection || selection.isCollapsed) return false
	if (element.contains(selection.anchorNode) || element.contains(selection.focusNode)) return true
	try {
		return selection.containsNode?.(element, true) === true
	} catch {
		return false
	}
}

function setElementText(element, value) {
	const next = text(value)
	if (element.textContent === next || selectionTouches(element)) return
	element.textContent = next
}

function logIsAtBottom() {
	return log.scrollHeight - log.clientHeight - log.scrollTop <= 2
}

function updateLogText(next) {
	if (next.startsWith(renderedLog)) {
		logText.appendData(next.slice(renderedLog.length))
	} else {
		let start = 0
		const sharedLength = Math.min(renderedLog.length, next.length)
		while (start < sharedLength && renderedLog.charCodeAt(start) === next.charCodeAt(start)) start++

		let previousEnd = renderedLog.length
		let nextEnd = next.length
		while (previousEnd > start && nextEnd > start && renderedLog.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)) {
			previousEnd--
			nextEnd--
		}
		logText.replaceData(start, previousEnd - start, next.slice(start, nextEnd))
	}
	renderedLog = next
}

function setLog(value) {
	currentLog = text(value)
	const next = currentLog || "[no preview output yet]"
	if (next === renderedLog || selectingLog || selectionTouches(log)) return
	const followTail = logIsAtBottom()
	updateLogText(next)
	if (followTail) log.scrollTop = log.scrollHeight
}

function updateInfo() {
	const state = text(currentStatus.state || "unknown")
	setElementText(infoUrl, config.targetUrl)
	infoUrl.title = config.targetUrl
	setElementText(infoStatus, state)
	infoStatus.dataset.state = state
	setElementText(infoLogPath, currentStatus.logPath || "Unavailable")
	infoLogPath.title = currentStatus.logPath || "Unavailable"
	bar.dataset.state = state
	if (currentStatus.error) {
		setElementText(title, currentStatus.error)
		bar.classList.add("error")
	} else {
		setElementText(title, config.autoOpenWhenReady && state === "ready" ? "Opening preview" : state === "ready" ? "Preview logs" : "Starting preview")
		bar.classList.remove("error")
	}
}

function openPreview() {
	if (opened || !config.autoOpenWhenReady) return
	opened = true
	window.location.reload()
}

async function fetchText(url) {
	const response = await fetch(url, { cache: "no-store" })
	return response.ok ? await response.text() : ""
}

async function fetchStatus() {
	const response = await fetch(config.statusUrl, {
		cache: "no-store",
		headers: { accept: "application/json" },
	})
	if (!response.ok) throw new Error("status " + response.status)
	return await response.json()
}

async function restartPreview() {
	if (!config.restartUrl || restart.disabled) return
	restart.disabled = true
	try {
		const response = await fetch(config.restartUrl, {
			method: "POST",
			cache: "no-store",
			headers: { accept: "application/json" },
		})
		if (!response.ok) throw new Error("restart failed with HTTP " + response.status)
		currentStatus = { state: "starting" }
		updateInfo()
		pollDelay = 350
	} finally {
		setTimeout(() => {
			restart.disabled = false
		}, 1000)
	}
}

async function poll() {
	try {
		const [status, nextLog] = await Promise.all([
			fetchStatus(),
			fetchText(config.logUrl),
		])
		currentStatus = status || {}
		setLog(nextLog)
		updateInfo()
		if (currentStatus.state === "ready") {
			pollDelay = 1200
			openPreview()
		} else if (currentStatus.state === "error") {
			pollDelay = 1200
		} else {
			pollDelay = 350
		}
	} catch (error) {
		currentStatus = { state: "error", error: error && error.message ? error.message : String(error) }
		updateInfo()
		pollDelay = 1200
	}
	setTimeout(poll, pollDelay)
}

log.addEventListener("pointerdown", () => {
	selectingLog = true
})
for (const eventName of ["pointerup", "pointercancel", "blur"]) {
	window.addEventListener(eventName, () => {
		selectingLog = false
	})
}
restart.addEventListener("click", () => {
	restartPreview().catch((error) => {
		currentStatus = { state: "error", error: error && error.message ? error.message : String(error) }
		updateInfo()
	})
})
updateInfo()
poll()
</script>
</body>
</html>`
}

export function previewShellResponse(options) {
	return new Response(pageHtml({ ...options, autoOpenWhenReady: true }), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	})
}

export function previewLogPageResponse(options) {
	return new Response(pageHtml({ ...options, autoOpenWhenReady: false, title: options.title || "Preview logs" }), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	})
}

export function previewInjectScriptResponse() {
	return new Response(`(() => {
	const script = document.currentScript
	const baseUrl = script && script.getAttribute("data-preview-log-page")
	if (!baseUrl || document.getElementById("cerex-preview-log-link")) return
	const host = document.createElement("cerex-preview-log-link")
	host.id = "cerex-preview-log-link"
	const root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host
	const style = document.createElement("style")
	style.textContent = \`
:host {
	position: fixed !important;
	left: -16px !important;
	bottom: -16px !important;
	z-index: 2147483647 !important;
	display: block !important;
	width: 48px !important;
	height: 48px !important;
	pointer-events: auto !important;
}
a {
	box-sizing: border-box;
	width: 48px;
	height: 48px;
	display: grid;
	place-items: center;
	border-radius: 50%;
	border: 1px solid rgba(255, 255, 255, .22);
	background: rgba(24, 24, 24, .88);
	color: #f1f1f1;
	box-shadow: 0 6px 24px rgba(0, 0, 0, .36);
	text-decoration: none;
}
a:hover,
a:focus-visible {
	transform: translate(6px, -6px);
	background: rgba(36, 36, 36, .95);
}
svg {
	width: 22px;
	height: 22px;
	transform: translate(4px, -4px);
}\`
	const link = document.createElement("a")
	link.setAttribute("aria-label", "Preview logs")
	link.setAttribute("title", "Preview logs")
	link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path></svg>'
	const updateHref = () => {
		const url = new URL(baseUrl, window.location.href)
		url.searchParams.set("next", window.location.pathname + window.location.search + window.location.hash)
		link.href = url.href
	}
	link.addEventListener("click", updateHref, true)
	updateHref()
	root.append(style, link)
	document.documentElement.append(host)
})()`, {
		status: 200,
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	})
}

export function previewFrameBridgeScriptResponse() {
	return new Response(`(() => {
	const source = "cerex-preview-frame"
	const target = "cerex-preview-frame-child"
	if (window.__previewFrameBridge) return
	window.__previewFrameBridge = true
	const bridgeScript = document.currentScript
	const documentLinks = bridgeScript?.hasAttribute("data-preview-document-links") === true
	const openDocumentPath = bridgeScript?.getAttribute("data-preview-open-path") || ""
	const documentPath = bridgeScript?.getAttribute("data-preview-document-path") || ""
	const parentPostMessage = window.parent.postMessage.bind(window.parent)
	const bridgeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : undefined
	const stopImmediatePropagation = typeof Event === "function"
		? Function.prototype.call.bind(Event.prototype.stopImmediatePropagation)
		: (event) => event.stopImmediatePropagation?.()

	if (window.parent !== window) {
		// An embedded preview may call focus() after it owns keyboard focus or while handling an actual user interaction, but mount and update effects must not claim focus from the host.
		const documentHasFocus = document.hasFocus.bind(document)
		const defer = window.setTimeout.bind(window)
		let userFocusIntent = false
		let userFocusIntentGeneration = 0
		const allowFocusForUserEvent = (event) => {
			if (!event.isTrusted) return
			const generation = ++userFocusIntentGeneration
			userFocusIntent = true
			defer(() => {
				if (generation === userFocusIntentGeneration) userFocusIntent = false
			}, 0)
		}
		const installFocusGuard = (owner) => {
			const nativeFocus = owner?.focus
			if (typeof nativeFocus !== "function") return
			const descriptor = Object.getOwnPropertyDescriptor(owner, "focus")
			try {
				Object.defineProperty(owner, "focus", {
					configurable: descriptor?.configurable ?? true,
					enumerable: descriptor?.enumerable ?? false,
					writable: descriptor?.writable ?? true,
					value: function focus(...args) {
						if (!documentHasFocus() && !userFocusIntent) return
						return Reflect.apply(nativeFocus, this, args)
					},
				})
			} catch {}
		}
		window.addEventListener("pointerdown", allowFocusForUserEvent, true)
		window.addEventListener("click", allowFocusForUserEvent, true)
		installFocusGuard(window)
		installFocusGuard(HTMLElement.prototype)
		if (typeof SVGElement !== "undefined") installFocusGuard(SVGElement.prototype)
	}

	let pending = false
	let userScrollFrame
	let scrollCommandGeneration = 0
	let applyingScrollCommand = false
	let connected = false
	let capability = ""
	const zoomCommandForKeyboardEvent = (event) => {
		if (!(event.metaKey || event.ctrlKey) || event.altKey) return ""
		if (event.code === "Equal" || event.code === "NumpadAdd" || event.key === "=" || event.key === "+" || event.key === "Add") return "in"
		if (event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-" || event.key === "_" || event.key === "\\u2212" || event.key === "Subtract") return "out"
		if (event.code === "Digit0" || event.code === "Numpad0" || event.key === "0") return "reset"
		return ""
	}
	const report = (reason) => {
		if (pending) return
		pending = true
		requestAnimationFrame(() => {
			pending = false
			parentPostMessage({
				source,
				kind: "location",
				reason,
				href: window.location.href,
				title: document.title || "",
				...(documentPath ? { documentPath } : {}),
			}, "*")
		})
	}
	const scrollRatio = () => {
		const root = document.scrollingElement || document.documentElement
		const maximum = Math.max(root.scrollHeight - window.innerHeight, 0)
		return maximum ? Math.min(Math.max(root.scrollTop / maximum, 0), 1) : 0
	}
	let sourceAnchorCache
	const invalidateSourceAnchors = () => { sourceAnchorCache = undefined }
	const sourceAnchors = () => {
		if (sourceAnchorCache) return sourceAnchorCache
		const root = document.scrollingElement || document.documentElement
		const countElement = document.querySelector("[data-cerex-source-line-count]")
		const lineCount = Number(countElement?.getAttribute("data-cerex-source-line-count"))
		const candidates = [{ sourceLine: 1, scrollTop: 0 }]
		let authored = 0
		for (const element of document.querySelectorAll?.("[data-cerex-source-line]") ?? []) {
			const sourceLine = Number(element.getAttribute("data-cerex-source-line"))
			const rect = element.getBoundingClientRect()
			if (!Number.isFinite(sourceLine) || sourceLine < 1 || (!rect.width && !rect.height)) continue
			candidates.push({ sourceLine, scrollTop: root.scrollTop + rect.top })
			authored++
		}
		if (!authored) return sourceAnchorCache = []
		if (Number.isFinite(lineCount) && lineCount >= 1) candidates.push({ sourceLine: lineCount + 1, scrollTop: root.scrollHeight })
		candidates.sort((left, right) => left.sourceLine - right.sourceLine || left.scrollTop - right.scrollTop)
		const anchors = []
		for (const anchor of candidates) {
			const previous = anchors.at(-1)
			if (!Number.isFinite(anchor.scrollTop) || anchor.scrollTop < 0 || previous?.sourceLine === anchor.sourceLine || (previous && anchor.scrollTop <= previous.scrollTop)) continue
			anchors.push(anchor)
		}
		return sourceAnchorCache = anchors
	}
	if (typeof window.MutationObserver === "function") {
		new window.MutationObserver(invalidateSourceAnchors).observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true })
	}
	let sourceResizeObserver
	if (typeof window.ResizeObserver === "function") {
		sourceResizeObserver = new window.ResizeObserver(invalidateSourceAnchors)
		sourceResizeObserver.observe(document.documentElement)
	}
	window.addEventListener("load", () => {
		if (document.body) sourceResizeObserver?.observe(document.body)
		invalidateSourceAnchors()
	})
	window.addEventListener("resize", invalidateSourceAnchors)
	const interpolateSourceAnchor = (anchors, value, input, output) => {
		if (!anchors.length || !Number.isFinite(value)) return undefined
		if (value <= anchors[0][input]) return anchors[0][output]
		for (let index = 1; index < anchors.length; index++) {
			const next = anchors[index]
			if (value > next[input]) continue
			const previous = anchors[index - 1]
			const span = next[input] - previous[input]
			if (span <= 0) return next[output]
			return previous[output] + (value - previous[input]) / span * (next[output] - previous[output])
		}
		return anchors.at(-1)[output]
	}
	const currentSourceLine = () => {
		const root = document.scrollingElement || document.documentElement
		return interpolateSourceAnchor(sourceAnchors(), root.scrollTop, "scrollTop", "sourceLine")
	}
	const postScroll = (cause, sequence) => {
		const sourceLine = currentSourceLine()
		parentPostMessage({
			source,
			kind: "scroll",
			cause,
			ratio: scrollRatio(),
			...(Number.isFinite(sourceLine) ? { sourceLine } : {}),
			...(Number.isFinite(sequence) ? { sequence } : {}),
		}, "*")
	}
	const reportUserScroll = () => {
		if (userScrollFrame !== undefined) return
		userScrollFrame = requestAnimationFrame(() => {
			userScrollFrame = undefined
			postScroll("user")
		})
	}
	const cancelUserScrollReport = () => {
		if (userScrollFrame === undefined) return
		cancelAnimationFrame(userScrollFrame)
		userScrollFrame = undefined
	}

	const wrapHistory = (name, reason) => {
		const original = window.history[name]
		if (typeof original !== "function") return
		window.history[name] = function(...args) {
			const result = original.apply(this, args)
			report(reason)
			return result
		}
	}

	wrapHistory("pushState", "push")
	wrapHistory("replaceState", "replace")
	window.addEventListener("popstate", () => report("pop"))
	window.addEventListener("hashchange", () => report("hash"))
	window.addEventListener("pageshow", () => report("load"))
	window.addEventListener("load", () => report("load"))
	window.addEventListener("scroll", () => {
		if (!applyingScrollCommand) reportUserScroll()
	}, { passive: true })
	window.addEventListener("keydown", (event) => {
		if (!connected) return
		const command = zoomCommandForKeyboardEvent(event)
		if (!command) return
		event.preventDefault()
		event.stopImmediatePropagation()
		parentPostMessage({ source, kind: "zoom", command }, "*")
	}, true)

	const linkForClick = (event) => {
		const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target]
		return path.find((node) => ["a", "area"].includes(node?.tagName?.toLowerCase?.()) && typeof node.getAttribute === "function")
	}
	const openExternalLink = (event) => {
		if (!connected || !capability || event.defaultPrevented || !event.isTrusted || event.altKey) return
		const linkActivation = (event.type === "click" && event.button === 0) || (event.type === "auxclick" && event.button === 1)
		if (!linkActivation) return
		const link = linkForClick(event)
		if (!link || link.hasAttribute("download")) return
		const href = link.getAttribute("href")
		if (!href) return
		let url
		try {
			url = new URL(href, document.baseURI || window.location.href)
		} catch {
			return
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === window.location.origin) return
		event.preventDefault()
		stopImmediatePropagation(event)
		parentPostMessage({ source, kind: "open-external", url: url.href, capability }, "*")
	}
	window.addEventListener("click", openExternalLink, true)
	window.addEventListener("auxclick", openExternalLink, true)
	const navigateDocumentLink = async (endpoint) => {
		if (!bridgeFetch) {
			window.location.href = endpoint.href
			return
		}
		try {
			const response = await bridgeFetch(endpoint.href, { headers: { accept: "application/json" } })
			if (!response.ok) throw new Error("Document link failed with status " + response.status)
			const result = await response.json()
			if (result?.kind === "preview" && typeof result.url === "string") window.location.href = result.url
			else if (result?.kind === "workspace" && typeof result.url === "string" && capability) {
				parentPostMessage({ source, kind: "open-workspace", url: result.url, capability }, "*")
			}
			else throw new Error("Invalid document link response")
		} catch {
			window.location.href = endpoint.href
		}
	}
	if (documentLinks && openDocumentPath) {
		window.addEventListener("click", (event) => {
			if (event.defaultPrevented || !event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
			const link = linkForClick(event)
			if (!link || link.hasAttribute("download")) return
			const targetName = (link.getAttribute("target") || "").trim().toLowerCase()
			if (targetName && targetName !== "_self" && targetName !== "_blank") return
			const href = link.getAttribute("href")
			if (!href || href.startsWith("#")) return
			let resolved
			let base
			try {
				base = new URL(document.baseURI || window.location.href)
				resolved = new URL(href, base)
			} catch {
				return
			}
			if (resolved.origin !== window.location.origin || base.origin !== window.location.origin) return
			const endpoint = new URL(openDocumentPath, window.location.origin)
			endpoint.searchParams.set("from", base.pathname)
			endpoint.searchParams.set("href", href)
			event.preventDefault()
			event.stopImmediatePropagation()
			if (window.parent === window && targetName === "_blank") window.open(endpoint.href, "_blank", "noopener")
			else if (window.parent === window) window.location.href = endpoint.href
			else void navigateDocumentLink(endpoint)
		}, true)
	}

	const title = document.querySelector("title")
	if (title && "MutationObserver" in window) {
		new MutationObserver(() => report("title")).observe(title, { childList: true, characterData: true, subtree: true })
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) return
		const message = event.data
		if (!message || typeof message !== "object" || message.source !== source || message.target !== target) return
		stopImmediatePropagation(event)
		if (message.kind === "connect" && window.parent !== window) {
			connected = true
			if (typeof message.capability === "string") capability = message.capability
		}
		else if (message.kind === "back") window.history.back()
		else if (message.kind === "forward") window.history.forward()
		else if (message.kind === "reload") window.location.reload()
		else if (message.kind === "scroll" && typeof message.ratio === "number" && Number.isFinite(message.sequence)) {
			const root = document.scrollingElement || document.documentElement
			const maximum = Math.max(root.scrollHeight - window.innerHeight, 0)
			const ratio = Math.min(Math.max(message.ratio, 0), 1)
			const sourceScrollTop = interpolateSourceAnchor(sourceAnchors(), message.sourceLine, "sourceLine", "scrollTop")
			const scrollTop = (ratio === 0 || ratio === 1 || !Number.isFinite(sourceScrollTop))
				? ratio * maximum
				: Math.min(Math.max(sourceScrollTop, 0), maximum)
			const generation = ++scrollCommandGeneration
			cancelUserScrollReport()
			applyingScrollCommand = true
			window.scrollTo({ top: scrollTop, behavior: "instant" })
			postScroll("command", message.sequence)
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (generation === scrollCommandGeneration) applyingScrollCommand = false
				})
			})
		}
		else if (message.kind === "navigate" && typeof message.url === "string") {
			const url = new URL(message.url, window.location.href)
			if (url.origin === window.location.origin) window.location.href = url.href
		}
	})

	report("ready")
})()`, {
		status: 200,
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	})
}

function injectBeforePageScripts(html, snippet) {
	const preamble = html.match(/^(?:\uFEFF)?(?:\s+|<!--[\s\S]*?-->)*(?:<!doctype(?:\s[^>]*)?>)?(?:\s+|<!--[\s\S]*?-->)*/i)?.[0] ?? ""
	let headStart = preamble.length
	const htmlElement = html.slice(headStart).match(/^<html(?:\s[^>]*)?>/i)
	if (htmlElement) {
		headStart += htmlElement[0].length
		headStart += html.slice(headStart).match(/^(?:\s+|<!--[\s\S]*?-->)*/)?.[0].length ?? 0
	}
	const head = html.slice(headStart).match(/^<head(?:\s[^>]*)?>/i)
	if (head) {
		const insertAt = headStart + head[0].length
		return `${html.slice(0, insertAt)}${snippet}${html.slice(insertAt)}`
	}
	return `${preamble}${snippet}${html.slice(preamble.length)}`
}

function injectBeforeBodyEnd(html, snippet) {
	const body = html.match(/<\/body\s*>/i)
	if (body?.index !== undefined) return `${html.slice(0, body.index)}${snippet}${html.slice(body.index)}`
	const htmlEnd = html.match(/<\/html\s*>/i)
	if (htmlEnd?.index !== undefined) return `${html.slice(0, htmlEnd.index)}${snippet}${html.slice(htmlEnd.index)}`
	return `${html}${snippet}`
}

export function injectPreviewFrameBridge(html, options) {
	const scriptUrl = escapeAttribute(options.scriptUrl)
	if (!scriptUrl) return html
	const documentLinkAttributes = options.documentLinks
		? ` data-preview-document-links data-preview-open-path="${escapeAttribute(options.openPath)}"`
		: ""
	const documentPathAttribute = options.documentPath
		? ` data-preview-document-path="${escapeAttribute(options.documentPath)}"`
		: ""
	return injectBeforePageScripts(html, `<script src="${scriptUrl}" data-preview-frame-bridge${documentLinkAttributes}${documentPathAttribute}></script>`)
}

export async function injectPreviewPageScripts(response, options) {
	if (!response.body || response.headers.get("content-encoding")) return response
	const contentType = response.headers.get("content-type") || ""
	if (!/\btext\/html\b/i.test(contentType)) return response
	const logPageUrl = escapeAttribute(options.logPageUrl)
	const logScriptUrl = escapeAttribute(options.logScriptUrl)
	const frameBridgeScriptUrl = escapeAttribute(options.frameBridgeScriptUrl)
	let html = await response.text()
	const headers = new Headers(response.headers)
	headers.delete("content-length")
	headers.delete("content-security-policy")
	headers.delete("content-security-policy-report-only")
	if (frameBridgeScriptUrl) html = injectPreviewFrameBridge(html, { scriptUrl: frameBridgeScriptUrl })
	html = injectBeforeBodyEnd(html, `<script src="${logScriptUrl}" data-preview-log-page="${logPageUrl}" defer></script>`)
	return new Response(html, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
