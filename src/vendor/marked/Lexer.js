// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { _Tokenizer } from './Tokenizer.js';
import { _defaults } from './defaults.js';
import { other, block, inline } from './rules.js';
export class _Lexer {
    tokens;
    options;
    state;
    tokenizer;
    inlineQueue;
    constructor(options){
        this.tokens = [];
        this.tokens.links = Object.create(null);
        this.options = options || _defaults;
        this.options.tokenizer = this.options.tokenizer || new _Tokenizer();
        this.tokenizer = this.options.tokenizer;
        this.tokenizer.options = this.options;
        this.tokenizer.lexer = this;
        this.inlineQueue = [];
        this.state = {
            inLink: false,
            inRawBlock: false,
            top: true
        };
        const rules = {
            other,
            block: block.normal,
            inline: inline.normal
        };
        if (this.options.pedantic) {
            rules.block = block.pedantic;
            rules.inline = inline.pedantic;
        } else if (this.options.gfm) {
            rules.block = block.gfm;
            if (this.options.breaks) {
                rules.inline = inline.breaks;
            } else {
                rules.inline = inline.gfm;
            }
        }
        this.tokenizer.rules = rules;
    }
    static get rules() {
        return {
            block,
            inline
        };
    }
    static lex(src, options) {
        const lexer = new _Lexer(options);
        return lexer.lex(src);
    }
    static lexInline(src, options) {
        const lexer = new _Lexer(options);
        return lexer.inlineTokens(src);
    }
    lex(src) {
        src = src.replace(other.carriageReturn, '\n');
        this.blockTokens(src, this.tokens);
        for(let i = 0; i < this.inlineQueue.length; i++){
            const next = this.inlineQueue[i];
            this.inlineTokens(next.src, next.tokens);
        }
        this.inlineQueue = [];
        return this.tokens;
    }
    blockTokens(src, tokens = [], lastParagraphClipped = false) {
        if (this.options.pedantic) {
            src = src.replace(other.tabCharGlobal, '    ').replace(other.spaceLine, '');
        }
        while(src){
            let token;
            if (this.options.extensions?.block?.some((extTokenizer)=>{
                if (token = extTokenizer.call({
                    lexer: this
                }, src, tokens)) {
                    src = src.substring(token.raw.length);
                    tokens.push(token);
                    return true;
                }
                return false;
            })) {
                continue;
            }
            if (token = this.tokenizer.space(src)) {
                src = src.substring(token.raw.length);
                const lastToken = tokens.at(-1);
                if (token.raw.length === 1 && lastToken !== undefined) {
                    lastToken.raw += '\n';
                } else {
                    tokens.push(token);
                }
                continue;
            }
            if (token = this.tokenizer.code(src)) {
                src = src.substring(token.raw.length);
                const lastToken = tokens.at(-1);
                if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
                    lastToken.raw += '\n' + token.raw;
                    lastToken.text += '\n' + token.text;
                    this.inlineQueue.at(-1).src = lastToken.text;
                } else {
                    tokens.push(token);
                }
                continue;
            }
            if (token = this.tokenizer.fences(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.heading(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.hr(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.blockquote(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.list(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.html(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.def(src)) {
                src = src.substring(token.raw.length);
                const lastToken = tokens.at(-1);
                if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
                    lastToken.raw += '\n' + token.raw;
                    lastToken.text += '\n' + token.raw;
                    this.inlineQueue.at(-1).src = lastToken.text;
                } else if (!this.tokens.links[token.tag]) {
                    this.tokens.links[token.tag] = {
                        href: token.href,
                        title: token.title
                    };
                }
                continue;
            }
            if (token = this.tokenizer.table(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.lheading(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            let cutSrc = src;
            if (this.options.extensions?.startBlock) {
                let startIndex = Infinity;
                const tempSrc = src.slice(1);
                let tempStart;
                this.options.extensions.startBlock.forEach((getStartIndex)=>{
                    tempStart = getStartIndex.call({
                        lexer: this
                    }, tempSrc);
                    if (typeof tempStart === 'number' && tempStart >= 0) {
                        startIndex = Math.min(startIndex, tempStart);
                    }
                });
                if (startIndex < Infinity && startIndex >= 0) {
                    cutSrc = src.substring(0, startIndex + 1);
                }
            }
            if (this.state.top && (token = this.tokenizer.paragraph(cutSrc))) {
                const lastToken = tokens.at(-1);
                if (lastParagraphClipped && lastToken?.type === 'paragraph') {
                    lastToken.raw += '\n' + token.raw;
                    lastToken.text += '\n' + token.text;
                    this.inlineQueue.pop();
                    this.inlineQueue.at(-1).src = lastToken.text;
                } else {
                    tokens.push(token);
                }
                lastParagraphClipped = cutSrc.length !== src.length;
                src = src.substring(token.raw.length);
                continue;
            }
            if (token = this.tokenizer.text(src)) {
                src = src.substring(token.raw.length);
                const lastToken = tokens.at(-1);
                if (lastToken?.type === 'text') {
                    lastToken.raw += '\n' + token.raw;
                    lastToken.text += '\n' + token.text;
                    this.inlineQueue.pop();
                    this.inlineQueue.at(-1).src = lastToken.text;
                } else {
                    tokens.push(token);
                }
                continue;
            }
            if (src) {
                const errMsg = 'Infinite loop on byte: ' + src.charCodeAt(0);
                if (this.options.silent) {
                    console.error(errMsg);
                    break;
                } else {
                    throw new Error(errMsg);
                }
            }
        }
        this.state.top = true;
        return tokens;
    }
    inline(src, tokens = []) {
        this.inlineQueue.push({
            src,
            tokens
        });
        return tokens;
    }
    inlineTokens(src, tokens = []) {
        let maskedSrc = src;
        let match = null;
        if (this.tokens.links) {
            const links = Object.keys(this.tokens.links);
            if (links.length > 0) {
                while((match = this.tokenizer.rules.inline.reflinkSearch.exec(maskedSrc)) != null){
                    if (links.includes(match[0].slice(match[0].lastIndexOf('[') + 1, -1))) {
                        maskedSrc = maskedSrc.slice(0, match.index) + '[' + 'a'.repeat(match[0].length - 2) + ']' + maskedSrc.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex);
                    }
                }
            }
        }
        while((match = this.tokenizer.rules.inline.anyPunctuation.exec(maskedSrc)) != null){
            maskedSrc = maskedSrc.slice(0, match.index) + '++' + maskedSrc.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
        }
        while((match = this.tokenizer.rules.inline.blockSkip.exec(maskedSrc)) != null){
            maskedSrc = maskedSrc.slice(0, match.index) + '[' + 'a'.repeat(match[0].length - 2) + ']' + maskedSrc.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
        }
        let keepPrevChar = false;
        let prevChar = '';
        while(src){
            if (!keepPrevChar) {
                prevChar = '';
            }
            keepPrevChar = false;
            let token;
            if (this.options.extensions?.inline?.some((extTokenizer)=>{
                if (token = extTokenizer.call({
                    lexer: this
                }, src, tokens)) {
                    src = src.substring(token.raw.length);
                    tokens.push(token);
                    return true;
                }
                return false;
            })) {
                continue;
            }
            if (token = this.tokenizer.escape(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.tag(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.link(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.reflink(src, this.tokens.links)) {
                src = src.substring(token.raw.length);
                const lastToken = tokens.at(-1);
                if (token.type === 'text' && lastToken?.type === 'text') {
                    lastToken.raw += token.raw;
                    lastToken.text += token.text;
                } else {
                    tokens.push(token);
                }
                continue;
            }
            if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.codespan(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.br(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.del(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (token = this.tokenizer.autolink(src)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            if (!this.state.inLink && (token = this.tokenizer.url(src))) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                continue;
            }
            let cutSrc = src;
            if (this.options.extensions?.startInline) {
                let startIndex = Infinity;
                const tempSrc = src.slice(1);
                let tempStart;
                this.options.extensions.startInline.forEach((getStartIndex)=>{
                    tempStart = getStartIndex.call({
                        lexer: this
                    }, tempSrc);
                    if (typeof tempStart === 'number' && tempStart >= 0) {
                        startIndex = Math.min(startIndex, tempStart);
                    }
                });
                if (startIndex < Infinity && startIndex >= 0) {
                    cutSrc = src.substring(0, startIndex + 1);
                }
            }
            if (token = this.tokenizer.inlineText(cutSrc)) {
                src = src.substring(token.raw.length);
                if (token.raw.slice(-1) !== '_') {
                    prevChar = token.raw.slice(-1);
                }
                keepPrevChar = true;
                const lastToken = tokens.at(-1);
                if (lastToken?.type === 'text') {
                    lastToken.raw += token.raw;
                    lastToken.text += token.text;
                } else {
                    tokens.push(token);
                }
                continue;
            }
            if (src) {
                const errMsg = 'Infinite loop on byte: ' + src.charCodeAt(0);
                if (this.options.silent) {
                    console.error(errMsg);
                    break;
                } else {
                    throw new Error(errMsg);
                }
            }
        }
        return tokens;
    }
}
