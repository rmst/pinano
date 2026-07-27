#!/usr/bin/env node

import { bestEffortAutoInstallBundledBubblewrap } from "./bundled.js"
import { updateSetting } from "../../settings.js"

const args = new Set(process.argv.slice(2))
const postinstall = args.has("--postinstall")
const verbose = args.has("--verbose")

function buildFromSourceEnvEnabled() {
	const value = process.env.CEREX_BUILD_FROM_SOURCE
	return value !== undefined && value !== "" && !/^(0|false|no)$/i.test(value)
}

const buildFromSource = buildFromSourceEnvEnabled()
if (buildFromSource) {
	try {
		await updateSetting("buildFromSource", true)
	} catch (err) {
		console.error(`cerex: could not persist buildFromSource setting: ${err?.message ?? err}`)
		process.exit(1)
	}
}

const result = await bestEffortAutoInstallBundledBubblewrap(buildFromSource ? { buildFromSource: true } : {})

if (verbose && !postinstall) {
	console.log(JSON.stringify({ ok: result.ok, skipped: result.skipped, reason: result.reason, path: result.path }, null, "\t"))
}

if (!result.ok && (buildFromSource || !postinstall)) {
	console.error(`cerex: could not prepare bundled Bubblewrap: ${result.message}`)
	process.exit(1)
}
