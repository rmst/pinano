import {
	RetainedComponent,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../tui/index.js"
import { defaultNativeSandboxEnvironment, disableEnvironmentSandbox, loadEnvironmentRegistry } from "./environments.js"
import { theme } from "./theme.js"
import { probeNativeSandbox } from "./worker-launchers.js"
import { downloadBundledBubblewrap as downloadBundledBubblewrapAsset } from "./bundled-bwrap.js"

export const nativeSandboxOnboardingPollMs = 5000

/** @param {string} text */
function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/**
 * @param {string} text
 * @param {number} width
 */
function fit(text, width) {
	const clipped = truncateToWidth(text, Math.max(1, width), "")
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(stripAnsi(clipped))))
}

/** @param {unknown} value */
function singleLine(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim()
}

/** @param {number} pollMs */
function pollSeconds(pollMs) {
	return Math.max(1, Math.round(pollMs / 1000))
}

/** @param {string} platform */
function titleForPlatform(platform) {
	if (platform === "linux") return "Bubblewrap is not available"
	if (platform === "darwin") return "macOS sandbox-exec failed"
	return "Native sandboxing is unavailable"
}

function canDownloadBundledBubblewrapFromProbe(probe) {
	return Boolean(probe?.downloadableBundledBubblewrap)
}

/** @param {string} platform @param {any} [probe] */
function bodyForPlatform(platform, probe) {
	if (platform === "linux") {
		const base = [
			"Pinano uses bubblewrap (bwrap) for Linux native tool sandboxing. The default local environment is configured for native sandboxing, but the sandbox probe failed.",
		]
		if (canDownloadBundledBubblewrapFromProbe(probe)) {
			return [
				...base,
				"System bwrap was not found. Pinano can download a pinned static Bubblewrap binary from the Pinano release assets, verify its digest, cache it under PINANO_HOME, and retry the sandbox.",
			]
		}
		return [
			...base,
			"Install bubblewrap, or enable unprivileged user namespaces if your distro requires it, and keep this page open; Pinano checks again automatically.",
		]
	}
	if (platform === "darwin") {
		return [
			"Pinano uses sandbox-exec for macOS native tool sandboxing. The default local environment is configured for native sandboxing, but the sandbox probe failed.",
			"This can happen when Pinano itself is already running inside sandbox-exec, because sandbox-exec does not nest. Keep this page open to retry automatically.",
		]
	}
	return [
		"Pinano could not start the configured native tool sandbox.",
		"Keep this page open to retry automatically.",
	]
}

/**
 * @param {{ platform?: string, registry?: ReturnType<typeof loadEnvironmentRegistry>, probe?: (options: { platform: string }) => Promise<any> }} [options]
 */
export async function nativeSandboxStartupIssue(options = {}) {
	const platform = options.platform ?? process.platform
	const registry = options.registry ?? loadEnvironmentRegistry()
	const target = defaultNativeSandboxEnvironment(registry, platform)
	if (!target) return undefined
	const probe = options.probe ?? probeNativeSandbox
	const result = await probe({ platform: target.platform })
	return result.ok ? undefined : { target, probe: result }
}

