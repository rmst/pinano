/** @typedef {"kitty" | "iterm2" | null} ImageProtocol */
/** @typedef {"vscode"} LocalFileHyperlinkOpener */

/**
 * @typedef {object} TerminalCapabilities
 * @property {ImageProtocol} images
 * @property {boolean} trueColor
 * @property {boolean} hyperlinks
 * @property {LocalFileHyperlinkOpener | null} [localFileHyperlinkOpener]
 */

/**
 * @typedef {object} CellDimensions
 * @property {number} widthPx
 * @property {number} heightPx
 */

/**
 * @typedef {object} ImageDimensions
 * @property {number} widthPx
 * @property {number} heightPx
 */

/**
 * @typedef {object} ImageRenderOptions
 * @property {number} [maxWidthCells]
 * @property {number} [maxHeightCells]
 * @property {boolean} [preserveAspectRatio]
 * @property {number} [imageId] Kitty image ID. If provided, reuses/replaces existing image with this ID.
 * @property {boolean} [moveCursor] Whether Kitty should apply its default cursor movement after placement.
 */

/** @type {TerminalCapabilities | null} */
let cachedCapabilities = null;

// Default cell dimensions - updated by TUI when terminal responds to query
/** @type {CellDimensions} */
let cellDimensions = { widthPx: 9, heightPx: 18 };

/** @returns {CellDimensions} */
export function getCellDimensions() {
	return cellDimensions;
}

/**
 * @param {CellDimensions} dims
 * @returns {void}
 */
export function setCellDimensions(dims) {
	cellDimensions = dims;
}

/** @returns {TerminalCapabilities} */
export function detectCapabilities() {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";

	// tmux and screen swallow OSC 8 by default (passthrough is opt-in and wraps
	// sequences differently). Force hyperlinks off whenever we detect them, even
	// when the outer terminal would otherwise support OSC 8. Image protocols are
	// also unreliable under tmux/screen, so leave `images: null` for safety.
	const inTmuxOrScreen = !!process.env.TMUX || term.startsWith("tmux") || term.startsWith("screen");
	if (inTmuxOrScreen) {
		const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";
		return { images: null, trueColor, hyperlinks: false };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true, localFileHyperlinkOpener: "vscode" };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";
	return { images: null, trueColor, hyperlinks: false };
}

const LOCAL_FILE_LINE_COLUMN_RE = /^(.*):([1-9]\d*):([1-9]\d*)$/;
const LOCAL_FILE_LINE_RE = /^(.*):([1-9]\d*)$/;

/**
 * @param {string} url
 * @returns {{ filePath: string, line: string | null, column: string | null } | null}
 */
