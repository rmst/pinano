import { createHmac, timingSafeEqual } from "node:crypto"

const PREVIEW_ACCESS_TOKEN_CONTEXT = "cerex-preview-access-v1"
const PREVIEW_ACCESS_TOKEN_PREFIX = "cerex-preview-v1."

function timingSafeStringEqual(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false
	const leftBuffer = Buffer.from(left, "utf-8")
	const rightBuffer = Buffer.from(right, "utf-8")
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

/** Derive a preview-only bearer capability without exposing the service-control credential to tool workers. */
export function previewAccessTokenForServiceToken(serviceToken) {
	if (typeof serviceToken !== "string" || !serviceToken) return ""
	const digest = Buffer.from(createHmac("sha256", serviceToken)
		.update(PREVIEW_ACCESS_TOKEN_CONTEXT)
		.digest())
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")
	return `${PREVIEW_ACCESS_TOKEN_PREFIX}${digest}`
}

export function previewAccessTokenMatches(candidate, serviceToken) {
	const expected = previewAccessTokenForServiceToken(serviceToken)
	return Boolean(expected) && timingSafeStringEqual(candidate, expected)
}

/** Preview routes retain service-token access for trusted clients while tool workers receive only the derived capability. */
export function previewRequestTokenMatches(candidate, serviceToken) {
	return Boolean(serviceToken) && (timingSafeStringEqual(candidate, serviceToken) || previewAccessTokenMatches(candidate, serviceToken))
}