export class NativeSandboxStartupPage extends RetainedComponent {
	/**
	 * @param {object} options
	 * @param {{ target: { environmentId: string, platform: string }, probe: any }} options.issue
	 * @param {() => Promise<any>} [options.probe]
	 * @param {() => Promise<any>} [options.downloadBundledBubblewrap]
	 * @param {() => Promise<void>} [options.disableSandbox]
	 * @param {number} [options.pollIntervalMs]
	 * @param {() => void} [options.requestRender]
	 */
	constructor(options) {
		super()
		this.issue = options.issue
		this.latestProbe = options.issue.probe
		this.probe = options.probe ?? (() => probeNativeSandbox({ platform: this.issue.target.platform }))
		this.downloadBundledBubblewrap = options.downloadBundledBubblewrap ?? (() => downloadBundledBubblewrapAsset({ platform: this.issue.target.platform }))
		this.disableSandbox = options.disableSandbox ?? (() => disableEnvironmentSandbox(this.issue.target.environmentId))
		this.pollIntervalMs = options.pollIntervalMs ?? nativeSandboxOnboardingPollMs
		this.requestRender = options.requestRender ?? (() => {})
		this.status = `Waiting; checking again every ${pollSeconds(this.pollIntervalMs)}s.`
		this.saving = false
		this.downloading = false
		this.polling = false
		this.resolved = false
		this.timer = undefined
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve
		})
	}

	start() {
		if (this.timer) return this.done
		this.timer = setInterval(() => {
			void this.pollOnce()
		}, this.pollIntervalMs)
		this.timer.unref?.()
		return this.done
	}

	dispose() {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	/** @param {string} status */
	setStatus(status) {
		this.status = status
		this.markDirty()
		this.requestRender()
	}

	/** @param {{ action: "sandbox-ready" | "sandbox-disabled" }} result */
	finish(result) {
		if (this.resolved) return
		this.resolved = true
		this.dispose()
		this.resolveDone(result)
	}

	async pollOnce() {
		if (this.resolved || this.saving || this.downloading || this.polling) return
		this.polling = true
		this.setStatus("Checking native sandbox...")
		try {
			const result = await this.probe()
			if (this.resolved) return
			if (result.ok) {
				this.setStatus("Native sandbox is available. Continuing...")
				this.finish({ action: "sandbox-ready" })
				return
			}
			this.latestProbe = result
			this.setStatus(`Still unavailable; checking again every ${pollSeconds(this.pollIntervalMs)}s.`)
		} catch (err) {
			this.latestProbe = { ...this.latestProbe, detail: err?.message ?? String(err) }
			this.setStatus(`Probe error; checking again every ${pollSeconds(this.pollIntervalMs)}s.`)
		} finally {
			this.polling = false
		}
	}

	async downloadBundledBubblewrapAndRetry() {
		if (this.resolved || this.saving || this.downloading) return
		if (!canDownloadBundledBubblewrapFromProbe(this.latestProbe)) {
			this.setStatus("No bundled Bubblewrap download is available for this sandbox failure.")
			return
		}
		this.downloading = true
		this.setStatus("Downloading bundled Bubblewrap...")
		try {
			const download = await this.downloadBundledBubblewrap()
			if (this.resolved) return
			this.setStatus(download?.reused ? "Bundled Bubblewrap is already cached. Checking sandbox..." : "Bundled Bubblewrap downloaded. Checking sandbox...")
			const result = await this.probe()
			if (this.resolved) return
			this.latestProbe = result
			if (result.ok) {
				this.setStatus("Native sandbox is available. Continuing...")
				this.finish({ action: "sandbox-ready" })
				return
			}
			this.setStatus(`Downloaded Bubblewrap, but the sandbox is still unavailable; checking again every ${pollSeconds(this.pollIntervalMs)}s.`)
		} catch (err) {
			if (!this.resolved) this.setStatus(`Could not download bundled Bubblewrap: ${err?.message ?? err}`)
		} finally {
			this.downloading = false
		}
	}

	async continueWithoutSandbox() {
		if (this.resolved || this.saving || this.downloading) return
		this.saving = true
		this.setStatus("Saving unsandboxed environment...")
		try {
			await this.disableSandbox()
			if (this.resolved) return
			this.setStatus("Saved unsandboxed environment. Continuing...")
			this.finish({ action: "sandbox-disabled" })
		} catch (err) {
			this.saving = false
			this.setStatus(`Could not save unsandboxed environment: ${err?.message ?? err}`)
		}
	}

	/** @param {string} data */
	handleInput(data) {
		if (isKeyRelease(data)) return
		if (this.issue.target.platform === "linux" && (matchesKey(data, "d") || data === "D")) {
			void this.downloadBundledBubblewrapAndRetry()
			return
		}
		if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
			void this.continueWithoutSandbox()
		}
	}

	/** @param {number} width */
	render(width) {
		const contentWidth = Math.max(24, Math.min(76, width - 4))
		const margin = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)))
		const line = (text = "") => margin + fit(text, contentWidth)
		const wrap = (text) => wrapTextWithAnsi(text, contentWidth).map(line)
		const platform = this.issue.target.platform
		const probeDetail = singleLine(this.latestProbe?.detail)
		const command = singleLine(this.latestProbe?.command)
		const downloadInfo = this.latestProbe?.downloadableBundledBubblewrap
		const lines = [
			line(),
			line(),
			line(theme.bold(titleForPlatform(platform))),
			line(),
			...bodyForPlatform(platform, this.latestProbe).flatMap((paragraph) => [...wrap(paragraph), line()]),
			line(theme.dim(`Environment: ${this.issue.target.environmentId}`)),
			...(command ? [line(theme.dim(`Probe command: ${command}`))] : []),
			...(downloadInfo ? [
				line(theme.dim(`Bundled asset: ${downloadInfo.assetName}`)),
				line(theme.dim(`Pinano release: ${downloadInfo.releaseTag}`)),
				line(theme.dim(`Source: OpenAI Codex ${downloadInfo.sourceReleaseTag}`)),
			] : []),
			...(probeDetail ? [line(), ...wrap(theme.fg("warning", `Last probe: ${probeDetail}`))] : []),
			line(),
			...(downloadInfo ? [
				...wrap(`Press ${theme.cyan("D")} to download bundled Bubblewrap and retry native sandboxing.`),
				line(),
			] : []),
			...wrap(`Press ${theme.cyan("Enter")} or ${theme.cyan("Esc")} to continue without native sandboxing. Pinano will save sandbox.type "none" for this environment.`),
			line(`${theme.cyan("Ctrl+C")} exit`),
			line(),
			...wrap(theme.dim(this.status)),
		]
		return lines
	}
}
