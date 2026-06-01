// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { _defaults } from './defaults.js';
import { _Lexer } from './Lexer.js';
import { _Parser } from './Parser.js';
export class _Hooks {
    options;
    block;
    constructor(options){
        this.options = options || _defaults;
    }
    static passThroughHooks = new Set([
        'preprocess',
        'postprocess',
        'processAllTokens'
    ]);
    preprocess(markdown) {
        return markdown;
    }
    postprocess(html) {
        return html;
    }
    processAllTokens(tokens) {
        return tokens;
    }
    provideLexer() {
        return this.block ? _Lexer.lex : _Lexer.lexInline;
    }
    provideParser() {
        return this.block ? _Parser.parse : _Parser.parseInline;
    }
}
