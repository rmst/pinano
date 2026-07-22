// Minimal line-level diff. Replaces the npm `diff` package for the edit tool.
// Output is a unified-style diff with line numbers, optimized to be readable
// when echoed back to the LLM as a tool result.
//
// Algorithm: classic LCS via dynamic programming. Suitable for files up to
// a few thousand lines. The edit tool only diffs around the changes, so this
// is rarely the bottleneck.

function lcsTable(a, b) {
	const n = a.length
	const m = b.length
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
			else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
		}
	}
	return dp
}

/**
 * Returns an array of {value, added, removed} parts. Adjacent same-kind lines
 * are joined into a single part. Mirrors the slice of the `diff` package's
 * `diffLines` output that we used in pi-mono's edit tool.
 */
export function diffLines(oldText, newText) {
	const a = oldText.split("\n")
	const b = newText.split("\n")
	const dp = lcsTable(a, b)

	const parts = []
	let i = 0
	let j = 0
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			pushPart(parts, "context", a[i])
			i++
			j++
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			pushPart(parts, "removed", a[i])
			i++
		} else {
			pushPart(parts, "added", b[j])
			j++
		}
	}
	while (i < a.length) {
		pushPart(parts, "removed", a[i])
		i++
	}
	while (j < b.length) {
		pushPart(parts, "added", b[j])
		j++
	}

	return parts.map((p) => ({
		added: p.kind === "added",
		removed: p.kind === "removed",
		value: p.lines.join("\n") + (p.lines.length > 0 ? "\n" : ""),
	}))
}

function pushPart(parts, kind, line) {
	const last = parts[parts.length - 1]
	if (last && last.kind === kind) {
		last.lines.push(line)
		return
	}
	parts.push({ kind, lines: [line] })
}

/**
 * Render a unified-style line-numbered diff with limited context.
 * Used as the `details.diff` payload sent to the model.
 */
export function generateDiffString(oldContent, newContent, contextLines = 4) {
	const parts = diffLines(oldContent, newContent)
	const oldLines = oldContent.split("\n")
	const newLines = newContent.split("\n")
	const maxLineNum = Math.max(oldLines.length, newLines.length)
	const w = String(maxLineNum).length

	const out = []
	let oldNum = 1
	let newNum = 1
	let lastWasChange = false
	let firstChangedLine

	for (let idx = 0; idx < parts.length; idx++) {
		const part = parts[idx]
		const raw = part.value.split("\n")
		if (raw[raw.length - 1] === "") raw.pop()

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newNum
			for (const line of raw) {
				if (part.added) {
					out.push(`+${String(newNum).padStart(w, " ")} ${line}`)
					newNum++
				} else {
					out.push(`-${String(oldNum).padStart(w, " ")} ${line}`)
					oldNum++
				}
			}
			lastWasChange = true
		} else {
			const nextIsChange = idx < parts.length - 1 && (parts[idx + 1].added || parts[idx + 1].removed)
			const hasLeading = lastWasChange
			const hasTrailing = nextIsChange

			if (hasLeading && hasTrailing) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						out.push(` ${String(oldNum).padStart(w, " ")} ${line}`)
						oldNum++
						newNum++
					}
				} else {
					const leading = raw.slice(0, contextLines)
					const trailing = raw.slice(raw.length - contextLines)
					const skipped = raw.length - leading.length - trailing.length
					for (const line of leading) {
						out.push(` ${String(oldNum).padStart(w, " ")} ${line}`)
						oldNum++
						newNum++
					}
					out.push(` ${"".padStart(w, " ")} ...`)
					oldNum += skipped
					newNum += skipped
					for (const line of trailing) {
						out.push(` ${String(oldNum).padStart(w, " ")} ${line}`)
						oldNum++
						newNum++
					}
				}
			} else if (hasLeading) {
				const shown = raw.slice(0, contextLines)
				const skipped = raw.length - shown.length
				for (const line of shown) {
					out.push(` ${String(oldNum).padStart(w, " ")} ${line}`)
					oldNum++
					newNum++
				}
				if (skipped > 0) {
					out.push(` ${"".padStart(w, " ")} ...`)
					oldNum += skipped
					newNum += skipped
				}
			} else if (hasTrailing) {
				const skipped = Math.max(0, raw.length - contextLines)
				if (skipped > 0) {
					out.push(` ${"".padStart(w, " ")} ...`)
					oldNum += skipped
					newNum += skipped
				}
				for (const line of raw.slice(skipped)) {
					out.push(` ${String(oldNum).padStart(w, " ")} ${line}`)
					oldNum++
					newNum++
				}
			} else {
				oldNum += raw.length
				newNum += raw.length
			}
			lastWasChange = false
		}
	}

	return { diff: out.join("\n"), firstChangedLine }
}
