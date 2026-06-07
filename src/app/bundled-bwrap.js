import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"

import { dataRoot } from "./paths.js"

export const bundledBubblewrapReleaseTag = "bwrap-codex-rust-v0.137.0"
export const bundledBubblewrapSourceReleaseTag = "rust-v0.137.0"
export const bundledBubblewrapSourceRepository = "https://github.com/openai/codex"
export const bundledBubblewrapReleaseBaseUrl = `https://github.com/rmst/pinano/releases/download/${bundledBubblewrapReleaseTag}`

export const bundledBubblewrapAssets = {
	x64: {
		targetTriple: "x86_64-unknown-linux-musl",
		assetName: "bwrap-x86_64-unknown-linux-musl.tar.gz",
		entryName: "bwrap-x86_64-unknown-linux-musl",
		archiveSha256: "e11a3340906ef23157e0d8bc78389ec9b2f2ff1fb4a41c11754fddb269167476",
		binarySha256: "5a5104807cfbe9b509d0b9fa1c46054ff48dbed5393f30d261b34263ebf0e3fe",
	},
	arm64: {
		targetTriple: "aarch64-unknown-linux-musl",
		assetName: "bwrap-aarch64-unknown-linux-musl.tar.gz",
		entryName: "bwrap-aarch64-unknown-linux-musl",
		archiveSha256: "6c83df31a117226e6cc50783b7bc2efd8805fe30b9e39b14f29cbc467fa8a910",
		binarySha256: "33bc38ff6273a58ef56b0f0748d1a18220a389d53d765c998eb1442ebaa16614",
	},
}

/** @param {{ platform?: string, arch?: string, asset?: any }} [options] */
export function bundledBubblewrapAsset(options = {}) {
	if (options.asset) return withBubblewrapAssetUrls(options.asset)
	const platform = options.platform ?? process.platform
	if (platform !== "linux") return undefined
	return withBubblewrapAssetUrls(bundledBubblewrapAssets[options.arch ?? process.arch])
}

function withBubblewrapAssetUrls(asset) {
	if (!asset) return undefined
	return {
		...asset,
		url: asset.url ?? `${bundledBubblewrapReleaseBaseUrl}/${asset.assetName}`,
		sourceUrl: asset.sourceUrl ?? `${bundledBubblewrapSourceRepository}/releases/download/${bundledBubblewrapSourceReleaseTag}/${asset.assetName}`,
		sourceRepository: asset.sourceRepository ?? bundledBubblewrapSourceRepository,
		sourceReleaseTag: asset.sourceReleaseTag ?? bundledBubblewrapSourceReleaseTag,
		releaseTag: asset.releaseTag ?? bundledBubblewrapReleaseTag,
	}
}

/** @param {Buffer | Uint8Array | string} data */
function sha256(data) {
	return createHash("sha256").update(data).digest("hex")
}

/** @param {{ cacheRoot?: string, asset?: any, platform?: string, arch?: string }} [options] */
export function bundledBubblewrapCacheRoot(options = {}) {
	const asset = bundledBubblewrapAsset(options)
	if (!asset) return undefined
	return options.cacheRoot ?? join(dataRoot(), "tools", "bwrap", "codex", asset.sourceReleaseTag, asset.targetTriple)
}

/** @param {{ cacheRoot?: string, asset?: any, platform?: string, arch?: string }} [options] */
export function bundledBubblewrapPath(options = {}) {
	const root = bundledBubblewrapCacheRoot(options)
	return root ? join(root, "bwrap") : undefined
}

/** @param {{ cacheRoot?: string, asset?: any, platform?: string, arch?: string }} [options] */
export function bundledBubblewrapDownloadInfo(options = {}) {
	const asset = bundledBubblewrapAsset(options)
	const path = bundledBubblewrapPath(options)
	if (!asset || !path) return undefined
	return {
		path,
		url: asset.url,
		assetName: asset.assetName,
		targetTriple: asset.targetTriple,
		archiveSha256: asset.archiveSha256,
		binarySha256: asset.binarySha256,
		sourceUrl: asset.sourceUrl,
		sourceRepository: asset.sourceRepository,
		sourceReleaseTag: asset.sourceReleaseTag,
		releaseTag: asset.releaseTag,
	}
}

