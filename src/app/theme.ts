// Theme for the chat UI. Vendored down from pi-coding-agent's theme.ts.
//
// Two layers:
//   - Legacy color helpers (`theme.cyan(...)`, `theme.dim(...)`, etc.) still
//     used by ad-hoc app code (footer, slash commands, error messages). These
//     map to the equivalent semantic token where possible.
//   - Token-based palette (`theme.fg("accent", s)`, `theme.bg("userMessageBg", s)`)
//     used by the message components ported from pi.
//
// Hex colors are emitted as truecolor (24-bit) by default; falling back to
// 256-color when the terminal advertises lower fidelity (TERM=screen, dumb,
// linux, Apple Terminal). This matches pi's behaviour exactly so messages
// look identical when running pinano in iTerm2, kitty, etc.

const ESC = "\x1b["

type ColorMode = "truecolor" | "256color"

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor"
	if (process.env.WT_SESSION) return "truecolor"
	const term = process.env.TERM ?? ""
	if (term === "dumb" || term === "" || term === "linux") return "256color"
	if (process.env.TERM_PROGRAM === "Apple_Terminal") return "256color"
	if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) return "256color"
	return "truecolor"
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "")
	if (cleaned.length !== 6) throw new Error(`Invalid hex color: ${hex}`)
	const r = parseInt(cleaned.slice(0, 2), 16)
	const g = parseInt(cleaned.slice(2, 4), 16)
	const b = parseInt(cleaned.slice(4, 6), 16)
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) throw new Error(`Invalid hex color: ${hex}`)
	return { r, g, b }
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255]
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10)

function closestIndex(arr: number[], v: number): number {
	let best = 0
	let bestDist = Infinity
	for (let i = 0; i < arr.length; i++) {
		const d = Math.abs(arr[i] - v)
		if (d < bestDist) {
			bestDist = d
			best = i
		}
	}
	return best
}

function rgbTo256(r: number, g: number, b: number): number {
	const ri = closestIndex(CUBE_VALUES, r)
	const gi = closestIndex(CUBE_VALUES, g)
	const bi = closestIndex(CUBE_VALUES, b)
	const cubeIdx = 16 + 36 * ri + 6 * gi + bi
	const cubeR = CUBE_VALUES[ri]
	const cubeG = CUBE_VALUES[gi]
	const cubeB = CUBE_VALUES[bi]
	const cubeDist =
		(r - cubeR) * (r - cubeR) * 0.299 +
		(g - cubeG) * (g - cubeG) * 0.587 +
		(b - cubeB) * (b - cubeB) * 0.114

	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
	const grayI = closestIndex(GRAY_VALUES, gray)
	const grayV = GRAY_VALUES[grayI]
	const grayDist =
		(r - grayV) * (r - grayV) * 0.299 +
		(g - grayV) * (g - grayV) * 0.587 +
		(b - grayV) * (b - grayV) * 0.114
	const spread = Math.max(r, g, b) - Math.min(r, g, b)
	if (spread < 10 && grayDist < cubeDist) return 232 + grayI
	return cubeIdx
}

function fgAnsi(value: string | number, mode: ColorMode): string {
	if (value === "") return `${ESC}39m`
	if (typeof value === "number") return `${ESC}38;5;${value}m`
	if (value.startsWith("#")) {
		const { r, g, b } = hexToRgb(value)
		if (mode === "truecolor") return `${ESC}38;2;${r};${g};${b}m`
		return `${ESC}38;5;${rgbTo256(r, g, b)}m`
	}
	throw new Error(`Invalid color: ${value}`)
}

function bgAnsi(value: string | number, mode: ColorMode): string {
	if (value === "") return `${ESC}49m`
	if (typeof value === "number") return `${ESC}48;5;${value}m`
	if (value.startsWith("#")) {
		const { r, g, b } = hexToRgb(value)
		if (mode === "truecolor") return `${ESC}48;2;${r};${g};${b}m`
		return `${ESC}48;5;${rgbTo256(r, g, b)}m`
	}
	throw new Error(`Invalid color: ${value}`)
}

