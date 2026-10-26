# Maplint MVP

**Experimental TypeScript content-mapper-aware lint runner for JavaScript/TypeScript and embedded-language files.**

Maplint is a working proof of concept, not a drop-in Oxlint replacement. It executes TypeScript **7.1 content mapper** packages, lints the **virtual JS/TS** those mappers produce, and maps diagnostics back to the original source. It can optionally invoke TypeScript 7.1's native compiler for project-wide checking using those same mappers.

**What is implemented**

- **Any compliant content mapper**, not only the bundled one: discovers mappers from `tsconfig.json`, resolves their npm package manifest, runs their JSON-RPC process (`initialize` / `openProject` / `transform` / `closeProject`), and consumes its canonical virtual code plus supplemental outputs.
- **Source spans:** exact `Verbatim` spans in UTF-16 or UTF-8, and whole-span `Atom`/`Alias` mappings. Synthetic/unmappable spans are suppressed, not guessed. Error positions point to the **original files**.
- **Six AST rules:** `no-debugger`, `no-console`, `eqeqeq`, `no-var`, `no-eval`, `no-explicit-any`. Severity configuration: `off`, `warn`, `error`.
- **Embedded example mapper** for script blocks in `.vue`, `.svelte`, `.astro`, and `.html`, including Astro frontmatter. It intentionally does **not** parse framework templates or component semantics.
- **Native TypeScript 7.1 diagnostics** via `tsc --project ... --noEmit --pretty false --runExternalCode` (`--typecheck`).
- Console/JSON output, syntax errors, suppression for `// maplint-disable-next-line RULE` and `// maplint-disable-line RULE` (read from comments in the mapped code, so they must sit inside a script region).
- Explicit permission gate `--allow-external` for all mapper execution, including the native compiler.

## Quick start

Requires **Node.js 22+** and access to npm. TypeScript 7.1 is currently a beta.

```sh
npm install
npm run build
npm test

# Lint the supplied example (intentionally exits 1 due to a debugger statement)
node dist/bin/maplint.js --project examples/demo/tsconfig.json --allow-external

# JSON diagnostics
node dist/bin/maplint.js --project examples/demo/tsconfig.json --allow-external --json

# Lint + native TypeScript 7.1 type-check (requires the npm-installed 7.1 tsc)
node dist/bin/maplint.js --project examples/demo/tsconfig.json --allow-external --typecheck
```

`npm test` also builds before running the compiled tests. From the repository root, `npx --no-install maplint ...` works after `npm run build`. `--project` can point to a different project; without paths, Maplint lints every JS/TS and mapped file that the tsconfig's `files`/`include`/`exclude` (and `extends`) match, regardless of `allowJs`, skipping build output directories such as `dist`, `build` and `coverage`. Positional files/directories restrict **lint** selection, but `--typecheck` always checks the full TypeScript project.

To run TypeScript 7.1 directly against the same content mapper:

```sh
./node_modules/.bin/tsc -p examples/demo/tsconfig.json --noEmit --runExternalCode
```

This is a native content mapper integration, not hand-written preprocessing for the type-checking pass.

## Configure another content mapper

Install the mapper package and put an entry like the following in your project's `tsconfig.json`:

```json
{
  "compilerOptions": { "noEmit": true, "strict": true },
  "contentMappers": [
    { "package": "your-content-mapper", "extensions": [".special"] }
  ],
  "include": ["src"]
}
```

The installed mapper package must publish a `typescript.contentMapper.exec` in its `package.json` and implement the TypeScript 7.1 content-mapper JSON-RPC protocol. Maplint negotiates UTF-16/UTF-8 and asks the mapper for virtual source. If a virtual range has no safe original mapping, Maplint **does not** report a potentially incorrect lint location.

Set rule severities in `maplint.config.json` beside `tsconfig.json`:

```json
{
  "rules": {
    "no-console": "off",
    "no-debugger": "error",
    "eqeqeq": "warn"
  }
}
```

