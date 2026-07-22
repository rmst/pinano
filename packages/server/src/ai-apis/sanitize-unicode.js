// Strip unpaired UTF-16 surrogates. They cause JSON serialization failures
// in many provider HTTP clients. Properly paired surrogates (e.g. emoji
// outside the BMP) are preserved.
export function sanitizeSurrogates(text) {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}
