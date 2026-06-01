// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { _getDefaults } from './defaults.js';
import { _Lexer } from './Lexer.js';
import { _Parser } from './Parser.js';
import { _Hooks } from './Hooks.js';
import { _Renderer } from './Renderer.js';
import { _Tokenizer } from './Tokenizer.js';
import { _TextRenderer } from './TextRenderer.js';
import { escape } from './helpers.js';
export class Marked {
    defaults = _getDefaults();
    options = this.setOptions;
    parse = this.parseMarkdown(true);
    parseInline = this.parseMarkdown(false);
    Parser = _Parser;
    Renderer = _Renderer;
    TextRenderer = _TextRenderer;
    Lexer = _Lexer;
    Tokenizer = _Tokenizer;
    Hooks = _Hooks;
    constructor(...args){
        this.use(...args);
    }
    walkTokens(tokens, callback) {
        let values = [];
        for (const token of tokens){
            values = values.concat(callback.call(this, token));
            switch(token.type){
                case 'table':
                    {
                        const tableToken = token;
                        for (const cell of tableToken.header){
                            values = values.concat(this.walkTokens(cell.tokens, callback));
                        }
                        for (const row of tableToken.rows){
                            for (const cell of row){
                                values = values.concat(this.walkTokens(cell.tokens, callback));
                            }
                        }
                        break;
                    }
                case 'list':
                    {
                        const listToken = token;
                        values = values.concat(this.walkTokens(listToken.items, callback));
                        break;
                    }
                default:
                    {
                        const genericToken = token;
                        if (this.defaults.extensions?.childTokens?.[genericToken.type]) {
                            this.defaults.extensions.childTokens[genericToken.type].forEach((childTokens)=>{
                                const tokens = genericToken[childTokens].flat(Infinity);
                                values = values.concat(this.walkTokens(tokens, callback));
                            });
                        } else if (genericToken.tokens) {
                            values = values.concat(this.walkTokens(genericToken.tokens, callback));
                        }
                    }
            }
        }
        return values;
    }
    use(...args) {
        const extensions = this.defaults.extensions || {
            renderers: {},
            childTokens: {}
        };
        args.forEach((pack)=>{
            const opts = {
                ...pack
            };
            opts.async = this.defaults.async || opts.async || false;
            if (pack.extensions) {
                pack.extensions.forEach((ext)=>{
                    if (!ext.name) {
                        throw new Error('extension name required');
                    }
                    if ('renderer' in ext) {
                        const prevRenderer = extensions.renderers[ext.name];
                        if (prevRenderer) {
                            extensions.renderers[ext.name] = function(...args) {
                                let ret = ext.renderer.apply(this, args);
                                if (ret === false) {
                                    ret = prevRenderer.apply(this, args);
                                }
                                return ret;
                            };
                        } else {
                            extensions.renderers[ext.name] = ext.renderer;
                        }
                    }
                    if ('tokenizer' in ext) {
                        if (!ext.level || ext.level !== 'block' && ext.level !== 'inline') {
                            throw new Error("extension level must be 'block' or 'inline'");
                        }
                        const extLevel = extensions[ext.level];
                        if (extLevel) {
                            extLevel.unshift(ext.tokenizer);
                        } else {
                            extensions[ext.level] = [
                                ext.tokenizer
                            ];
                        }
                        if (ext.start) {
                            if (ext.level === 'block') {
                                if (extensions.startBlock) {
                                    extensions.startBlock.push(ext.start);
                                } else {
                                    extensions.startBlock = [
                                        ext.start
                                    ];
                                }
                            } else if (ext.level === 'inline') {
                                if (extensions.startInline) {
                                    extensions.startInline.push(ext.start);
                                } else {
                                    extensions.startInline = [
                                        ext.start
                                    ];
                                }
                            }
                        }
                    }
                    if ('childTokens' in ext && ext.childTokens) {
                        extensions.childTokens[ext.name] = ext.childTokens;
                    }
                });
                opts.extensions = extensions;
            }
            if (pack.renderer) {
                const renderer = this.defaults.renderer || new _Renderer(this.defaults);
                for(const prop in pack.renderer){
                    if (!(prop in renderer)) {
                        throw new Error(`renderer '${prop}' does not exist`);
                    }
                    if ([
                        'options',
                        'parser'
                    ].includes(prop)) {
                        continue;
                    }
                    const rendererProp = prop;
                    const rendererFunc = pack.renderer[rendererProp];
                    const prevRenderer = renderer[rendererProp];
                    renderer[rendererProp] = (...args)=>{
                        let ret = rendererFunc.apply(renderer, args);
                        if (ret === false) {
                            ret = prevRenderer.apply(renderer, args);
                        }
                        return ret || '';
                    };
                }
                opts.renderer = renderer;
            }
            if (pack.tokenizer) {
                const tokenizer = this.defaults.tokenizer || new _Tokenizer(this.defaults);
                for(const prop in pack.tokenizer){
                    if (!(prop in tokenizer)) {
                        throw new Error(`tokenizer '${prop}' does not exist`);
                    }
                    if ([
                        'options',
                        'rules',
                        'lexer'
                    ].includes(prop)) {
                        continue;
                    }
                    const tokenizerProp = prop;
                    const tokenizerFunc = pack.tokenizer[tokenizerProp];
                    const prevTokenizer = tokenizer[tokenizerProp];
                    tokenizer[tokenizerProp] = (...args)=>{
                        let ret = tokenizerFunc.apply(tokenizer, args);
                        if (ret === false) {
                            ret = prevTokenizer.apply(tokenizer, args);
                        }
                        return ret;
                    };
                }
                opts.tokenizer = tokenizer;
            }
            if (pack.hooks) {
                const hooks = this.defaults.hooks || new _Hooks();
                for(const prop in pack.hooks){
                    if (!(prop in hooks)) {
                        throw new Error(`hook '${prop}' does not exist`);
                    }
                    if ([
                        'options',
                        'block'
                    ].includes(prop)) {
                        continue;
                    }
                    const hooksProp = prop;
                    const hooksFunc = pack.hooks[hooksProp];
                    const prevHook = hooks[hooksProp];
                    if (_Hooks.passThroughHooks.has(prop)) {
                        hooks[hooksProp] = (arg)=>{
                            if (this.defaults.async) {
                                return Promise.resolve(hooksFunc.call(hooks, arg)).then((ret)=>{
                                    return prevHook.call(hooks, ret);
                                });
                            }
                            const ret = hooksFunc.call(hooks, arg);
                            return prevHook.call(hooks, ret);
                        };
                    } else {
                        hooks[hooksProp] = (...args)=>{
                            let ret = hooksFunc.apply(hooks, args);
                            if (ret === false) {
                                ret = prevHook.apply(hooks, args);
                            }
                            return ret;
                        };
                    }
                }
                opts.hooks = hooks;
            }
            if (pack.walkTokens) {
                const walkTokens = this.defaults.walkTokens;
                const packWalktokens = pack.walkTokens;
                opts.walkTokens = function(token) {
                    let values = [];
                    values.push(packWalktokens.call(this, token));
                    if (walkTokens) {
                        values = values.concat(walkTokens.call(this, token));
                    }
                    return values;
                };
            }
            this.defaults = {
                ...this.defaults,
                ...opts
            };
        });
        return this;
    }
    setOptions(opt) {
        this.defaults = {
            ...this.defaults,
            ...opt
        };
        return this;
    }
    lexer(src, options) {
        return _Lexer.lex(src, options ?? this.defaults);
    }
    parser(tokens, options) {
        return _Parser.parse(tokens, options ?? this.defaults);
    }
    parseMarkdown(blockType) {
        const parse = (src, options)=>{
            const origOpt = {
                ...options
            };
            const opt = {
                ...this.defaults,
                ...origOpt
            };
            const throwError = this.onError(!!opt.silent, !!opt.async);
            if (this.defaults.async === true && origOpt.async === false) {
                return throwError(new Error('marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.'));
            }
            if (typeof src === 'undefined' || src === null) {
                return throwError(new Error('marked(): input parameter is undefined or null'));
            }
            if (typeof src !== 'string') {
                return throwError(new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(src) + ', string expected'));
            }
            if (opt.hooks) {
                opt.hooks.options = opt;
                opt.hooks.block = blockType;
            }
            const lexer = opt.hooks ? opt.hooks.provideLexer() : blockType ? _Lexer.lex : _Lexer.lexInline;
            const parser = opt.hooks ? opt.hooks.provideParser() : blockType ? _Parser.parse : _Parser.parseInline;
            if (opt.async) {
                return Promise.resolve(opt.hooks ? opt.hooks.preprocess(src) : src).then((src)=>lexer(src, opt)).then((tokens)=>opt.hooks ? opt.hooks.processAllTokens(tokens) : tokens).then((tokens)=>opt.walkTokens ? Promise.all(this.walkTokens(tokens, opt.walkTokens)).then(()=>tokens) : tokens).then((tokens)=>parser(tokens, opt)).then((html)=>opt.hooks ? opt.hooks.postprocess(html) : html).catch(throwError);
            }
            try {
                if (opt.hooks) {
                    src = opt.hooks.preprocess(src);
                }
                let tokens = lexer(src, opt);
                if (opt.hooks) {
                    tokens = opt.hooks.processAllTokens(tokens);
                }
                if (opt.walkTokens) {
                    this.walkTokens(tokens, opt.walkTokens);
                }
                let html = parser(tokens, opt);
                if (opt.hooks) {
                    html = opt.hooks.postprocess(html);
                }
                return html;
            } catch (e) {
                return throwError(e);
            }
        };
        return parse;
    }
    onError(silent, async) {
        return (e)=>{
            e.message += '\nPlease report this to https://github.com/markedjs/marked.';
            if (silent) {
                const msg = '<p>An error occurred:</p><pre>' + escape(e.message + '', true) + '</pre>';
                if (async) {
                    return Promise.resolve(msg);
                }
                return msg;
            }
            if (async) {
                return Promise.reject(e);
            }
            throw e;
        };
    }
}