// Foreground tokens — picked from pi's dark.json. We dropped tokens we don't
// use (markdown colors, syntax highlighting, thinking-level borders, bash mode)
// to keep the surface small. Add back as needed.
const FG: Record<string, string | number> = {
	accent: "#8abeb7",
	border: "#5f87ff",
	borderMuted: "#505050",
	success: "#b5bd68",
	error: "#cc6666",
	warning: "#ffff00",
	muted: "#808080",
	dim: "#666666",
	text: "",
	thinkingText: "#808080",
	userMessageText: "",
	customMessageText: "",
	customMessageLabel: "#9575cd",
	toolTitle: "",
	toolOutput: "#808080",
}

const BG: Record<string, string | number> = {
	selectedBg: "#3a3a4a",
	userMessageBg: "#343541",
	customMessageBg: "#2d2838",
	toolPendingBg: "#282832",
	toolSuccessBg: "#283228",
	toolErrorBg: "#3c2828",
}

export type FgToken = keyof typeof FG
export type BgToken = keyof typeof BG

const mode = detectColorMode()
const fgCache = new Map<string, string>()
const bgCache = new Map<string, string>()
for (const [k, v] of Object.entries(FG)) fgCache.set(k, fgAnsi(v, mode))
for (const [k, v] of Object.entries(BG)) bgCache.set(k, bgAnsi(v, mode))

function fg(token: FgToken | string, text: string): string {
	const ansi = fgCache.get(token as string)
	if (!ansi) throw new Error(`Unknown fg token: ${token}`)
	// Reset only foreground so this nests safely inside backgrounds.
	return `${ansi}${text}${ESC}39m`
}

function bg(token: BgToken | string, text: string): string {
	const ansi = bgCache.get(token as string)
	if (!ansi) throw new Error(`Unknown bg token: ${token}`)
	return `${ansi}${text}${ESC}49m`
}

const RESET = `${ESC}0m`
function ansiCode(code: number) {
	return (s: string) => `${ESC}${code}m${s}${RESET}`
}
function ansiAttr(open: number, close: number) {
	return (s: string) => `${ESC}${open}m${s}${ESC}${close}m`
}

export const theme = {
	// Token-based access (preferred for new code)
	fg,
	bg,
	getFgAnsi: (token: FgToken | string) => {
		const a = fgCache.get(token as string)
		if (!a) throw new Error(`Unknown fg token: ${token}`)
		return a
	},
	getBgAnsi: (token: BgToken | string) => {
		const a = bgCache.get(token as string)
		if (!a) throw new Error(`Unknown bg token: ${token}`)
		return a
	},

	// Attribute helpers (close only the attribute we opened so they nest).
	bold: ansiAttr(1, 22),
	italic: ansiAttr(3, 23),
	underline: ansiAttr(4, 24),
	dim: ansiAttr(2, 22),

	// Legacy named-color helpers — same shape as before so existing call-sites
	// don't break. Map onto the new tokens where the meaning matches.
	red: (s: string) => fg("error", s),
	green: (s: string) => fg("success", s),
	yellow: (s: string) => fg("warning", s),
	blue: (s: string) => fg("border", s),
	magenta: (s: string) => fg("customMessageLabel", s),
	cyan: (s: string) => fg("accent", s),
	gray: (s: string) => fg("muted", s),

	// Solid-background helpers (rarely used; kept for legacy callers).
	bgRed: ansiCode(41),
	bgGreen: ansiCode(42),
	bgYellow: ansiCode(43),
}

export const selectListTheme = {
	selectedPrefix: theme.cyan,
	selectedText: (s: string) => theme.bg("selectedBg", s),
	description: (s: string) => theme.fg("muted", s),
	scrollInfo: (s: string) => theme.fg("muted", s),
	noMatch: (s: string) => theme.fg("muted", s),
}

export const editorTheme = {
	borderColor: (s: string) => theme.fg("borderMuted", s),
	selectList: selectListTheme,
}
