// Minimal `Intl.Segmenter` polyfill for runtimes that lack `Intl` (qn).
//
// Splits text into approximate grapheme clusters: each base code point starts
// a new cluster, and following combining marks (`\p{Mark}`), variation
// selectors, ZWJ, and U+200D-glued sequences attach to it. Good enough for
// terminal width measurement — the `graphemeWidth` step in utils.ts handles
// emoji/regional-indicator edge cases regardless of how the cluster was
// formed.
//
// No-op on Node and other runtimes that already ship Intl.Segmenter.

const isMark = /\p{Mark}/v
const ZWJ = "\u200d"
const VS16 = "\ufe0f"
const VS15 = "\ufe0e"

function* segmentCodepoints(input) {
	let cluster = ""
	let extending = false
	for (const ch of input) {
		// `for..of` already iterates by code points (handles surrogate pairs).
		if (cluster === "") {
			cluster = ch
			extending = false
			continue
		}
		if (ch === ZWJ) {
			cluster += ch
			extending = true
			continue
		}
		if (extending) {
			cluster += ch
			extending = false
			continue
		}
		if (ch === VS16 || ch === VS15 || isMark.test(ch)) {
			cluster += ch
			continue
		}
		yield cluster
		cluster = ch
	}
	if (cluster !== "") yield cluster
}

class FallbackSegmenter {
	constructor() {}
	segment(input) {
		const text = String(input)
		return {
			[Symbol.iterator]: function* () {
				let index = 0
				for (const segment of segmentCodepoints(text)) {
					yield { segment, index, input: text }
					index += segment.length
				}
			},
		}
	}
}

if (typeof globalThis.Intl === "undefined") {
	globalThis.Intl = {}
}
if (typeof globalThis.Intl.Segmenter === "undefined") {
	globalThis.Intl.Segmenter = FallbackSegmenter
}
