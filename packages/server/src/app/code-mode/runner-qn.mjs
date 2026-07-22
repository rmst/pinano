import { bootstrapSource, runCodeModeRunner } from "./runner-common.mjs"

const AsyncFunction = async function () {}.constructor

runCodeModeRunner((params, host) => {
	Object.defineProperty(globalThis, "__pinanoCodeModeWake", {
		value: host.wake,
		configurable: true,
	})
	let bridge
	try {
		bridge = (0, eval)(bootstrapSource(params.tools, params.storedValues, params.maxOutputChars))
	} finally {
		delete globalThis.__pinanoCodeModeWake
	}
	const execution = new AsyncFunction(`${params.code}\n//# sourceURL=pinano-code-mode-cell.js`)()
	return { bridge, execution }
})
