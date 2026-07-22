import vm from "node:vm"

import { bootstrapSource, runCodeModeRunner } from "./runner-common.mjs"

runCodeModeRunner((params) => {
	const context = vm.createContext(Object.create(null), {
		name: "pinano-code-mode",
		codeGeneration: { strings: false, wasm: false },
	})
	const bridge = new vm.Script(bootstrapSource(params.tools, params.storedValues, params.maxOutputChars), {
		filename: "pinano-code-mode-bootstrap.js",
	}).runInContext(context)
	const execution = new vm.Script(`(async () => {\n${params.code}\n})()`, {
		filename: "pinano-code-mode-cell.js",
	}).runInContext(context)
	return { bridge, execution }
})
