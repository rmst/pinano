# Marked vendor copy

This directory vendors the runtime source of [marked](https://github.com/markedjs/marked) v15.0.12 at commit `b4eb83bbb48107720d95162ccecf829ba16be91e`.

Cerex keeps the default TUI path dependency-free and build-free, so the TypeScript upstream source is converted to plain ESM JavaScript and committed here rather than imported from `node_modules`.

Conversion used:

```sh
git clone https://github.com/markedjs/marked.git /tmp/marked-source
cd /tmp/marked-source
git checkout b4eb83bbb48107720d95162ccecf829ba16be91e
# For each src/*.ts file: node:module stripTypeScriptTypes({ mode: "transform" })
# Then rewrite relative .ts imports to .js.
```

See `LICENSE.md` for upstream license text.
