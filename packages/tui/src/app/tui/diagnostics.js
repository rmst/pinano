/**
 * Format renderer diagnostics for the client-local `/debug-log`. Diagnostics are intentionally concise: a bounded offending-row preview is enough to identify the component without persisting the full conversation transcript.
 * @param {any} diagnostic
 * @returns {string}
 */
export function formatTuiDiagnostic(diagnostic) {
	if (diagnostic?.type === "render_contract_violation") {
		const location = diagnostic.componentLine === undefined
			? `rendered row ${diagnostic.lineIndex + 1}`
			: `${diagnostic.componentName} row ${diagnostic.componentLine + 1}`
		const problem = diagnostic.reason === "line_break"
			? "contained a raw line break"
			: `was ${diagnostic.lineWidth} columns wide for terminal width ${diagnostic.terminalWidth}`
		return `[TUI] Contained render contract violation: ${location} ${problem}; preview=${JSON.stringify(diagnostic.preview)}`
	}
	if (diagnostic?.type === "full_redraw") {
		return `[TUI] Full redraw: ${diagnostic.reason} (previous=${diagnostic.previousLineCount}, next=${diagnostic.nextLineCount}, terminal=${diagnostic.terminalWidth}x${diagnostic.terminalHeight})`
	}
	return `[TUI] ${JSON.stringify(diagnostic)}`
}

/**
 * Keep product-specific environment and diagnostic policy at the app boundary rather than coupling the reusable TUI framework to Cerex or filesystem locations.
 * @param {import("../../../../server/src/app/stderr-capture.js").StderrCapture | undefined} stderrCapture
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ terminal: { writeLogPath: string }, tui: { showHardwareCursor: boolean, clearOnShrink: boolean, debugRedraw: boolean, onDiagnostic: (diagnostic: any) => void } }}
 */
export function tuiRuntimeOptions(stderrCapture, env = process.env) {
	return {
		terminal: {
			writeLogPath: env.CEREX_TUI_WRITE_LOG ?? "",
		},
		tui: {
			showHardwareCursor: env.CEREX_TUI_HARDWARE_CURSOR === "1",
			clearOnShrink: env.CEREX_TUI_CLEAR_ON_SHRINK === "1",
			debugRedraw: env.CEREX_TUI_DEBUG_REDRAW === "1",
			onDiagnostic: (diagnostic) => stderrCapture?.record(formatTuiDiagnostic(diagnostic)),
		},
	}
}
