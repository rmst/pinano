export function dedent(strings, ...values) {
	let text = ""
	for (const [index, string] of strings.entries()) {
		text += string
		if (index >= values.length) continue
		const indent = text.match(/(?:^|\n)([\t ]*)$/)?.[1] ?? ""
		text += String(values[index]).replace(/\n/g, `\n${indent}`)
	}
	const lines = text.replace(/\r\n/g, "\n").split("\n")
	if (lines[0]?.trim() === "") lines.shift()
	if (lines.at(-1)?.trim() === "") lines.pop()
	const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.match(/^[\t ]*/)[0].length))
	if (!Number.isFinite(indent) || indent <= 0) return lines.join("\n")
	return lines.map((line) => line.slice(Math.min(indent, line.match(/^[\t ]*/)[0].length))).join("\n")
}
