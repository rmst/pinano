import {
	Input,
	MouseWheelDeltaTracker,
	RetainedComponent,
	clickableRowSpan,
	clipLinesToViewport,
	getKeybindings,
	hyperlink,
	matchesKey,
	nextSelectionIndex,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../../tui/index.js"
import { loginCodex } from "../../../../../server/src/ai-apis/codex/index.js"
import { API_KEY_PROVIDER_INFOS, deleteCredential, detectedEnvApiKeys, getCredential, listProviders, setCredential } from "../../../../../server/src/app/auth/credentials.js"
import { availableModelEntries, modelRef, modelRefMatches } from "../../../../../server/src/app/model/registry.js"
import { loadSettings } from "../../../../../server/src/app/settings.js"
import { authFilePath } from "../../../../../server/src/app/paths.js"
import { pickFromOverlay } from "../../components/picker.js"
import { promptForInput } from "../../components/prompt-input.js"
import { theme } from "../../theme.js"
import { fit } from "../format.js"
import { openUrlInBrowser } from "../browser-open.js"
import { currentDefaultModelRef, updateDefaultModel } from "./model-preferences.js"

export async function loadSubscriptionProviders() {
	const next = new Set()
	for (const provider of await listProviders()) {
		const cred = await getCredential(provider)
		if (cred?.kind === "codex") next.add(provider)
	}
	return next
}

const providerLabel = (provider) => API_KEY_PROVIDER_INFOS.find((info) => info.provider === provider)?.label ?? provider

/** @param {string} secret */
function maskSecret(secret) {
	const value = secret.trim()
	if (!value) return ""
	if (value.length <= 8) return "••••"
	return `${value.slice(0, 4)}…${value.slice(-4)}`
}

async function saveCodexCredentials(credentials) {
	await setCredential("openai-codex", {
		kind: "codex",
		access: credentials.access,
		refresh: credentials.refresh,
		idToken: credentials.idToken,
		accountId: credentials.accountId,
		expiresAt: credentials.expires,
		createdAt: Date.now(),
	})
}

async function ensureConfiguredDefaultModel({ setDefaultModel, onSettingsChanged } = {}) {
	const settings = await loadSettings()
	const models = await availableModelEntries()
	if (models.length === 0) return settings
	if (models.some((entry) => modelRefMatches(entry, currentDefaultModelRef(settings)))) return settings
	const next = modelRef(models[0])
	const updated = await setDefaultModel?.(next) ?? await updateDefaultModel(next, settings)
	await onSettingsChanged?.(updated)
	return updated
}

class ChatGptOAuthModal extends RetainedComponent {
	constructor(tui, { onCancel } = {}) {
		super()
		this.tui = tui
		this.onCancel = onCancel
		this.onManualCode = undefined
		this.status = "Starting ChatGPT OAuth…"
		this.instructions = "Complete the login in your browser, then return to Cerex."
		this.url = ""
		this.cancelled = false
		this.manualCodeBusy = false
		this.focused = false
		this.input = new Input()
		this.input.onSubmit = (value) => void this.submitManualCode(value)
		this.input.onEscape = () => this.cancel()
	}

	setAuth({ url, instructions }) {
		this.url = url
		this.instructions = instructions || this.instructions
		this.markDirty()
		this.tui.requestRender()
	}

	setManualCodeSubmitHandler(handler) {
		this.onManualCode = handler
		this.markDirty()
		this.tui.requestRender()
	}

	setStatus(status) {
		this.status = status
		this.markDirty()
		this.tui.requestRender()
	}

	cancel() {
		if (this.cancelled) return
		this.cancelled = true
		this.setStatus("Cancelling ChatGPT login…")
		this.onCancel?.()
	}

	async submitManualCode(value) {
		const input = value.trim()
		if (this.cancelled || this.manualCodeBusy) return
		if (!input) {
			this.setStatus("Paste the authorization code or full redirect URL, then press Enter.")
			return
		}
		this.manualCodeBusy = true
		this.input.setValue("")
		this.setStatus("Authorization code submitted; finishing login.")
		try {
			await this.onManualCode?.(input)
		} finally {
			this.manualCodeBusy = false
			this.markDirty()
			this.tui.requestRender()
		}
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings()
		if (data === "\x03") {
			this.cancel()
			return
		}
		if (this.manualCodeBusy && !kb.matches(data, "tui.select.cancel")) return
		this.input.handleInput(data)
		this.markDirty()
	}

	/** @param {number} width */
	render(width) {
		const modalWidth = Math.max(44, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const height = Math.max(12, this.tui.terminal?.rows ?? 24)
		const border = theme.fg("border", "─".repeat(modalWidth))
		this.input.focused = this.focused && !this.cancelled
		const lines = [
			border,
			fit(theme.bold(" ChatGPT subscription login"), modalWidth),
			border,
			...wrapTextWithAnsi(theme.dim(` ${this.instructions}`), modalWidth).map((line) => fit(line, modalWidth)),
			border,
			fit(theme.bold(" Authorization code or redirect URL"), modalWidth),
			...this.input.render(innerWidth).map((line) => fit(`  ${line}`, modalWidth)),
		]
		if (this.url) {
			lines.push(border)
			lines.push(fit(theme.bold(" Login URL"), modalWidth))
			lines.push(...wrapTextWithAnsi(` ${hyperlink(this.url, this.url)}`, modalWidth).map((line) => fit(line, modalWidth)))
		}
		lines.push(border)
		lines.push(...wrapTextWithAnsi(` ${this.cancelled ? theme.cyan("Cancelling…") : theme.cyan("Status:")} ${this.status}`, modalWidth).map((line) => fit(line, modalWidth)))
		lines.push(border)
		lines.push(fit(theme.dim(" Enter submit · Esc cancel ChatGPT login"), modalWidth))
		while (lines.length < height) lines.push(fit("", modalWidth))
		return lines
	}
}

export class CredentialsSettingsModal extends RetainedComponent {
	constructor(tui, options = {}) {
		super()
		this.tui = tui
		this.options = options
		this.rows = []
		this.selectedIndex = 0
		this.status = options.onboarding
			? "Choose a model provider before starting."
			: ""
		this.busy = false
		this.onClose = undefined
		this.stored = new Map()
		this.envKeys = []
		this.wheelDeltas = new MouseWheelDeltaTracker()
	}

	async reload() {
		this.stored = new Map()
		for (const provider of await listProviders()) this.stored.set(provider, await getCredential(provider))
		this.envKeys = detectedEnvApiKeys()
		this.rebuildRows()
	}

	rebuildRows() {
		const codex = this.stored.get("openai-codex")
		const envProviders = new Set(this.envKeys.map((candidate) => candidate.provider))
		this.rows = [
			{
				id: "chatgpt",
				kind: "chatgpt",
				label: "Use your ChatGPT subscription",
				value: codex?.kind === "codex" ? `connected${codex.accountId ? ` · ${codex.accountId}` : ""}` : "OAuth",
				description: "Starts the OpenAI OAuth flow. Usage is subject to your ChatGPT plan and OpenAI's terms.",
			},
			{ id: "spacer:api-keys", kind: "spacer", label: "", value: "" },
			{ id: "section:api-keys", kind: "section", label: "API keys", value: "" },
		]

		if (this.envKeys.length > 0) {
			this.rows.push(...this.envKeys.map((candidate) => {
				const credential = this.stored.get(candidate.provider)
				const saved = credential?.kind === "apiKey"
				const differs = saved && credential.apiKey !== candidate.apiKey
				return {
					id: `env:${candidate.provider}:${candidate.envVar}`,
					kind: "env-api-key",
					candidate,
					label: `${saved ? differs ? "Update" : "Saved" : "Save"} ${candidate.envVar}`,
					value: `${saved ? "[x]" : "[ ]"}${differs ? " env differs" : saved ? " saved" : ""}`,
					description: saved
						? differs
							? `A different ${candidate.providerLabel} API key is saved. Space updates Cerex to the environment value (${maskSecret(candidate.apiKey)}). Select it again after updating to remove it.`
							: `${candidate.providerLabel} API key is saved (${maskSecret(candidate.apiKey)}). Space removes it from Cerex.`
						: `Detected ${candidate.providerLabel} API key in the environment (${maskSecret(candidate.apiKey)}). Space saves it to Cerex's credential store.`,
				}
			}))
		} else {
			this.rows.push({
				id: "env-none",
				kind: "noop",
				label: "Environment API keys",
				value: "none found",
				description: "Launch Cerex with OPENAI_API_KEY, MOONSHOT_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY, or LLAMACPP_API_KEY to import supported API keys here.",
			})
		}

		this.rows.push({
			id: "manual-api-key",
			kind: "manual-api-key",
			label: "Add a different API key…",
			value: "",
			description: "Enter an API key manually for OpenAI, Moonshot, DeepSeek, or a local OpenAI-compatible endpoint.",
		})

		for (const [provider, credential] of this.stored) {
			if (credential?.kind === "codex") this.rows.push({
				id: `remove:${provider}`,
				kind: "remove",
				provider,
				label: "Remove ChatGPT subscription",
				value: credential.accountId ?? "connected",
				description: "Deletes the stored OAuth refresh token from Cerex.",
			})
			else if (credential?.kind === "apiKey" && !envProviders.has(provider)) this.rows.push({
				id: `remove:${provider}`,
				kind: "remove",
				provider,
				label: `Remove ${providerLabel(provider)} API key`,
				value: "saved",
				description: "Deletes the stored API key from Cerex. This does not change environment variables or settings provider keys.",
			})
		}

		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1))
		if (!this.isSelectableRow(this.rows[this.selectedIndex])) this.selectedIndex = this.firstSelectableIndex()
		this.markDirty()
		this.tui.requestRender()
	}

	isSelectableRow(row) {
		return row && row.kind !== "spacer" && row.kind !== "section" && row.kind !== "noop"
	}

	isClickableRow(row) {
		if (!this.isSelectableRow(row)) return false
		if (row.kind !== "env-api-key") return true
		return /^Save |^Update /.test(row.label)
	}

	firstSelectableIndex() {
		const index = this.rows.findIndex((row) => this.isSelectableRow(row))
		return index >= 0 ? index : 0
	}

	moveSelection(direction, steps = 1, options = {}) {
		if (this.rows.length === 0) return false
		const next = nextSelectionIndex(this.selectedIndex, this.rows.length, direction * steps, {
			wrap: options.wrap !== false,
			isSelectable: (index) => this.isSelectableRow(this.rows[index]),
		})
		if (next === this.selectedIndex) return false
		this.selectedIndex = next
		this.markDirty()
		this.tui.requestRender()
		return true
	}

	/** @param {string} message */
	setStatus(message) {
		this.status = message
		this.markDirty()
		this.tui.requestRender()
	}

	async afterCredentialChange(message) {
		await this.options.refreshAuthCache?.()
		const settings = await ensureConfiguredDefaultModel({
			setDefaultModel: this.options.setDefaultModel,
			onSettingsChanged: this.options.onSettingsChanged,
		})
		await this.reload()
		const model = currentDefaultModelRef(settings)
		this.setStatus(message + (model ? ` · default model: ${model}` : ""))
	}

	async startChatGptOAuth() {
		this.busy = true
		this.setStatus("Starting ChatGPT OAuth…")
		const controller = new AbortController()
		const manualPromptController = new AbortController()
		const oauthModal = new ChatGptOAuthModal(this.tui, {
			onCancel: () => {
				controller.abort()
				manualPromptController.abort()
			},
		})
		const manualInputs = []
		const manualWaiters = []
		let requestManualCode
		let manualRequestBusy = false
		const provideManualInput = (value) => {
			const waiter = manualWaiters.shift()
			if (waiter) waiter(value)
			else manualInputs.push(value)
		}
		const waitForManualInput = (signal) => {
			if (manualInputs.length > 0) return Promise.resolve(manualInputs.shift())
			return new Promise((resolve) => {
				let done = false
				const waiter = (value) => {
					if (done) return
					done = true
					signal?.removeEventListener("abort", abort)
					resolve(value)
				}
				const abort = () => {
					const index = manualWaiters.indexOf(waiter)
					if (index !== -1) manualWaiters.splice(index, 1)
					waiter(null)
				}
				manualWaiters.push(waiter)
				if (signal?.aborted) abort()
				else signal?.addEventListener("abort", abort, { once: true })
			})
		}
		const runManualCodeRequest = async () => {
			if (!requestManualCode || manualRequestBusy) return
			manualRequestBusy = true
			try {
				const result = await requestManualCode()
				if (result?.status === "submitted") oauthModal.setStatus("Authorization code submitted; finishing login.")
				else if (result?.status === "cancelled") oauthModal.setStatus("Still waiting for ChatGPT login.")
				else if (result?.status === "busy") oauthModal.setStatus("Authorization code submission is already in progress.")
				else if (result?.status === "error") oauthModal.setStatus(`Could not use authorization code: ${result.error?.message ?? result.error}`)
			} finally {
				manualRequestBusy = false
			}
		}
		oauthModal.setManualCodeSubmitHandler(async (value) => {
			provideManualInput(value)
			if (requestManualCode) await runManualCodeRequest()
			else oauthModal.setStatus("Authorization code submitted; finishing login.")
		})
		const oauthHandle = this.tui.showOverlay(oauthModal, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			backdrop: true,
		})
		let closeAfterOAuth = false
		try {
			const credentials = await (this.options.loginCodex ?? loginCodex)({
				signal: controller.signal,
				onAuth: ({ url, instructions, requestManualCode: nextRequestManualCode }) => {
					requestManualCode = nextRequestManualCode
					oauthModal.setAuth({ url, instructions })
					oauthModal.setStatus("Complete ChatGPT login in your browser.")
					if (requestManualCode && manualInputs.length > 0) void runManualCodeRequest()
					this.setStatus(`Complete ChatGPT login in your browser. If it did not open, visit: ${url}`)
					void openUrlInBrowser(url).then((opened) => {
						if (controller.signal.aborted) return
						oauthModal.setStatus(opened ? "Browser opened. Complete ChatGPT login to finish." : "Browser did not open. Use the login URL above.")
						this.setStatus(opened ? `Browser opened. Complete ChatGPT login to finish. If it did not open, visit: ${url}` : `Open this URL to finish ChatGPT login: ${url}`)
					})
				},
				onPrompt: async () => {
					oauthModal.setStatus("Paste the authorization code or full redirect URL, then press Enter.")
					return await waitForManualInput(manualPromptController.signal)
				},
			})
			await saveCodexCredentials(credentials)
			await this.afterCredentialChange(`Saved ChatGPT subscription credentials to ${authFilePath("openai-codex")}`)
			closeAfterOAuth = true
		} catch (err) {
			this.setStatus(controller.signal.aborted ? "ChatGPT login cancelled" : `ChatGPT login failed: ${err?.message ?? err}`)
		} finally {
			manualPromptController.abort()
			oauthHandle.hide()
			this.busy = false
			this.markDirty()
			this.tui.requestRender()
			if (closeAfterOAuth) this.onClose?.()
		}
	}

	async addManualApiKey() {
		const provider = await pickFromOverlay(
			this.tui,
			API_KEY_PROVIDER_INFOS.map((info) => ({ value: info.provider, label: info.label })),
			{
				title: "Add a different API key",
				subtitle: "Choose the provider this API key should be used with.",
				maxVisible: API_KEY_PROVIDER_INFOS.length,
			},
		) ?? ""
		if (!provider) {
			this.setStatus("API key entry cancelled")
			return
		}
		this.setStatus(`Paste ${providerLabel(provider)} API key.`)
		const apiKey = (await promptForInput(this.tui, `${providerLabel(provider)} API key`, {
			secret: true,
			title: `${providerLabel(provider)} API key`,
			subtitle: "Paste the key. It will be stored in Cerex's local credential store.",
		}))?.trim() ?? ""
		if (!apiKey) {
			this.setStatus("API key entry cancelled")
			return
		}
		await setCredential(provider, { kind: "apiKey", apiKey, createdAt: Date.now() })
		await this.afterCredentialChange(`Saved ${providerLabel(provider)} API key to ${authFilePath(provider)}`)
	}

	async toggleEnvApiKey(candidate) {
		const credential = this.stored.get(candidate.provider)
		if (credential?.kind === "apiKey" && credential.apiKey !== candidate.apiKey) {
			await setCredential(candidate.provider, { kind: "apiKey", apiKey: candidate.apiKey, createdAt: Date.now() })
			await this.afterCredentialChange(`Updated ${candidate.providerLabel} API key from ${candidate.envVar}`)
			return
		}
		if (credential?.kind === "apiKey") {
			await deleteCredential(candidate.provider)
			await this.afterCredentialChange(`Removed ${candidate.providerLabel} API key`)
			return
		}
		await setCredential(candidate.provider, { kind: "apiKey", apiKey: candidate.apiKey, createdAt: Date.now() })
		await this.afterCredentialChange(`Saved ${candidate.providerLabel} API key from ${candidate.envVar}`)
	}

	async removeCredential(provider) {
		const confirm = await pickFromOverlay(this.tui, [
			{ value: "remove", label: "Remove credential", description: `Delete ${providerLabel(provider)} credentials from Cerex` },
			{ value: "cancel", label: "Cancel", description: "Keep the credential" },
		], {
			title: "Remove credential",
			subtitle: "This only changes Cerex's stored credentials.",
			maxVisible: 2,
		})
		if (confirm !== "remove") {
			this.setStatus("remove cancelled")
			return
		}
		await deleteCredential(provider)
		await this.afterCredentialChange(`Removed credential for ${providerLabel(provider)}`)
	}

	async activateSelected() {
		if (this.busy) return
		const row = this.rows[this.selectedIndex]
		if (!row) return
		if (row.kind === "chatgpt") {
			await this.startChatGptOAuth()
			return
		}
		if (row.kind === "manual-api-key") {
			await this.addManualApiKey()
			return
		}
		if (row.kind === "env-api-key") {
			await this.toggleEnvApiKey(row.candidate)
			return
		}
		if (row.kind === "remove") await this.removeCredential(row.provider)
	}

	/** @param {number} index */
	activateRow(index) {
		const row = this.rows[index]
		if (!this.isClickableRow(row) || this.busy) return
		this.selectedIndex = Math.max(0, Math.min(index, this.rows.length - 1))
		this.markDirty()
		this.tui.requestRender()
		void this.activateSelected().catch((err) => this.setStatus(`credentials error: ${err?.message ?? err}`))
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings()
		if (!this.busy && kb.matches(data, "tui.select.cancel")) {
			this.onClose?.()
			return
		}
		if (this.busy) return
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1)
			return
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1)
			return
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-1, 8)
			return
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(1, 8)
			return
		}
		const row = this.rows[this.selectedIndex]
		if (matchesKey(data, "enter")) {
			if (row?.kind === "env-api-key") this.onClose?.()
			else void this.activateSelected().catch((err) => this.setStatus(`credentials error: ${err?.message ?? err}`))
			return
		}
		if (matchesKey(data, "space") || data === " ") {
			void this.activateSelected().catch((err) => this.setStatus(`credentials error: ${err?.message ?? err}`))
		}
	}

	/** @param {import("../../../tui/tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		if (this.busy) return { consume: false }
		const delta = this.wheelDeltas.deltaFromEvent(event)
		if (delta === 0) return { consume: false }
		this.moveSelection(delta, 1, { wrap: false })
		return { consume: true }
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../../tui/render-frame.js").RenderSpan[] }}
	 */
	renderFrame(width) {
		const modalWidth = Math.max(44, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const border = theme.fg("border", "─".repeat(modalWidth))
		const selected = this.rows[this.selectedIndex]
		const maxLabelWidth = Math.min(36, Math.max(12, ...this.rows.map((row) => visibleWidth(row.label))))
		const visibleRows = clipLinesToViewport({
			lines: this.rows.map((row, index) => this.renderRow(row, index, innerWidth, maxLabelWidth)),
			maxLines: Math.max(4, Math.min(12, this.rows.length)),
			anchorLine: this.selectedIndex,
			scrollOffset: this.scrollOffset ?? 0,
			topIndicator: (hidden) => theme.dim(`↑ ${hidden} more`),
			bottomIndicator: (hidden) => theme.dim(`↓ ${hidden} more`),
		})
		this.scrollOffset = visibleRows.scrollOffset
		const subtitle = this.options.onboarding
			? "No model provider is configured yet. Cerex is currently optimized for use with a ChatGPT subscription. API keys are also supported."
			: "Cerex is currently optimized for use with a ChatGPT subscription. API keys are also supported."
		/** @type {import("../../../tui/render-frame.js").RenderSpan[]} */
		const spans = []
		const lines = [
			border,
			fit(theme.bold(" Model provider credentials"), modalWidth),
			...wrapTextWithAnsi(theme.dim(` ${subtitle}`), modalWidth).map((line) => fit(line, modalWidth)),
			border,
		]
		const rowStartLine = lines.length
		for (let i = 0; i < visibleRows.lines.length; i++) {
			const sourceIndex = visibleRows.sourceLineIndexes[i]
			const line = fit(`  ${visibleRows.lines[i]}`, modalWidth)
			lines.push(line)
			if (sourceIndex === null || sourceIndex === undefined) continue
			const row = this.rows[sourceIndex]
			if (!this.isClickableRow(row)) continue
			const span = clickableRowSpan({
				line: rowStartLine + i,
				text: line,
				width: modalWidth,
				startCol: 2,
				component: this,
				id: `credentials.row.${row.id}`,
				label: row.label,
				metadata: { row, index: sourceIndex },
				onClick: () => this.activateRow(sourceIndex),
			})
			if (span) spans.push(span)
		}
		if (selected?.description) {
			lines.push(border)
			lines.push(...wrapTextWithAnsi(theme.dim(` ${selected.description}`), modalWidth).map((line) => fit(line, modalWidth)))
		}
		if (this.status) {
			lines.push(border)
			lines.push(...wrapTextWithAnsi(` ${this.busy ? theme.cyan("Working…") : theme.cyan("Status:")} ${this.status}`, modalWidth).map((line) => fit(line, modalWidth)))
		}
		lines.push(border)
		lines.push(fit(theme.dim(this.busy ? " Please wait…" : " ↑/↓ move · Enter open · Space toggle API keys · Esc close"), modalWidth))
		while (lines.length < (this.tui.terminal?.rows ?? 0)) lines.push(fit("", modalWidth))
		return { lines, spans }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}

	renderRow(row, index, width, labelWidth) {
		if (row.kind === "spacer") return ""
		if (row.kind === "section") return theme.dim(row.label)
		const isSelected = index === this.selectedIndex
		const prefix = isSelected ? "→ " : "  "
		const label = row.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)))
		const value = row.value ?? ""
		const raw = truncateToWidth(`${prefix}${label}  ${value}`, width)
		return isSelected ? theme.bg("selectedBg", raw) : raw
	}
}

export async function showCredentialsSettings(tui, options = {}) {
	const modal = new CredentialsSettingsModal(tui, options)
	await modal.reload()
	return new Promise((resolve) => {
		const handle = tui.showOverlay(modal, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			backdrop: true,
		})
		modal.onClose = () => {
			handle.hide()
			resolve()
		}
	})
}
