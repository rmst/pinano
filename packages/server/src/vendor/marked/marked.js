// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { _Lexer } from './Lexer.js';
import { _Parser } from './Parser.js';
import { _Tokenizer } from './Tokenizer.js';
import { _Renderer } from './Renderer.js';
import { _TextRenderer } from './TextRenderer.js';
import { _Hooks } from './Hooks.js';
import { Marked } from './Instance.js';
import { _getDefaults, changeDefaults, _defaults } from './defaults.js';
const markedInstance = new Marked();
export function marked(src, opt) {
    return markedInstance.parse(src, opt);
}
marked.options = marked.setOptions = function(options) {
    markedInstance.setOptions(options);
    marked.defaults = markedInstance.defaults;
    changeDefaults(marked.defaults);
    return marked;
};
marked.getDefaults = _getDefaults;
marked.defaults = _defaults;
marked.use = function(...args) {
    markedInstance.use(...args);
    marked.defaults = markedInstance.defaults;
    changeDefaults(marked.defaults);
    return marked;
};
marked.walkTokens = function(tokens, callback) {
    return markedInstance.walkTokens(tokens, callback);
};
marked.parseInline = markedInstance.parseInline;
marked.Parser = _Parser;
marked.parser = _Parser.parse;
marked.Renderer = _Renderer;
marked.TextRenderer = _TextRenderer;
marked.Lexer = _Lexer;
marked.lexer = _Lexer.lex;
marked.Tokenizer = _Tokenizer;
marked.Hooks = _Hooks;
marked.parse = marked;
export const options = marked.options;
export const setOptions = marked.setOptions;
export const use = marked.use;
export const walkTokens = marked.walkTokens;
export const parseInline = marked.parseInline;
export const parse = marked;
export const parser = _Parser.parse;
export const lexer = _Lexer.lex;
export { _defaults as defaults, _getDefaults as getDefaults } from './defaults.js';
export { _Lexer as Lexer } from './Lexer.js';
export { _Parser as Parser } from './Parser.js';
export { _Tokenizer as Tokenizer } from './Tokenizer.js';
export { _Renderer as Renderer } from './Renderer.js';
export { _TextRenderer as TextRenderer } from './TextRenderer.js';
export { _Hooks as Hooks } from './Hooks.js';
export { Marked } from './Instance.js';
