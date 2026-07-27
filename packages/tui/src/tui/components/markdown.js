// Markdown terminal renderer, ported from pi-coding-agent's TUI.
// Uses Cerex's shared Marked token pipeline so terminal and Web surfaces agree on Markdown structure.

import { parseMarkdown } from "../../../../server/src/markdown/parser.js";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.js";
import { RetainedComponent } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { TextSelectionSource } from "../selection-source.js";
import { offsetSourceSpans } from "../render-frame.js";
import { renderSegmentedText } from "./segmented-text.js";
class MarkdownSourceBuilder {
    provider;
    text = "";
    constructor(provider){
        this.provider = provider;
    }
    append(text) {
        this.text += String(text ?? "");
    }
    appendLineBreak() {
        if (!this.text.endsWith("\n")) {
            this.text += "\n";
        }
    }
    appendBlockBreak() {
        if (this.text.endsWith("\n\n")) {
            return;
        }
        this.text += this.text.endsWith("\n") ? "\n" : "\n\n";
    }
    segment(text, style) {
        const value = String(text ?? "");
        const start = this.text.length;
        this.text += value;
        return {
            text: value,
            style,
            sourceProvider: this.provider,
            sourceStart: start,
            sourceEnd: this.text.length
        };
    }
}

function composeStyle(base, next) {
    if (!base) return next;
    if (!next) return base;
    return (text)=>next(base(text));
}

function ignoredSegment(text, style) {
    return { text: String(text ?? ""), style, selectionIgnore: true };
}

function ignoreSourceSpan(line, startCol, endCol, component) {
    const start = Math.max(0, Math.floor(startCol));
    const end = Math.max(start, Math.floor(endCol));
    if (end <= start) return null;
    return { line, startCol: start, endCol: end, ignore: true, component };
}

/**
 * @typedef {object} DefaultTextStyle
 * @property {(text: string) => string} [color]
 * @property {(text: string) => string} [bgColor]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [strikethrough]
 * @property {boolean} [underline]
 */

/**
 * @typedef {object} MarkdownTheme
 * @property {(text: string) => string} heading
 * @property {(text: string) => string} link
 * @property {(text: string) => string} code
 * @property {(text: string) => string} codeBlock
 * @property {(text: string) => string} codeBlockBorder
 * @property {(text: string) => string} quote
 * @property {(text: string) => string} quoteBorder
 * @property {(text: string) => string} hr
 * @property {(text: string) => string} listBullet
 * @property {(text: string) => string} bold
 * @property {(text: string) => string} italic
 * @property {(text: string) => string} strikethrough
 * @property {(text: string) => string} underline
 * @property {(code: string, lang?: string) => string[]} [highlightCode]
 * @property {string} [codeBlockIndent]
 */

/**
 * @typedef {object} InlineStyleContext
 * @property {(text: string) => string} applyText
 * @property {string} stylePrefix
 */

/**
 * Terminal markdown renderer.
 * @implements {import("../tui.js").Component}
 */
