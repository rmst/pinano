// Markdown terminal renderer, ported from pi-coding-agent's TUI.
// Uses the vendored Marked parser in ../../vendor/marked so Pinano keeps its
// no-runtime-npm-dependencies / no-build-step contract.

import { Marked, Tokenizer } from "../../vendor/marked/marked.js";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.js";
import { RetainedComponent } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";
const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
class StrictStrikethroughTokenizer extends Tokenizer {
    del(src) {
        const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
        if (!match) {
            return undefined;
        }
        const text = match[2];
        return {
            type: "del",
            raw: match[0],
            text,
            tokens: this.lexer.inlineTokens(text)
        };
    }
}
const markdownParser = new Marked();
markdownParser.setOptions({
    tokenizer: new StrictStrikethroughTokenizer()
});

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
 * @property {(text: string) => string} linkUrl
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
        this.markDirty();
    }
    /**
     * @param {number} width
     * @returns {string[]}
     */
    render(width) {
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
            return this.cachedLines;
        }
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        if (!this.text || this.text.trim() === "") {
            const result = [];
            this.cachedText = this.text;
            this.cachedWidth = width;
            this.cachedLines = result;
            return result;
        }
        const normalizedText = this.text.replace(/\t/g, "   ");
        const tokens = markdownParser.lexer(normalizedText);
        const renderedLines = [];
        for(let i = 0; i < tokens.length; i++){
            const token = tokens[i];
            const nextToken = tokens[i + 1];
            const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
            for (const tokenLine of tokenLines){
                renderedLines.push(tokenLine);
            }
        }
        const wrappedLines = [];
        for (const line of renderedLines){
            if (isImageLine(line)) {
                wrappedLines.push(line);
            } else {
                for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)){
                    wrappedLines.push(wrappedLine);
                }
            }
        }
        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const bgFn = this.defaultTextStyle?.bgColor;
        const contentLines = [];
        for (const line of wrappedLines){
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
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = result;
        return result.length > 0 ? result : [
            ""
        ];
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
    renderToken(token, width, nextTokenType, styleContext) {
        const lines = [];
        switch(token.type){
            case "heading":
                {
                    const headingLevel = token.depth;
                    const headingPrefix = `${"#".repeat(headingLevel)} `;
                    let headingStyleFn;
                    if (headingLevel === 1) {
                        headingStyleFn = (text)=>this.theme.heading(this.theme.bold(this.theme.underline(text)));
                    } else {
                        headingStyleFn = (text)=>this.theme.heading(this.theme.bold(text));
                    }
                    const headingStyleContext = {
                        applyText: headingStyleFn,
                        stylePrefix: this.getStylePrefix(headingStyleFn)
                    };
                    const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
                    const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
                    lines.push(styledHeading);
                    if (nextTokenType && nextTokenType !== "space") {
                        lines.push("");
                    }
                    break;
                }
            case "paragraph":
                {
                    const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
                    lines.push(paragraphText);
                    if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
                        lines.push("");
                    }
                    break;
                }
            case "text":
                lines.push(this.renderInlineTokens([
                    token
                ], styleContext));
                break;
            case "code":
                {
                    const indent = this.theme.codeBlockIndent ?? "  ";
                    lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
                    if (this.theme.highlightCode) {
                        const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                        for (const hlLine of highlightedLines){
                            lines.push(`${indent}${hlLine}`);
                        }
                    } else {
                        const codeLines = token.text.split("\n");
                        for (const codeLine of codeLines){
                            lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
                        }
                    }
                    lines.push(this.theme.codeBlockBorder("```"));
                    if (nextTokenType && nextTokenType !== "space") {
                        lines.push("");
                    }
                    break;
                }
            case "list":
                {
                    const listLines = this.renderList(token, 0, width, styleContext);
                    lines.push(...listLines);
                    break;
                }
            case "table":
                {
                    const tableLines = this.renderTable(token, width, nextTokenType, styleContext);
                    lines.push(...tableLines);
                    break;
                }
            case "blockquote":
                {
                    const quoteStyle = (text)=>this.theme.quote(this.theme.italic(text));
                    const quoteStylePrefix = this.getStylePrefix(quoteStyle);
                    const applyQuoteStyle = (line)=>{
                        if (!quoteStylePrefix) {
                            return quoteStyle(line);
                        }
                        const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
                        return quoteStyle(lineWithReappliedStyle);
                    };
                    const quoteContentWidth = Math.max(1, width - 2);
                    const quoteInlineStyleContext = {
                        applyText: (text)=>text,
                        stylePrefix: quoteStylePrefix
                    };
                    const quoteTokens = token.tokens || [];
                    const renderedQuoteLines = [];
                    for(let i = 0; i < quoteTokens.length; i++){
                        const quoteToken = quoteTokens[i];
                        const nextQuoteToken = quoteTokens[i + 1];
                        renderedQuoteLines.push(...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext));
                    }
                    while(renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === ""){
                        renderedQuoteLines.pop();
                    }
                    for (const quoteLine of renderedQuoteLines){
                        const styledLine = applyQuoteStyle(quoteLine);
                        const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
                        for (const wrappedLine of wrappedLines){
                            lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
                        }
                    }
                    if (nextTokenType && nextTokenType !== "space") {
                        lines.push("");
                    }
                    break;
                }
            case "hr":
                lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push("");
                }
                break;
            case "html":
                if ("raw" in token && typeof token.raw === "string") {
                    lines.push(this.applyDefaultStyle(token.raw.trim()));
                }
                break;
            case "space":
                lines.push("");
                break;
            default:
                if ("text" in token && typeof token.text === "string") {
                    lines.push(token.text);
                }
        }
        return lines;
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
                            const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
                            if (token.text === token.href || token.text === hrefForComparison) {
                                result += styledLink + stylePrefix;
                            } else {
                                result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
                            }
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
    renderList(token, depth, width, styleContext) {
        const lines = [];
        const indent = "    ".repeat(depth);
        const startNumber = typeof token.start === "number" ? token.start : 1;
        for(let i = 0; i < token.items.length; i++){
            const item = token.items[i];
            const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
            const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
            const marker = bullet + taskMarker;
            const firstPrefix = indent + this.theme.listBullet(marker);
            const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
            const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
            let renderedAnyLine = false;
            for (const itemToken of item.tokens){
                if (itemToken.type === "list") {
                    lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
                    renderedAnyLine = true;
                    continue;
                }
                const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
                for (const line of itemLines){
                    for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)){
                        const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
                        lines.push(linePrefix + wrappedLine);
                        renderedAnyLine = true;
                    }
                }
            }
            if (!renderedAnyLine) {
                lines.push(firstPrefix);
            }
        }
        return lines;
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
