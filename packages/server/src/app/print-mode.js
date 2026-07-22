// Print mode (single-shot, non-interactive).
//
// Used for the hidden `pinano session print "do this"` helper. Sends one or more prompts to the
// agent, then exits. Two output modes:
//
//   text  default. Streams nothing; on completion, writes the final assistant
//         message's text content to stdout. Exit 1 on agent error/abort.
//   json  writes one JSON line per agent event to stdout. Useful for piping
//         into other tooling.
//
// Trimmed port of pi-mono's modes/print-mode.ts (~158 LOC) — pinano lacks the
// extension/hook surface and `runtimeHost.dispose()` machinery, so the loop
// reduces to "subscribe → prompt → emit → unsubscribe".

/** @typedef {import("../agent-core/agent.js").Agent} Agent */

/**
 * @typedef {object} PrintModeOptions
 * @property {"text" | "json"} mode
 * @property {string[]} messages All prompts to run in order; first becomes the initial message.
 */

/**
 * @param {Agent} agent
 * @param {PrintModeOptions} options
 * @returns {Promise<number>}
 */
export async function runPrintMode(agent, options) {
	const { mode, messages } = options
	if (messages.length === 0) {
		console.error("print mode: no prompt provided")
		return 1
	}

	const unsubscribe = agent.subscribe(async (event) => {
		if (mode === "json") {
			process.stdout.write(`${JSON.stringify(event)}\n`)
		}
	})

	try {
		for (const msg of messages) {
			await agent.prompt(msg)
		}

		if (mode === "text") {
			const last = /** @type {any} */ (agent.state.messages[agent.state.messages.length - 1])
			if (last?.role === "assistant") {
				if (last.stopReason === "error" || last.stopReason === "aborted") {
					console.error(last.errorMessage || `Request ${last.stopReason}`)
					return 1
				}
				for (const content of last.content ?? []) {
					if (content.type === "text" && content.text) {
						process.stdout.write(`${content.text}\n`)
					}
				}
			}
		}
		return 0
	} catch (/** @type {any} */ error) {
		console.error(error instanceof Error ? error.message : String(error))
		return 1
	} finally {
		unsubscribe()
	}
}
