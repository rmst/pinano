// Vendored from marked v15.0.12 (MIT)
// Upstream: https://github.com/markedjs/marked/tree/b4eb83bbb48107720d95162ccecf829ba16be91e
// Converted from TypeScript with Node's stripTypeScriptTypes; relative .ts imports rewritten to .js.

import { other } from './rules.js';
const escapeReplacements = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};
const getEscapeReplacement = (ch)=>escapeReplacements[ch];
export function escape(html, encode) {
    if (encode) {
        if (other.escapeTest.test(html)) {
            return html.replace(other.escapeReplace, getEscapeReplacement);
        }
    } else {
        if (other.escapeTestNoEncode.test(html)) {
            return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
        }
    }
    return html;
}
export function unescape(html) {
    return html.replace(other.unescapeTest, (_, n)=>{
        n = n.toLowerCase();
        if (n === 'colon') return ':';
        if (n.charAt(0) === '#') {
            return n.charAt(1) === 'x' ? String.fromCharCode(parseInt(n.substring(2), 16)) : String.fromCharCode(+n.substring(1));
        }
        return '';
    });
}
export function cleanUrl(href) {
    try {
        href = encodeURI(href).replace(other.percentDecode, '%');
    } catch  {
        return null;
    }
    return href;
}
export function splitCells(tableRow, count) {
    const row = tableRow.replace(other.findPipe, (match, offset, str)=>{
        let escaped = false;
        let curr = offset;
        while(--curr >= 0 && str[curr] === '\\')escaped = !escaped;
        if (escaped) {
            return '|';
        } else {
            return ' |';
        }
    }), cells = row.split(other.splitPipe);
    let i = 0;
    if (!cells[0].trim()) {
        cells.shift();
    }
    if (cells.length > 0 && !cells.at(-1)?.trim()) {
        cells.pop();
    }
    if (count) {
        if (cells.length > count) {
            cells.splice(count);
        } else {
            while(cells.length < count)cells.push('');
        }
    }
    for(; i < cells.length; i++){
        cells[i] = cells[i].trim().replace(other.slashPipe, '|');
    }
    return cells;
}
export function rtrim(str, c, invert) {
    const l = str.length;
    if (l === 0) {
        return '';
    }
    let suffLen = 0;
    while(suffLen < l){
        const currChar = str.charAt(l - suffLen - 1);
        if (currChar === c && !invert) {
            suffLen++;
        } else if (currChar !== c && invert) {
            suffLen++;
        } else {
            break;
        }
    }
    return str.slice(0, l - suffLen);
}
export function findClosingBracket(str, b) {
    if (str.indexOf(b[1]) === -1) {
        return -1;
    }
    let level = 0;
    for(let i = 0; i < str.length; i++){
        if (str[i] === '\\') {
            i++;
        } else if (str[i] === b[0]) {
            level++;
        } else if (str[i] === b[1]) {
            level--;
            if (level < 0) {
                return i;
            }
        }
    }
    if (level > 0) {
        return -2;
    }
    return -1;
}
