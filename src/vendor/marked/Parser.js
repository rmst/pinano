// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { _Renderer } from './Renderer.js';
import { _TextRenderer } from './TextRenderer.js';
import { _defaults } from './defaults.js';
export class _Parser {
    options;
    renderer;
    textRenderer;
    constructor(options){
        this.options = options || _defaults;
        this.options.renderer = this.options.renderer || new _Renderer();
        this.renderer = this.options.renderer;
        this.renderer.options = this.options;
        this.renderer.parser = this;
        this.textRenderer = new _TextRenderer();
    }
    static parse(tokens, options) {
        const parser = new _Parser(options);
        return parser.parse(tokens);
    }
    static parseInline(tokens, options) {
        const parser = new _Parser(options);
        return parser.parseInline(tokens);
    }
    parse(tokens, top = true) {
        let out = '';
        for(let i = 0; i < tokens.length; i++){
            const anyToken = tokens[i];
            if (this.options.extensions?.renderers?.[anyToken.type]) {
                const genericToken = anyToken;
                const ret = this.options.extensions.renderers[genericToken.type].call({
                    parser: this
                }, genericToken);
                if (ret !== false || ![
                    'space',
                    'hr',
                    'heading',
                    'code',
                    'table',
                    'blockquote',
                    'list',
                    'html',
                    'paragraph',
                    'text'
                ].includes(genericToken.type)) {
                    out += ret || '';
                    continue;
                }
            }
            const token = anyToken;
            switch(token.type){
                case 'space':
                    {
                        out += this.renderer.space(token);
                        continue;
                    }
                case 'hr':
                    {
                        out += this.renderer.hr(token);
                        continue;
                    }
                case 'heading':
                    {
                        out += this.renderer.heading(token);
                        continue;
                    }
                case 'code':
                    {
                        out += this.renderer.code(token);
                        continue;
                    }
                case 'table':
                    {
                        out += this.renderer.table(token);
                        continue;
                    }
                case 'blockquote':
                    {
                        out += this.renderer.blockquote(token);
                        continue;
                    }
                case 'list':
                    {
                        out += this.renderer.list(token);
                        continue;
                    }
                case 'html':
                    {
                        out += this.renderer.html(token);
                        continue;
                    }
                case 'paragraph':
                    {
                        out += this.renderer.paragraph(token);
                        continue;
                    }
                case 'text':
                    {
                        let textToken = token;
                        let body = this.renderer.text(textToken);
                        while(i + 1 < tokens.length && tokens[i + 1].type === 'text'){
                            textToken = tokens[++i];
                            body += '\n' + this.renderer.text(textToken);
                        }
                        if (top) {
                            out += this.renderer.paragraph({
                                type: 'paragraph',
                                raw: body,
                                text: body,
                                tokens: [
                                    {
                                        type: 'text',
                                        raw: body,
                                        text: body,
                                        escaped: true
                                    }
                                ]
                            });
                        } else {
                            out += body;
                        }
                        continue;
                    }
                default:
                    {
                        const errMsg = 'Token with "' + token.type + '" type was not found.';
                        if (this.options.silent) {
                            console.error(errMsg);
                            return '';
                        } else {
                            throw new Error(errMsg);
                        }
                    }
            }
        }
        return out;
    }
    parseInline(tokens, renderer = this.renderer) {
        let out = '';
        for(let i = 0; i < tokens.length; i++){
            const anyToken = tokens[i];
            if (this.options.extensions?.renderers?.[anyToken.type]) {
                const ret = this.options.extensions.renderers[anyToken.type].call({
                    parser: this
                }, anyToken);
                if (ret !== false || ![
                    'escape',
                    'html',
                    'link',
                    'image',
                    'strong',
                    'em',
                    'codespan',
                    'br',
                    'del',
                    'text'
                ].includes(anyToken.type)) {
                    out += ret || '';
                    continue;
                }
            }
            const token = anyToken;
            switch(token.type){
                case 'escape':
                    {
                        out += renderer.text(token);
                        break;
                    }
                case 'html':
                    {
                        out += renderer.html(token);
                        break;
                    }
                case 'link':
                    {
                        out += renderer.link(token);
                        break;
                    }
                case 'image':
                    {
                        out += renderer.image(token);
                        break;
                    }
                case 'strong':
                    {
                        out += renderer.strong(token);
                        break;
                    }
                case 'em':
                    {
                        out += renderer.em(token);
                        break;
                    }
                case 'codespan':
                    {
                        out += renderer.codespan(token);
                        break;
                    }
                case 'br':
                    {
                        out += renderer.br(token);
                        break;
                    }
                case 'del':
                    {
                        out += renderer.del(token);
                        break;
                    }
                case 'text':
                    {
                        out += renderer.text(token);
                        break;
                    }
                default:
                    {
                        const errMsg = 'Token with "' + token.type + '" type was not found.';
                        if (this.options.silent) {
                            console.error(errMsg);
                            return '';
                        } else {
                            throw new Error(errMsg);
                        }
                    }
            }
        }
        return out;
    }
}
