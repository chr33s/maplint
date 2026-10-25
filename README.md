# Maplint MVP

**Experimental content-mapper-aware lint runner for JavaScript/TypeScript and embedded-language files.**

Maplint is a working proof of concept, not a drop-in Oxlint replacement. It executes TypeScript **7.1 content mapper** packages, lints the **virtual JS/TS** those mappers produce, and maps diagnostics back to the original source. It can optionally invoke TypeScript 7.1's native compiler for project-wide checking using those same mappers.

**What is implemented**

- **Any compliant content mapper**, not only the bundled one: discovers mappers from `tsconfig.json`, resolves their npm package manifest, runs their JSON-RPC process (`initialize` / `openProject` / `transform` / `closeProject`), and consumes its canonical virtual code plus supplemental outputs.
- **Source spans:** exact `Verbatim` spans in UTF-16 or UTF-8, and whole-span `Atom`/`Alias` mappings. Synthetic/unmappable spans are suppressed, not guessed. Error positions point to the **original files**.
- **Six AST rules:** `no-debugger`, `no-console`, `eqeqeq`, `no-var`, `no-eval`, `no-explicit-any`. Severity configuration: `off`, `warn`, `error`.
- **Embedded example mapper** for script blocks in `.vue`, `.svelte`, `.astro`, and `.html`, including Astro frontmatter. It intentionally does **not** parse framework templates or component semantics.
- **Native TypeScript 7.1 diagnostics** via `tsc --project ... --noEmit --pretty false --runExternalCode` (`--typecheck`).
- Console/JSON output, syntax errors, suppression for `// maplint-disable-next-line RULE` and `// maplint-disable-line RULE`.
- Explicit permission gate `--allow-external` for all mapper execution, including the native compiler.

## Quick start

Requires **Node.js 22+** and access to npm. TypeScript 7.1 is currently a beta.

```sh
npm install
npm test

# Lint the supplied example (intentionally exits 1 due to a debugger statement)
node bin/maplint.mjs --project examples/demo/tsconfig.json --allow-external

# JSON diagnostics
node bin/maplint.mjs --project examples/demo/tsconfig.json --allow-external --json

# Lint + native TypeScript 7.1 type-check (requires the npm-installed 7.1 tsc)
node bin/maplint.mjs --project examples/demo/tsconfig.json --allow-external --typecheck
```

Or from the repository root, `npx --no-install maplint ...` after `npm install`. `--project` can point to a different project; positional files/directories restrict **lint** selection, but `--typecheck` always checks the full TypeScript project.

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
- Not all TypeScript 7.1 syntax is necessarily understood by the TS6 AST parser. Syntax errors in synthesized virtual code that cannot be mapped back are intentionally ignored.
- Static `tsconfig.json` content-mapper definitions are supported; there is no full `extends`-chain merging of custom mapper entries, watch mode, or project references in the Maplint rule runner. TypeScript's own `tsc` continues to honor its project semantics.
- The native TypeScript diagnostics are captured as **compiler text** (and separate in JSON output), rather than normalized into individual Maplint rule diagnostics.
- Content mappers participate in TypeScript's configured-project pipeline, not necessarily programs constructed from `createPrograms` in the new API (see [TypeScript issue #64641](https://github.com/microsoft/TypeScript/issues/64641)). Therefore this MVP invokes native `tsc -p` directly, rather than assuming API-created programs inherit mapper registrations.
- Like `tsc --runExternalCode`, mappers are **arbitrary external executables**. Only run vetted mappers; Maplint requires an explicit `--allow-external` opt-in.

## Test status (2026-10-25)

**16 local tests passed**: protocol round-trip, mapped JS/TS rules, Astro/Vue/Svelte extraction, original-source positions, Unicode UTF-8/UTF-16 maps, JSON CLI output, opt-in enforcement, a third-party mapper fixture, and mocked native-compiler invocation. The environment did **not** permit downloading and executing the published TypeScript 7.1 beta; tests of the rule engine used a locally available TypeScript 5.8 API substitute for the compatible TS6 compiler interface. Therefore the **real TypeScript 7.1 `tsc --runExternalCode` end-to-end run remains to be verified** on a machine after `npm install`.

## Layout

```text
bin/maplint.mjs                       command-line entry point
src/cli.mjs                          project scan, diagnostics, optional native compiler
src/mapper-host.mjs                  mapper package launch, RPC orchestration, span decoding
src/jsonrpc.mjs                      minimal framed JSON-RPC transport
src/linter.mjs                       AST rules, syntax diagnostics, suppression
src/config.mjs                       config discovery and npm mapper resolution
src/embedded.mjs                     demonstration framework script extractor and mappings
packages/embedded-mapper/            runnable content mapper process and manifest
examples/demo/                        Vue / Svelte / Astro example project
test/                                 integration and unit tests
DESIGN.md                             architecture/specification
PLAN.md                               implementation roadmap
```

## Upstream references

- [TypeScript 7.1 beta announcement and content mapper configuration](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [TypeScript-Go content mapper protocol](https://pkg.go.dev/github.com/microsoft/typescript-go/internal/contentmapper)
- [Third-party `ts-content-mapper` reference SDK](https://github.com/sxzz/ts-content-mapper)
- [TypeScript 6 compatibility package](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Oxlint sources / embedded PartialLoader](https://github.com/oxc-project/oxc/tree/main/crates/oxc_linter/src/loader/partial_loader)