// Helper invoked with qn so web bundling works no matter which runtime hosts
// Pinano itself. Keep qn-specific imports out of the long-running app process.

import { readFile } from "node:fs/promises"

const optionsPath = process.argv[2]
if (!optionsPath) {
	console.error("web-bundle-helper: missing options path")
	process.exit(2)
}

const { build } = await import("qn:bundle")
const options = JSON.parse(await readFile(optionsPath, "utf8"))
const result = await build(options)
const output = result.outputs?.[0]
if (!output?.path) {
	console.error("web-bundle-helper: bundler did not write an output file")
	process.exit(1)
}