Example output:

```text
examples/demo/src/App.vue:3:14 warn [no-explicit-any] Avoid explicit any type
examples/demo/src/App.vue:4:1 warn [no-console] Unexpected console access
examples/demo/src/App.vue:5:11 warn [eqeqeq] Use strict equality (=== or !==)
examples/demo/src/App.vue:6:3 error [no-debugger] Unexpected debugger statement
...
maplint: 4 file(s), 1 lint error(s), 6 warning(s)
```

## Why TypeScript 6 is still included

Content mappers **transform and map** source. They do not provide the lint rules themselves. This MVP deliberately uses the published `@typescript/typescript6` compatibility API as an **AST-only** rule engine, while `typescript@7.1.0-beta` handles TypeScript's native program and content-mapper type checking. This is a transitional architecture; migrating rule traversal to the new `typescript/ast` and `typescript/sync` APIs is listed in [PLAN.md](PLAN.md).

## Limitations

- **Not an Oxlint replacement yet:** only 6 basic rules, no symbol-aware rule fidelity, rule plugins, autofixes, watch/LSP, caches, or performance guarantees. This is not a benchmark against Oxlint.
- The bundled extractor handles **script blocks only** (plus Astro frontmatter), not Vue/Svelte/Astro component template expressions, framework macros, scope semantics, attributes, or style languages. It is a *demo mapper*, not a framework compiler.
- Other mapper packages' virtual JS/TS gets rule-checked; native TypeScript handles their type-checking. Mapper-specific `diagnosticDirectives`, edits, and advanced features are not integrated with Maplint's rule runner.
- Not all TypeScript 7.1 syntax is necessarily understood by the TS6 AST parser. A syntax error in synthesized virtual code is reported at the end of the mapped source before it (usually its cause, such as an unclosed script block); one before any mapped source is ignored.
- `contentMappers` follow `extends` as in TypeScript 7.1: a config's own entry (or `null`) replaces inherited ones, and among several bases the last one wins. There is no watch mode or project-reference support in the Maplint rule runner. TypeScript's own `tsc` continues to honor its project semantics.
- A failed `transform` (mapper error, timeout or crash) is reported as an error in that file and the rest of the project is still linted; a mapper that exited is restarted.
- The native TypeScript diagnostics are captured as **compiler text** (and separate in JSON output), rather than normalized into individual Maplint rule diagnostics.
- Content mappers participate in TypeScript's configured-project pipeline, not necessarily programs constructed from `createPrograms` in the new API (see [TypeScript issue #64641](https://github.com/microsoft/TypeScript/issues/64641)). Therefore this MVP invokes native `tsc -p` directly, rather than assuming API-created programs inherit mapper registrations.
- Like `tsc --runExternalCode`, mappers are **arbitrary external executables**. Only run vetted mappers; Maplint requires an explicit `--allow-external` opt-in.

## Test status

See [DESIGN.md](DESIGN.md#test-evidence-and-acceptance-criteria) for what the suite covers and what has been validated against TypeScript 7.1.

## Layout

Source modules are described in [DESIGN.md](DESIGN.md#modules-and-interfaces). `packages/embedded-mapper/` is the runnable demo mapper, `examples/demo/` a Vue/Svelte/Astro example project, `test/` the unit and integration tests, and `dist/` the emitted ESM build.

## Upstream references

- [TypeScript 7.1 beta announcement and content mapper configuration](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [TypeScript-Go content mapper protocol](https://pkg.go.dev/github.com/microsoft/typescript-go/internal/contentmapper)
- [Third-party `ts-content-mapper` reference SDK](https://github.com/sxzz/ts-content-mapper)
- [TypeScript 6 compatibility package](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Oxlint sources / embedded PartialLoader](https://github.com/oxc-project/oxc/tree/main/crates/oxc_linter/src/loader/partial_loader)