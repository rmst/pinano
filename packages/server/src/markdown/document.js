import { basename } from "node:path"

import { Parser, Renderer } from "../vendor/marked/marked.js"
import { parseMarkdown } from "./parser.js"

const escapeHtml = (value) => String(value ?? "")
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")

const slug = (value) => String(value ?? "").toLowerCase().trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")

class DocumentMarkdownRenderer extends Renderer {
	heading(token) {
		const text = this.parser.parseInline(token.tokens, this.parser.textRenderer)
		const id = slug(text)
		return `<h${token.depth}${id ? ` id="${escapeHtml(id)}"` : ""}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`
	}

	blockquote(token) {
		const alert = token.alert?.toLowerCase()
		const header = alert ? `<header>${escapeHtml(token.alert)}</header>\n` : ""
		return `<blockquote${alert ? ` class="markdown-alert-${escapeHtml(alert)}"` : ""}>\n${header}${this.parser.parse(token.tokens)}</blockquote>\n`
	}
}

function renderMarkdownBody(parsed) {
	const footnotePrefix = "cerex-markdown"
	const renderers = {
		frontmatter: () => "",
		footnote: () => "",
		footnote_ref(token) {
			return token.index
				? `<a href="#${footnotePrefix}-fn-${token.index}" id="${footnotePrefix}-fnref-${token.reference}"><sup>${token.index}</sup></a>`
				: escapeHtml(token.raw)
		},
		math: (token) => `<code class="markdown-math${token.display ? " markdown-math-display" : ""}">${escapeHtml(token.latex)}</code>`,
		math_source: (token) => escapeHtml(token.raw || token.text),
	}
	const options = { renderer: new DocumentMarkdownRenderer(), extensions: { renderers } }
	const body = Parser.parse(parsed.tokens, options)
	if (!parsed.footnotes.length) return body
	const items = parsed.footnotes.map((footnote) => {
		const backlinks = footnote.references.map((reference) => `<a aria-label="Back to reference" href="#${footnotePrefix}-fnref-${reference}">↩</a>`).join(" ")
		return `<li id="${footnotePrefix}-fn-${footnote.index}">${Parser.parse(footnote.tokens || [], options)}${backlinks}</li>`
	}).join("\n")
	return `${body}<footer class="markdown-footnotes"><ol>${items}</ol></footer>`
}

const MARKDOWN_STYLE = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.55; }
body { margin: 0; color: light-dark(#24292f, #e6edf3); background: light-dark(#fff, #0d1117); }
main { box-sizing: border-box; max-width: 860px; margin: 0 auto; padding: 48px 32px 80px; }
img, video { max-width: 100%; }
pre { overflow: auto; padding: 16px; border-radius: 6px; background: light-dark(#f6f8fa, #161b22); }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
:not(pre) > code { padding: .15em .35em; border-radius: 4px; background: light-dark(#eff1f3, #20262d); }
blockquote { margin-inline: 0; padding: .1em 1em; border-left: 4px solid #8c959f; color: light-dark(#57606a, #8c959f); }
blockquote > header { margin-block: .75em; font-weight: 600; }
table { border-collapse: collapse; }
th, td { padding: 6px 13px; border: 1px solid light-dark(#d0d7de, #30363d); }
a { color: light-dark(#0969da, #58a6ff); }
.markdown-math-display { display: block; overflow-x: auto; padding: 1em; text-align: center; }
@media (max-width: 600px) { main { padding: 24px 18px 48px; } }
`.trim()

export function renderMarkdownDocument(source, filePath = "document.md") {
	const parsed = parseMarkdown(source, { frontmatter: true })
	const heading = parsed.tokens.find((token) => token.type === "heading")
	const title = heading?.text?.trim() || basename(filePath, ".md") || "Document"
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${MARKDOWN_STYLE}</style>
</head>
<body><main>${renderMarkdownBody(parsed)}</main></body>
</html>`
}