/** @param {{ cacheRoot?: string, asset?: any, platform?: string, arch?: string }} [options] */
export async function verifiedCachedBundledBubblewrapPath(options = {}) {
	const asset = bundledBubblewrapAsset(options)
	const path = bundledBubblewrapPath(options)
	if (!asset || !path || !existsSync(path)) return undefined
	try {
		const data = await readFile(path)
		if (sha256(data) !== asset.binarySha256) return undefined
		await chmod(path, 0o755).catch(() => {})
		return path
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

function tarHeaderIsEmpty(header) {
	return header.every((byte) => byte === 0)
}

function tarString(buffer, start, length) {
	const slice = buffer.subarray(start, start + length)
	const nul = slice.indexOf(0)
	return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8")
}

function tarOctal(buffer, start, length) {
	const text = tarString(buffer, start, length).trim()
	if (!text) return 0
	const value = Number.parseInt(text, 8)
	if (!Number.isFinite(value)) throw new Error(`Invalid tar octal field: ${JSON.stringify(text)}`)
	return value
}

function tarEntryName(header) {
	const name = tarString(header, 0, 100)
	const prefix = tarString(header, 345, 155)
	return prefix ? `${prefix}/${name}` : name
}

function extractTarFile(tar, expectedName) {
	let offset = 0
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512)
		if (tarHeaderIsEmpty(header)) break
		const name = tarEntryName(header)
		const size = tarOctal(header, 124, 12)
		const type = tarString(header, 156, 1) || "0"
		const dataStart = offset + 512
		const dataEnd = dataStart + size
		if (dataEnd > tar.length) throw new Error(`Tar entry ${name || "(unnamed)"} exceeds archive size`)
		if (name === expectedName) {
			if (type !== "0") throw new Error(`Tar entry ${expectedName} is not a regular file`)
			return Buffer.from(tar.subarray(dataStart, dataEnd))
		}
		offset = dataStart + Math.ceil(size / 512) * 512
	}
	throw new Error(`Tar archive does not contain ${expectedName}`)
}

function extractTarGzFile(archive, expectedName) {
	let tar
	try {
		tar = gunzipSync(archive)
	} catch (err) {
		throw new Error(`Could not decompress bundled bubblewrap archive: ${err?.message ?? err}`)
	}
	return extractTarFile(tar, expectedName)
}

/** @param {{ ok?: boolean, status?: number, statusText?: string, arrayBuffer?: () => Promise<ArrayBuffer> }} response */
async function responseBuffer(response) {
	if (!response?.ok) throw new Error(`Download failed with HTTP ${response?.status ?? "unknown"}${response?.statusText ? ` ${response.statusText}` : ""}`)
	if (typeof response.arrayBuffer !== "function") throw new Error("Download response did not provide an array buffer")
	return Buffer.from(await response.arrayBuffer())
}

/** @param {{ cacheRoot?: string, asset?: any, platform?: string, arch?: string, fetch?: typeof fetch }} [options] */
export async function downloadBundledBubblewrap(options = {}) {
	const asset = bundledBubblewrapAsset(options)
	const path = bundledBubblewrapPath(options)
	if (!asset || !path) {
		throw new Error(`Pinano does not provide a bundled bubblewrap for ${options.platform ?? process.platform}/${options.arch ?? process.arch}`)
	}
	const existing = await verifiedCachedBundledBubblewrapPath(options)
	if (existing) return { path: existing, asset, reused: true }
	const fetchImpl = options.fetch ?? globalThis.fetch
	if (typeof fetchImpl !== "function") throw new Error("This runtime does not provide fetch; cannot download bundled bubblewrap")
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const response = await fetchImpl(asset.url)
	const archive = await responseBuffer(response)
	const archiveDigest = sha256(archive)
	if (archiveDigest !== asset.archiveSha256) {
		throw new Error(`Bundled bubblewrap archive digest mismatch for ${asset.assetName}: expected ${asset.archiveSha256}, got ${archiveDigest}`)
	}
	const binary = extractTarGzFile(archive, asset.entryName)
	const binaryDigest = sha256(binary)
	if (binaryDigest !== asset.binarySha256) {
		throw new Error(`Bundled bubblewrap binary digest mismatch for ${asset.entryName}: expected ${asset.binarySha256}, got ${binaryDigest}`)
	}
	const tempPath = join(dirname(path), `.bwrap.${process.pid}.${randomUUID()}.tmp`)
	try {
		await writeFile(tempPath, binary, { mode: 0o700 })
		await chmod(tempPath, 0o755)
		await rename(tempPath, path)
		await chmod(path, 0o755).catch(() => {})
		return { path, asset, reused: false }
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => {})
		throw err
	}
}
