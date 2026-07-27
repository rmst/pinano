import {
	RetainedComponent,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../tui/index.js"
import { defaultNativeSandboxEnvironment, disableEnvironmentSandbox, loadEnvironmentRegistry } from "../../../server/src/app/environment/registry.js"
import { theme } from "./theme.js"
import { probeNativeSandbox } from "../../../server/src/app/workers/launchers.js"
import { bestEffortAutoInstallBundledBubblewrap } from "../../../server/src/app/sandbox/bwrap/bundled.js"

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
			"Cerex uses bubblewrap (bwrap) for Linux native tool sandboxing. The default local environment is configured for native sandboxing, but the sandbox probe failed.",
		]
		if (canDownloadBundledBubblewrapFromProbe(probe)) {
			return [
				...base,
				"System bwrap was not found. Cerex normally prepares a verified bundled Bubblewrap binary automatically. Install bubblewrap or check network access, and keep this page open; Cerex checks again automatically.",
			]
		}
		return [
			...base,
			"Install bubblewrap, or enable unprivileged user namespaces if your distro requires it, and keep this page open; Cerex checks again automatically.",
		]
	}
	if (platform === "darwin") {
		return [
			"Cerex uses sandbox-exec for macOS native tool sandboxing. The default local environment is configured for native sandboxing, but the sandbox probe failed.",
			"This can happen when Cerex itself is already running inside sandbox-exec, because sandbox-exec does not nest. Keep this page open to retry automatically.",
		]
	}
	return [
		"Cerex could not start the configured native tool sandbox.",
		"Keep this page open to retry automatically.",
	]
}

/**
 * @param {{ platform?: string, registry?: ReturnType<typeof loadEnvironmentRegistry>, probe?: (options: { platform: string }) => Promise<any>, autoInstallBundledBubblewrap?: () => Promise<any> }} [options]
 */
export async function nativeSandboxStartupIssue(options = {}) {
	const platform = options.platform ?? process.platform
	const registry = options.registry ?? loadEnvironmentRegistry()
	const target = defaultNativeSandboxEnvironment(registry, platform)
	if (!target) return undefined
	const autoInstall = options.autoInstallBundledBubblewrap ?? (() => bestEffortAutoInstallBundledBubblewrap({ platform: target.platform }))
	await autoInstall().catch(() => {})
	const probe = options.probe ?? probeNativeSandbox
	const result = await probe({ platform: target.platform })
	return result.ok ? undefined : { target, probe: result }
}

export class NativeSandboxStartupPage extends RetainedComponent {
	/**
	 * @param {object} options
	 * @param {{ target: { environmentId: string, platform: string }, probe: any }} options.issue
	 * @param {() => Promise<any>} [options.probe]
	 * @param {() => Promise<void>} [options.disableSandbox]
	 * @param {number} [options.pollIntervalMs]
	 * @param {() => void} [options.requestRender]
	 */
	constructor(options) {
		super()
		this.issue = options.issue
		this.latestProbe = options.issue.probe
		this.probe = options.probe ?? (() => probeNativeSandbox({ platform: this.issue.target.platform }))
		this.disableSandbox = options.disableSandbox ?? (() => disableEnvironmentSandbox(this.issue.target.environmentId))
		this.pollIntervalMs = options.pollIntervalMs ?? nativeSandboxOnboardingPollMs
		this.requestRender = options.requestRender ?? (() => {})
		this.status = `Waiting; checking again every ${pollSeconds(this.pollIntervalMs)}s.`
		this.saving = false
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
		if (this.resolved || this.saving || this.polling) return
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

	async continueWithoutSandbox() {
		if (this.resolved || this.saving) return
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
		const lines = [
			line(),
			line(),
			line(theme.bold(titleForPlatform(platform))),
			line(),
			...bodyForPlatform(platform, this.latestProbe).flatMap((paragraph) => [...wrap(paragraph), line()]),
			line(theme.dim(`Environment: ${this.issue.target.environmentId}`)),
			...(command ? [line(theme.dim(`Probe command: ${command}`))] : []),
			...(probeDetail ? [line(), ...wrap(theme.fg("warning", `Last probe: ${probeDetail}`))] : []),
			line(),
			...wrap(`Press ${theme.cyan("Enter")} or ${theme.cyan("Esc")} to continue without native sandboxing. Cerex will save sandbox.type "none" for this environment.`),
			line(`${theme.cyan("Ctrl+C")} exit`),
			line(),
			...wrap(theme.dim(this.status)),
		]
		return lines
	}
}
