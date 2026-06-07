#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
	bundledBubblewrapAsset,
	bundledBubblewrapAssets,
	bundledBubblewrapReleaseTag,
	bundledBubblewrapSourceReleaseTag,
	bundledBubblewrapSourceRepository,
} from "../src/app/bundled-bwrap.js"

function parseArgs(argv) {
	const options = { outDir: join("dist", "bundled-bwrap", bundledBubblewrapReleaseTag) }
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (arg === "--out") {
			const value = argv[++i]
			if (!value) throw new Error("--out requires a directory")
			options.outDir = value
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}
	return options
}

/** @param {Buffer | Uint8Array | string} data */
function sha256(data) {
	return createHash("sha256").update(data).digest("hex")
}

async function downloadAsset(asset) {
	const response = await fetch(asset.sourceUrl)
	if (!response.ok) throw new Error(`Download failed for ${asset.sourceUrl}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`)
	const body = Buffer.from(await response.arrayBuffer())
	const digest = sha256(body)
	if (digest !== asset.archiveSha256) {
		throw new Error(`${asset.assetName} digest mismatch: expected ${asset.archiveSha256}, got ${digest}`)
	}
	return body
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const outDir = resolve(options.outDir)
	await mkdir(outDir, { recursive: true })
	const lines = []
	const noticeLines = [
		"Pinano bundled Bubblewrap assets",
		"",
		"These release assets are pinned static Bubblewrap binaries staged from the OpenAI Codex release listed below. Pinano does not vendor Bubblewrap source code.",
		"",
		`Codex source release: ${bundledBubblewrapSourceRepository}/releases/tag/${bundledBubblewrapSourceReleaseTag}`,
		"Bubblewrap upstream: https://github.com/containers/bubblewrap",
		"Bubblewrap license: LGPL-2.0-or-later",
		"",
		"Assets:",
	]
	for (const arch of Object.keys(bundledBubblewrapAssets).sort()) {
		const asset = bundledBubblewrapAsset({ platform: "linux", arch })
		const body = await downloadAsset(asset)
		await writeFile(join(outDir, asset.assetName), body)
		lines.push(`${asset.archiveSha256}  ${asset.assetName}`)
		noticeLines.push(`- ${asset.assetName}`)
		noticeLines.push(`  source: ${asset.sourceUrl}`)
		noticeLines.push(`  archive sha256: ${asset.archiveSha256}`)
		noticeLines.push(`  binary sha256: ${asset.binarySha256}`)
		console.log(`staged ${asset.assetName}`)
	}
	await writeFile(join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`)
	await writeFile(join(outDir, "BUBBLEWRAP-NOTICE.txt"), `${noticeLines.join("\n")}\n`)
	console.log(`\nUpload these files to Pinano release ${bundledBubblewrapReleaseTag}:`)
	for (const line of lines) console.log(`  ${line.split("  ")[1]}`)
	console.log("  SHA256SUMS")
	console.log("  BUBBLEWRAP-NOTICE.txt")
}

await main()