function parseAbsoluteLocalFileHref(url) {
	if (!url.startsWith("/")) return null;
	const lineColumn = LOCAL_FILE_LINE_COLUMN_RE.exec(url);
	if (lineColumn) return { filePath: lineColumn[1], line: lineColumn[2], column: lineColumn[3] };
	const line = LOCAL_FILE_LINE_RE.exec(url);
	if (line) return { filePath: line[1], line: line[2], column: null };
	return { filePath: url, line: null, column: null };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function encodeUriPath(filePath) {
	return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * @param {string} url
 * @returns {string}
 */
export function formatHyperlinkUrl(url) {
	if (getCapabilities().localFileHyperlinkOpener !== "vscode") return url;
	const file = parseAbsoluteLocalFileHref(url);
	if (!file) return url;
	const position = file.line ? `:${file.line}${file.column ? `:${file.column}` : ""}` : "";
	return `vscode://file${encodeUriPath(file.filePath)}${position}`;
}

/** @returns {TerminalCapabilities} */
export function getCapabilities() {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

/** @returns {void} */
export function resetCapabilitiesCache() {
	cachedCapabilities = null;
}

/**
 * Override the cached capabilities. Useful in tests to exercise both code paths.
 * @param {TerminalCapabilities} caps
 * @returns {void}
 */
export function setCapabilities(caps) {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
const BASE64_REGEX = /^[A-Za-z0-9+/=]*$/;
const CSI_CURSOR_UP_REGEX = /^\x1b\[[1-9]\d*A/;
const CSI_CURSOR_DOWN_REGEX = /^\x1b\[[1-9]\d*B/;

/**
 * @param {string} param
 * @returns {boolean}
 */
function isSafeKittyParam(param) {
	return param === "a=T" ||
		param === "f=100" ||
		param === "q=2" ||
		param === "C=1" ||
		param === "m=0" ||
		param === "m=1" ||
		/^[cri]=[1-9]\d*$/.test(param);
}

/**
 * @param {string} sequence
 * @returns {"initial" | "continuation" | null}
 */
function safeKittyImageSequenceKind(sequence) {
	if (!sequence.startsWith(KITTY_PREFIX) || !sequence.endsWith("\x1b\\")) return null;
	const body = sequence.slice(KITTY_PREFIX.length, -2);
	const separator = body.indexOf(";");
	if (separator === -1) return null;
	const params = body.slice(0, separator).split(",");
	const data = body.slice(separator + 1);
	if (params.length === 0 || data.length === 0 || !BASE64_REGEX.test(data)) return null;
	if (!params.every(isSafeKittyParam)) return null;

	const isContinuation = params.length === 1 && (params[0] === "m=0" || params[0] === "m=1");
	if (isContinuation) return "continuation";
	return params.includes("a=T") && params.includes("f=100") && params.includes("q=2") ? "initial" : null;
}

/**
 * @param {string} param
 * @returns {boolean}
 */
function isSafeITerm2Param(param) {
	return param === "inline=0" ||
		param === "inline=1" ||
		param === "height=auto" ||
		param === "preserveAspectRatio=0" ||
		/^width=[1-9]\d*$/.test(param) ||
		/^height=[1-9]\d*$/.test(param) ||
		/^name=[A-Za-z0-9+/=]+$/.test(param);
}

/**
 * @param {string} sequence
 * @returns {boolean}
 */
function isSafeITerm2ImageSequence(sequence) {
	if (!sequence.startsWith(ITERM2_PREFIX) || !sequence.endsWith("\x07")) return false;
	const body = sequence.slice(ITERM2_PREFIX.length, -1);
	const separator = body.indexOf(":");
	if (separator === -1) return false;
	const params = body.slice(0, separator).split(";");
	const data = body.slice(separator + 1);
	return params.length > 0 && params.every(isSafeITerm2Param) && data.length > 0 && BASE64_REGEX.test(data);
}

/**
 * @param {string} line
 * @param {number} pos
 * @returns {number | null}
 */
function consumeCursorMove(line, pos, regex) {
	const match = line.slice(pos).match(regex);
	return match ? pos + match[0].length : null;
}

/**
 * @param {string} line
 * @param {number} pos
 * @returns {{ next: number, initial: boolean } | null}
 */
function consumeSafeKittyImageSequence(line, pos) {
	if (!line.startsWith(KITTY_PREFIX, pos)) return null;
	const end = line.indexOf("\x1b\\", pos + KITTY_PREFIX.length);
	if (end === -1) return null;
	const next = end + 2;
	const sequence = line.slice(pos, next);
	const kind = safeKittyImageSequenceKind(sequence);
	return kind === null ? null : { next, initial: kind === "initial" };
}

/**
 * @param {string} line
 * @param {number} pos
 * @returns {number | null}
 */
function consumeSafeITerm2ImageSequence(line, pos) {
	if (!line.startsWith(ITERM2_PREFIX, pos)) return null;
	const end = line.indexOf("\x07", pos + ITERM2_PREFIX.length);
	if (end === -1) return null;
	const next = end + 1;
	const sequence = line.slice(pos, next);
	return isSafeITerm2ImageSequence(sequence) ? next : null;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isImageLine(line) {
	let pos = consumeCursorMove(line, 0, CSI_CURSOR_UP_REGEX) ?? 0;
	/** @type {"kitty" | "iterm2" | null} */
	let protocol = null;
	let hasImage = false;
	let hasKittyInitialImage = false;

	while (pos < line.length) {
		const kitty = consumeSafeKittyImageSequence(line, pos);
		if (kitty) {
			if (protocol === "iterm2") return false;
			if (!hasKittyInitialImage && !kitty.initial) return false;
			protocol = "kitty";
			hasImage = true;
			hasKittyInitialImage ||= kitty.initial;
			pos = kitty.next;
			continue;
		}

		const next = consumeSafeITerm2ImageSequence(line, pos);
		if (next === null) break;
		if (protocol !== null) return false;
		protocol = "iterm2";
		hasImage = true;
		pos = next;
	}

	if (!hasImage) return false;
	pos = consumeCursorMove(line, pos, CSI_CURSOR_DOWN_REGEX) ?? pos;
	return pos === line.length;
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 * @returns {number}
 */
export function allocateImageId() {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/**
 * @param {string} base64Data
 * @param {{
 *   columns?: number;
 *   rows?: number;
 *   imageId?: number;
 *   moveCursor?: boolean;
 * }} [options]
 * @returns {string}
 */
export function encodeKitty(base64Data, options = {}) {
	const CHUNK_SIZE = 4096;

	/** @type {string[]} */
	const params = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	/** @type {string[]} */
	const chunks = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 * @param {number} imageId
 * @returns {string}
 */
export function deleteKittyImage(imageId) {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 * @returns {string}
 */
export function deleteAllKittyImages() {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/**
 * @param {string} base64Data
 * @param {{
 *   width?: number | string;
 *   height?: number | string;
 *   name?: string;
 *   preserveAspectRatio?: boolean;
 *   inline?: boolean;
 * }} [options]
 * @returns {string}
 */
export function encodeITerm2(base64Data, options = {}) {
	/** @type {string[]} */
	const params = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

/**
 * @param {ImageDimensions} imageDimensions
 * @param {number} targetWidthCells
 * @param {CellDimensions} [cellDimensions]
 * @returns {number}
 */
export function calculateImageRows(imageDimensions, targetWidthCells, cellDimensions = { widthPx: 9, heightPx: 18 }) {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

/**
 * @param {string} base64Data
 * @returns {ImageDimensions | null}
 */
export function getPngDimensions(base64Data) {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/**
 * @param {string} base64Data
 * @returns {ImageDimensions | null}
 */
export function getJpegDimensions(base64Data) {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * @param {string} base64Data
 * @returns {ImageDimensions | null}
 */
export function getGifDimensions(base64Data) {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/**
 * @param {string} base64Data
 * @returns {ImageDimensions | null}
 */
export function getWebpDimensions(base64Data) {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * @param {string} base64Data
 * @param {string} mimeType
 * @returns {ImageDimensions | null}
 */
export function getImageDimensions(base64Data, mimeType) {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

/**
 * @param {string} base64Data
 * @param {ImageDimensions} imageDimensions
 * @param {ImageRenderOptions} [options]
 * @returns {{ sequence: string; rows: number; imageId?: number } | null}
 */
export function renderImage(base64Data, imageDimensions, options = {}) {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const rows = calculateImageRows(imageDimensions, maxWidth, getCellDimensions());

	if (caps.images === "kitty") {
		const sequence = encodeKitty(base64Data, {
			columns: maxWidth,
			rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: maxWidth,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param {string} text - The visible text to display
 * @param {string} url - The URL to link to
 * @returns {string}
 */
export function hyperlink(text, url) {
	return `\x1b]8;;${formatHyperlinkUrl(url)}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * @param {string} mimeType
 * @param {ImageDimensions} [dimensions]
 * @param {string} [filename]
 * @returns {string}
 */
export function imageFallback(mimeType, dimensions, filename) {
	/** @type {string[]} */
	const parts = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
