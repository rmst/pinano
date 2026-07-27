// Magic-byte detection for the four image formats supported as inline image
// content by OpenAI Chat Completions. Returns a MIME string or null. We don't
// use a third-party file-type library here so the core stays dependency-free
// and runs on qn (which has no npm install path).

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * @param {Buffer} buf
 * @returns {string | null}
 */
export function detectImageMime(buf) {
	if (buf.length < 12) return null
	if (PNG_MAGIC.every((b, i) => buf[i] === b)) return "image/png"
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
	if (
		buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
		(buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
	) return "image/gif"
	// "RIFF" .... "WEBP"
	if (
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
	) return "image/webp"
	return null
}
