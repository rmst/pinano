import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { dataRoot } from "../paths.js"
import { configuredServiceToken } from "./config.js"

const MIN_GENERATED_SERVICE_TOKEN_LENGTH = 16

export function generatedServiceTokenPath() {
	return join(dataRoot(), "service-token")
}

function parseGeneratedServiceToken(text) {
	const token = text.trim()
	return token.length >= MIN_GENERATED_SERVICE_TOKEN_LENGTH ? token : ""
}

async function chmodBestEffort(path, mode) {
	try {
		await chmod(path, mode)
	} catch {}
}

async function readGeneratedServiceToken(path) {
	try {
		const token = parseGeneratedServiceToken(await readFile(path, "utf-8"))
		if (token) await chmodBestEffort(path, 0o600)
		return token
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT") return ""
		throw err
	}
}

async function createGeneratedServiceToken(path) {
	const token = randomUUID()
	await mkdir(dirname(path), { recursive: true })
	try {
		await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" })
		await chmodBestEffort(path, 0o600)
		return token
	} catch (/** @type {any} */ err) {
		if (err?.code !== "EEXIST") throw err
		const existing = await readGeneratedServiceToken(path)
		if (existing) return existing
		throw new Error(`Generated Cerex service token file exists but does not contain a valid token: ${path}`)
	}
}

export async function getOrCreateServiceToken() {
	const configured = configuredServiceToken()
	if (configured) return configured
	const path = generatedServiceTokenPath()
	return await readGeneratedServiceToken(path) || await createGeneratedServiceToken(path)
}
