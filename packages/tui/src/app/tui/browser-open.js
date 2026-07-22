import { spawn } from "node:child_process"

import { hyperlink } from "../../tui/index.js"
import { theme } from "../theme.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"

export function openUrlInBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open"
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
	return new Promise((resolve) => {
		let settled = false
		const settle = (opened) => {
			if (settled) return
			settled = true
			resolve(opened)
		}
		try {
			const child = spawn(command, args, { stdio: "ignore", detached: true })
			child.once("error", () => settle(false))
			child.unref?.()
			const timer = setTimeout(() => settle(true), 50)
			timer.unref?.()
		} catch {
			settle(false)
		}
	})
}

export function webOpenNotice(url) {
	return hyperlink(theme.cyan(`Opened ${WEB_BROWSER_UI_NAME}`), url)
}