export class Markdown extends RetainedComponent {
    text;
    paddingX;
    paddingY;
    defaultTextStyle;
    theme;
    defaultStylePrefix;
    cachedText;
    cachedWidth;
    cachedLines;
    cachedFrame;
    sourceProvider = new TextSelectionSource("");
    /**
     * @param {string} text
     * @param {number} paddingX
     * @param {number} paddingY
     * @param {MarkdownTheme} theme
     * @param {DefaultTextStyle} [defaultTextStyle]
     */
    constructor(text, paddingX, paddingY, theme, defaultTextStyle){
        super();
        this.text = text;
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.theme = theme;
        this.defaultTextStyle = defaultTextStyle;
    }
    /** @param {string} text */
    setText(text) {
        this.text = text;
        this.invalidate();
    }
    invalidate() {
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
        this.cachedFrame = undefined;
        this.markDirty();
    }
    /**
     * @param {number} width
     * @returns {{ lines: string[], spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[] }}
     */
    renderFrame(width) {
        if (this.cachedFrame && this.cachedText === this.text && this.cachedWidth === width) {
            return this.cachedFrame;
        }
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        if (!this.text || this.text.trim() === "") {
            const frame = { lines: [], spans: [], sourceSpans: [] };
            this.cachedText = this.text;
            this.cachedWidth = width;
            this.cachedLines = frame.lines;
            this.cachedFrame = frame;
            return frame;
        }
        const normalizedText = this.text.replace(/\t/g, "   ");
        const { tokens } = parseMarkdown(normalizedText);
        const source = new MarkdownSourceBuilder(this.sourceProvider);
        const body = { lines: [], sourceSpans: [] };
        for(let i = 0; i < tokens.length; i++){
            const token = tokens[i];
            const nextToken = tokens[i + 1];
            const tokenFrame = this.renderTokenFrame(token, contentWidth, nextToken?.type, source, (text)=>this.applyDefaultStyle(text));
            body.lines.push(...tokenFrame.lines);
            body.sourceSpans.push(...offsetSourceSpans(tokenFrame.sourceSpans, body.lines.length - tokenFrame.lines.length));
        }
        this.sourceProvider.setText(source.text);
        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const bgFn = this.defaultTextStyle?.bgColor;
        const contentLines = [];
        for (const line of body.lines){
            if (isImageLine(line)) {
                contentLines.push(line);
                continue;
            }
            const lineWithMargins = leftMargin + line + rightMargin;
            if (bgFn) {
                contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
            } else {
                const visibleLen = visibleWidth(lineWithMargins);
                const paddingNeeded = Math.max(0, width - visibleLen);
                contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
            }
        }
        const emptyLine = " ".repeat(width);
        const emptyLines = [];
        for(let i = 0; i < this.paddingY; i++){
            const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
            emptyLines.push(line);
        }
        const result = emptyLines.concat(contentLines, emptyLines);
        const sourceSpans = offsetSourceSpans(body.sourceSpans, this.paddingY, this.paddingX);
        const frame = { lines: result.length > 0 ? result : [""], spans: [], sourceSpans };
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = frame.lines;
        this.cachedFrame = frame;
        return frame;
    }
    /**
     * @param {number} width
     * @returns {string[]}
     */
    render(width) {
        return this.renderFrame(width).lines;
    }
    renderTokenFrame(token, width, nextTokenType, source, styleFn) {
        switch(token.type){
            case "heading":
                {
                    const headingLevel = token.depth;
                    let headingStyleFn;
                    if (headingLevel === 1) {
                        headingStyleFn = (text)=>this.theme.heading(this.theme.bold(this.theme.underline(text)));
                    } else {
                        headingStyleFn = (text)=>this.theme.heading(this.theme.bold(text));
                    }
                    const segments = this.renderInlineSegments(token.tokens || [], source, composeStyle(styleFn, headingStyleFn));
                    const prefix = headingLevel >= 3 ? [
                        ignoredSegment(`${"#".repeat(headingLevel)} `, headingStyleFn)
                    ] : [];
                    const frame = renderSegmentedText(segments, width, { component: this, firstLinePrefix: prefix });
                    if (nextTokenType && nextTokenType !== "space") {
                        frame.lines.push("");
                        source.appendBlockBreak();
                    }
                    return frame;
                }
            case "paragraph":
                {
                    const segments = this.renderInlineSegments(token.tokens || [], source, styleFn);
                    const frame = renderSegmentedText(segments, width, { component: this });
                    if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
                        frame.lines.push("");
                        source.appendBlockBreak();
                    } else if (nextTokenType === "list") {
                        source.appendLineBreak();
                    }
                    return frame;
                }
            case "text":
                return renderSegmentedText(this.renderInlineSegments([token], source, styleFn), width, { component: this });
            case "code":
                return this.renderCodeFrame(token, width, nextTokenType, source);
            case "math":
                {
                    const raw = typeof token.raw === "string" ? token.raw.trimEnd() : token.text || "";
                    return renderSegmentedText([source.segment(raw, styleFn)], width, { component: this });
                }
            case "list":
                {
                    const frame = this.renderListFrame(token, 0, width, source, styleFn);
                    if (nextTokenType && nextTokenType !== "space") {
                        source.appendLineBreak();
                    }
                    return frame;
                }
            case "blockquote":
                return this.renderBlockquoteFrame(token, width, nextTokenType, source, styleFn);
            case "table":
                {
                    const lines = this.renderTable(token, width, nextTokenType, styleFn ? { applyText: styleFn, stylePrefix: "" } : undefined);
                    return { lines, spans: [], sourceSpans: [] };
                }
            case "hr":
                {
                    const lines = [this.theme.hr("─".repeat(Math.min(width, 80)))];
                    const sourceSpans = [
                        ignoreSourceSpan(0, 0, visibleWidth(lines[0]), this)
                    ].filter(Boolean);
                    if (nextTokenType && nextTokenType !== "space") {
                        lines.push("");
                        source.appendBlockBreak();
                    }
                    return { lines, spans: [], sourceSpans };
                }
            case "html":
                if ("raw" in token && typeof token.raw === "string") {
                    return renderSegmentedText([source.segment(token.raw.trim(), styleFn)], width, { component: this });
                }
                return { lines: [], spans: [], sourceSpans: [] };
            case "footnote":
                return renderSegmentedText([source.segment(token.raw?.trimEnd() || token.text || "", styleFn)], width, { component: this });
            case "space":
                source.append(typeof token.raw === "string" ? token.raw : "\n");
                return { lines: [""], spans: [], sourceSpans: [] };
            default:
                if ("text" in token && typeof token.text === "string") {
                    return renderSegmentedText([source.segment(token.text, styleFn)], width, { component: this });
                }
                return { lines: [], spans: [], sourceSpans: [] };
        }
    }
    renderInlineSegments(tokens, source, styleFn) {
        const segments = [];
        for (const token of tokens){
            switch(token.type){
                case "text":
                    if (token.tokens && token.tokens.length > 0) {
                        segments.push(...this.renderInlineSegments(token.tokens, source, styleFn));
                    } else {
                        segments.push(source.segment(token.text, styleFn));
                    }
                    break;
                case "paragraph":
                    segments.push(...this.renderInlineSegments(token.tokens || [], source, styleFn));
                    break;
                case "strong":
                    segments.push(...this.renderInlineSegments(token.tokens || [], source, composeStyle(styleFn, (text)=>this.theme.bold(text))));
                    break;
                case "em":
                    segments.push(...this.renderInlineSegments(token.tokens || [], source, composeStyle(styleFn, (text)=>this.theme.italic(text))));
                    break;
                case "codespan":
                    segments.push(source.segment(token.text, (text)=>this.theme.code(text)));
                    break;
                case "link":
                    {
                        const linkStyle = getCapabilities().hyperlinks
                            ? (text)=>hyperlink(this.theme.link(this.theme.underline(text)), token.href)
                            : (text)=>this.theme.link(this.theme.underline(text));
                        segments.push(...this.renderInlineSegments(token.tokens || [], source, linkStyle));
                        break;
                    }
                case "br":
                    segments.push(source.segment("\n", styleFn));
                    break;
                case "del":
                    segments.push(...this.renderInlineSegments(token.tokens || [], source, composeStyle(styleFn, (text)=>this.theme.strikethrough(text))));
                    break;
                case "html":
                    if ("raw" in token && typeof token.raw === "string") {
                        segments.push(source.segment(token.raw, styleFn));
                    }
                    break;
                case "math":
                case "math_source":
                case "footnote_ref":
                    segments.push(source.segment(token.raw || token.text || "", styleFn));
                    break;
                default:
                    if ("text" in token && typeof token.text === "string") {
                        segments.push(source.segment(token.text, styleFn));
                    }
            }
        }
        return segments;
    }
    renderCodeFrame(token, width, nextTokenType, source) {
        const indent = this.theme.codeBlockIndent ?? "  ";
        const lines = [this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`)];
        const sourceSpans = [
            ignoreSourceSpan(0, 0, visibleWidth(lines[0]), this)
        ].filter(Boolean);
        const codeLines = token.text.split("\n");
        for(let i = 0; i < codeLines.length; i++){
            const frame = renderSegmentedText([source.segment(codeLines[i], (text)=>this.theme.codeBlock(text))], width, {
                component: this,
                firstLinePrefix: [ignoredSegment(indent)],
            });
            sourceSpans.push(...offsetSourceSpans(frame.sourceSpans, lines.length));
            lines.push(...frame.lines);
            if (i < codeLines.length - 1) source.append("\n");
        }
        lines.push(this.theme.codeBlockBorder("```"));
        const closingLine = lines.length - 1;
        const closingSpan = ignoreSourceSpan(closingLine, 0, visibleWidth(lines[closingLine]), this);
        if (closingSpan) sourceSpans.push(closingSpan);
        if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
            source.appendBlockBreak();
        }
        return { lines, spans: [], sourceSpans };
    }
    renderListFrame(token, depth, width, source, styleFn) {
        const lines = [];
        const sourceSpans = [];
        const indent = "    ".repeat(depth);
        const startNumber = typeof token.start === "number" ? token.start : 1;
        for(let i = 0; i < token.items.length; i++){
            if (i > 0) source.append("\n");
            const item = token.items[i];
            const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
            const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
            const marker = bullet + taskMarker;
            let renderedAnyLine = false;
            for (const itemToken of item.tokens){
                if (itemToken.type === "list") {
                    if (renderedAnyLine) source.append("\n");
                    const nested = this.renderListFrame(itemToken, depth + 1, width, source, styleFn);
                    sourceSpans.push(...offsetSourceSpans(nested.sourceSpans, lines.length));
                    lines.push(...nested.lines);
                    renderedAnyLine = true;
                    continue;
                }
                if (renderedAnyLine) source.append("\n");
                const firstPrefix = renderedAnyLine
                    ? [ignoredSegment(indent + " ".repeat(visibleWidth(marker)))]
                    : [
                        ...(indent ? [source.segment(indent)] : []),
                        source.segment(marker, (text)=>this.theme.listBullet(text)),
                    ];
                const continuationPrefix = [ignoredSegment(indent + " ".repeat(visibleWidth(marker)))];
                const segments = itemToken.type === "paragraph" || itemToken.type === "text"
                    ? this.renderInlineSegments(itemToken.tokens || [itemToken], source, styleFn)
                    : [source.segment(typeof itemToken.text === "string" ? itemToken.text : "", styleFn)];
                const frame = renderSegmentedText(segments, width, {
                    component: this,
                    firstLinePrefix: firstPrefix,
                    continuationLinePrefix: continuationPrefix,
                });
                sourceSpans.push(...offsetSourceSpans(frame.sourceSpans, lines.length));
                lines.push(...frame.lines);
                renderedAnyLine = true;
            }
            if (!renderedAnyLine) {
                const frame = renderSegmentedText([], width, {
                    component: this,
                    firstLinePrefix: [
                        ...(indent ? [source.segment(indent)] : []),
                        source.segment(marker, (text)=>this.theme.listBullet(text)),
                    ],
                });
                sourceSpans.push(...offsetSourceSpans(frame.sourceSpans, lines.length));
                lines.push(...frame.lines);
            }
        }
        return { lines, spans: [], sourceSpans };
    }
    renderBlockquoteFrame(token, width, nextTokenType, source, styleFn) {
        const quoteStyle = (text)=>this.theme.quote(this.theme.italic(text));
        const quoteWidth = Math.max(1, width - 2);
        const quoteTokens = token.alert
            ? [{ type: "text", tokens: [{ type: "text", raw: token.alert, text: token.alert }] }, ...(token.tokens || [])]
            : token.tokens || [];
        const inner = { lines: [], sourceSpans: [] };
        for(let i = 0; i < quoteTokens.length; i++){
            const frame = this.renderTokenFrame(quoteTokens[i], quoteWidth, quoteTokens[i + 1]?.type, source, composeStyle(styleFn, quoteStyle));
            inner.sourceSpans.push(...offsetSourceSpans(frame.sourceSpans, inner.lines.length));
            inner.lines.push(...frame.lines);
        }
        while(inner.lines.length > 0 && inner.lines[inner.lines.length - 1] === ""){
            inner.lines.pop();
        }
        const lines = inner.lines.map((line)=>this.theme.quoteBorder("│ ") + line);
        const borderSpans = lines
            .map((_, line)=>ignoreSourceSpan(line, 0, 2, this))
            .filter(Boolean);
        const sourceSpans = borderSpans.concat(offsetSourceSpans(inner.sourceSpans.filter((span)=>span.line < lines.length), 0, 2));
        if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
            source.appendBlockBreak();
        }
        return { lines, spans: [], sourceSpans };
    }
    applyDefaultStyle(text) {
        if (!this.defaultTextStyle) {
            return text;
        }
        let styled = text;
        if (this.defaultTextStyle.color) {
            styled = this.defaultTextStyle.color(styled);
        }
        if (this.defaultTextStyle.bold) {
            styled = this.theme.bold(styled);
        }
        if (this.defaultTextStyle.italic) {
            styled = this.theme.italic(styled);
        }
        if (this.defaultTextStyle.strikethrough) {
            styled = this.theme.strikethrough(styled);
        }
        if (this.defaultTextStyle.underline) {
            styled = this.theme.underline(styled);
        }
        return styled;
    }
    getDefaultStylePrefix() {
        if (!this.defaultTextStyle) {
            return "";
        }
        if (this.defaultStylePrefix !== undefined) {
            return this.defaultStylePrefix;
        }
        const sentinel = "\u0000";
        let styled = sentinel;
        if (this.defaultTextStyle.color) {
            styled = this.defaultTextStyle.color(styled);
        }
        if (this.defaultTextStyle.bold) {
            styled = this.theme.bold(styled);
        }
        if (this.defaultTextStyle.italic) {
            styled = this.theme.italic(styled);
        }
        if (this.defaultTextStyle.strikethrough) {
            styled = this.theme.strikethrough(styled);
        }
        if (this.defaultTextStyle.underline) {
            styled = this.theme.underline(styled);
        }
        const sentinelIndex = styled.indexOf(sentinel);
        this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
        return this.defaultStylePrefix;
    }
    getStylePrefix(styleFn) {
        const sentinel = "\u0000";
        const styled = styleFn(sentinel);
        const sentinelIndex = styled.indexOf(sentinel);
        return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
    }
    getDefaultInlineStyleContext() {
        return {
            applyText: (text)=>this.applyDefaultStyle(text),
            stylePrefix: this.getDefaultStylePrefix()
        };
    }
    renderInlineTokens(tokens, styleContext) {
        let result = "";
        const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
        const { applyText, stylePrefix } = resolvedStyleContext;
        const applyTextWithNewlines = (text)=>{
            const segments = text.split("\n");
            return segments.map((segment)=>applyText(segment)).join("\n");
        };
        for (const token of tokens){
            switch(token.type){
                case "text":
                    if (token.tokens && token.tokens.length > 0) {
                        result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
                    } else {
                        result += applyTextWithNewlines(token.text);
                    }
                    break;
                case "paragraph":
                    result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    break;
                case "strong":
                    {
                        const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                        result += this.theme.bold(boldContent) + stylePrefix;
                        break;
                    }
                case "em":
                    {
                        const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                        result += this.theme.italic(italicContent) + stylePrefix;
                        break;
                    }
                case "codespan":
                    result += this.theme.code(token.text) + stylePrefix;
                    break;
                case "link":
                    {
                        const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                        const styledLink = this.theme.link(this.theme.underline(linkText));
                        if (getCapabilities().hyperlinks) {
                            result += hyperlink(styledLink, token.href) + stylePrefix;
                        } else {
                            result += styledLink + stylePrefix;
                        }
                        break;
                    }
                case "br":
                    result += "\n";
                    break;
                case "del":
                    {
                        const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                        result += this.theme.strikethrough(delContent) + stylePrefix;
                        break;
                    }
                case "html":
                    if ("raw" in token && typeof token.raw === "string") {
                        result += applyTextWithNewlines(token.raw);
                    }
                    break;
                default:
                    if ("text" in token && typeof token.text === "string") {
                        result += applyTextWithNewlines(token.text);
                    }
            }
        }
        while(stylePrefix && result.endsWith(stylePrefix)){
            result = result.slice(0, -stylePrefix.length);
        }
        return result;
    }
    getLongestWordWidth(text, maxWidth) {
        const words = text.split(/\s+/).filter((word)=>word.length > 0);
        let longest = 0;
        for (const word of words){
            longest = Math.max(longest, visibleWidth(word));
        }
        if (maxWidth === undefined) {
            return longest;
        }
        return Math.min(longest, maxWidth);
    }
    wrapCellText(text, maxWidth) {
        return wrapTextWithAnsi(text, Math.max(1, maxWidth));
    }
    renderTable(token, availableWidth, nextTokenType, styleContext) {
        const lines = [];
        const numCols = token.header.length;
        if (numCols === 0) {
            return lines;
        }
        const borderOverhead = 3 * numCols + 1;
        const availableForCells = availableWidth - borderOverhead;
        if (availableForCells < numCols) {
            const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
            if (nextTokenType && nextTokenType !== "space") {
                fallbackLines.push("");
            }
            return fallbackLines;
        }
        const maxUnbrokenWordWidth = 30;
        const naturalWidths = [];
        const minWordWidths = [];
        for(let i = 0; i < numCols; i++){
            const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
            naturalWidths[i] = visibleWidth(headerText);
            minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
        }
        for (const row of token.rows){
            for(let i = 0; i < row.length; i++){
                const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
                naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
                minWordWidths[i] = Math.max(minWordWidths[i] || 1, this.getLongestWordWidth(cellText, maxUnbrokenWordWidth));
            }
        }
        let minColumnWidths = minWordWidths;
        let minCellsWidth = minColumnWidths.reduce((a, b)=>a + b, 0);
        if (minCellsWidth > availableForCells) {
            minColumnWidths = new Array(numCols).fill(1);
            const remaining = availableForCells - numCols;
            if (remaining > 0) {
                const totalWeight = minWordWidths.reduce((total, width)=>total + Math.max(0, width - 1), 0);
                const growth = minWordWidths.map((width)=>{
                    const weight = Math.max(0, width - 1);
                    return totalWeight > 0 ? Math.floor(weight / totalWeight * remaining) : 0;
                });
                for(let i = 0; i < numCols; i++){
                    minColumnWidths[i] += growth[i] ?? 0;
                }
                const allocated = growth.reduce((total, width)=>total + width, 0);
                let leftover = remaining - allocated;
                for(let i = 0; leftover > 0 && i < numCols; i++){
                    minColumnWidths[i]++;
                    leftover--;
                }
            }
            minCellsWidth = minColumnWidths.reduce((a, b)=>a + b, 0);
        }
        const totalNaturalWidth = naturalWidths.reduce((a, b)=>a + b, 0) + borderOverhead;
        let columnWidths;
        if (totalNaturalWidth <= availableWidth) {
            columnWidths = naturalWidths.map((width, index)=>Math.max(width, minColumnWidths[index]));
        } else {
            const totalGrowPotential = naturalWidths.reduce((total, width, index)=>{
                return total + Math.max(0, width - minColumnWidths[index]);
            }, 0);
            const extraWidth = Math.max(0, availableForCells - minCellsWidth);
            columnWidths = minColumnWidths.map((minWidth, index)=>{
                const naturalWidth = naturalWidths[index];
                const minWidthDelta = Math.max(0, naturalWidth - minWidth);
                let grow = 0;
                if (totalGrowPotential > 0) {
                    grow = Math.floor(minWidthDelta / totalGrowPotential * extraWidth);
                }
                return minWidth + grow;
            });
            const allocated = columnWidths.reduce((a, b)=>a + b, 0);
            let remaining = availableForCells - allocated;
            while(remaining > 0){
                let grew = false;
                for(let i = 0; i < numCols && remaining > 0; i++){
                    if (columnWidths[i] < naturalWidths[i]) {
                        columnWidths[i]++;
                        remaining--;
                        grew = true;
                    }
                }
                if (!grew) {
                    break;
                }
            }
        }
        const topBorderCells = columnWidths.map((w)=>"─".repeat(w));
        lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);
        const headerCellLines = token.header.map((cell, i)=>{
            const text = this.renderInlineTokens(cell.tokens || [], styleContext);
            return this.wrapCellText(text, columnWidths[i]);
        });
        const headerLineCount = Math.max(...headerCellLines.map((c)=>c.length));
        for(let lineIdx = 0; lineIdx < headerLineCount; lineIdx++){
            const rowParts = headerCellLines.map((cellLines, colIdx)=>{
                const text = cellLines[lineIdx] || "";
                const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
                return this.theme.bold(padded);
            });
            lines.push(`│ ${rowParts.join(" │ ")} │`);
        }
        const separatorCells = columnWidths.map((w)=>"─".repeat(w));
        const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
        lines.push(separatorLine);
        for(let rowIndex = 0; rowIndex < token.rows.length; rowIndex++){
            const row = token.rows[rowIndex];
            const rowCellLines = row.map((cell, i)=>{
                const text = this.renderInlineTokens(cell.tokens || [], styleContext);
                return this.wrapCellText(text, columnWidths[i]);
            });
            const rowLineCount = Math.max(...rowCellLines.map((c)=>c.length));
            for(let lineIdx = 0; lineIdx < rowLineCount; lineIdx++){
                const rowParts = rowCellLines.map((cellLines, colIdx)=>{
                    const text = cellLines[lineIdx] || "";
                    return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
                });
                lines.push(`│ ${rowParts.join(" │ ")} │`);
            }
            if (rowIndex < token.rows.length - 1) {
                lines.push(separatorLine);
            }
        }
        const bottomBorderCells = columnWidths.map((w)=>"─".repeat(w));
        lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);
        if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
        }
        return lines;
    }
}
