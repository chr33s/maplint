# Maplint architecture specification (MVP)

Date: 2026-10-25 · Status: **implemented prototype**, **not production-ready**

## Objective

Build a small independent lint runner which consumes **TypeScript 7.1 content mapper output** (including non-JS/TS framework files) so that rules do not each need a bespoke extractor/parser. Demonstrate type-checking against the same mappers without modifying Oxlint.

The core invariant is **no invented spans**: report an issue only when the virtual file range maps back to an original source range.

## End-to-end architecture

```text
                           project tsconfig.json
                           /                  \
        contentMappers registrations        TypeScript 7.1 tsc
                     |                       (--typecheck opt-in)
                     v                              |
        node mapper JSON-RPC process                |
       initialize/openProject/transform/close       |
                     |                              |
              mapped JS/TS text                     |
              + span map tuples                native TS
              + supplemental outputs           mapped diagnostics
                     |
                 TS6 AST parser (transitional)
                     |
              six syntactic lint rules
                     |
            map virtual span -> original span
                     |
           diagnostics console / JSON output
```

Native TypeScript 7.1 and Maplint launch compliant content mappers independently, but from the **same tsconfig declaration**. Maplint's `--typecheck` delegates project semantics to the TypeScript 7.1 compiler rather than reimplementing TypeScript's full program graph. This route also avoids the currently documented limitation that API-created `createPrograms` are not automatically configured with content mappers ([TypeScript #64641](https://github.com/microsoft/TypeScript/issues/64641)).

## Modules and interfaces

| Module | Role | Implementation |
| --- | --- | --- |
| `src/cli.ts` | Parse arguments, format console/JSON output, exit code | `node:util` `parseArgs` |
| `src/engine.ts` | Orchestrate a lint run; run native `tsc` | Node.js |
| `src/project.ts` | Read `tsconfig`, rule config and file list; locate mapper manifests | TypeScript 6 config parser resolves `files`/`include`/`exclude`, matched against every lintable extension; ancestor `node_modules` lookup |
| `src/mapper-host.ts` | Spawn external mapper process, maintain `projectHandle`, validate transform output | `child_process.spawn`, one process per mapper entry |
| `src/jsonrpc.ts` | Request/response communication with mapper executable | JSON-RPC 2.0 + `Content-Length` framing |
| `src/spans.ts` | Per-text offset and line index, virtual → original span mapping | Precomputed tables, binary search |
| `src/rules.ts` | Rule registry: names, default severities, messages, detection | TypeScript 6 AST type guards |
| `src/linter.ts` | Parse each virtual output of a file, run rules, map findings, apply suppressions from all outputs | TypeScript 6 compatibility AST |
| `src/ts6.ts` | Typed lazy loader for the TypeScript 6 API | `createRequire` |
| `packages/embedded-mapper/embedded.ts` | Demonstration embedded-language source transform | Extract script blocks and Astro frontmatter |
| `packages/embedded-mapper/server.ts` | Register executable mapper with TypeScript 7.1 | JSON-RPC protocol implementation |

The TypeScript sources and tests compile with strict checking into ESM `.js` files in `dist/`. The root package's `"type": "module"` marks these emitted `.js` files as ESM; `.mjs` source extensions are therefore unnecessary.

### TypeScript content mapper lifecycle

1. Read `contentMappers: [{ package, extensions, options? }]` from the project's tsconfig.
2. Resolve `<package>/package.json` and inspect `typescript.contentMapper.exec`.
3. Require `--allow-external`, spawn the executable in its own package directory (never through a shell).
4. Send `initialize` offering `utf-16` and `utf-8`. Respect mapper-chosen encoding.
5. Send `openProject` with absolute config path, opaque handle, mapper options, and declared compiler options.
6. For every associated file, send `transform { fileName, content, projectHandle }`; consume `{text,extension,mappings,diagnostics?,supplemental?}`, validated once at the process boundary.
7. Lint canonical output and JS/TS supplemental outputs (including declarations) together, so a suppression directive in one output applies to the same original line in all; collapse duplicate diagnostics. A failed transform becomes an error diagnostic for that file.
8. Send `closeProject`; terminate the process and close the JSON-RPC connection even if linting failed.

### Span-map interpretation

Protocol mappings are tuples:

```
[virtualStart, virtualLength, originalStart, originalLength, kind, features?]
```

`kind = 0` Verbatim: source offsets map one-to-one when lengths match in the negotiated encoding. `kind = 1` Atom or `kind = 2` Alias: map the full span only, not arbitrary subranges. Gaps in virtual source have **no original position**, so corresponding lint rules are suppressed. UTF-8 positions are decoded into JS string offsets before reporting line/column. This deliberately favors correct over exhaustive diagnostics.

### Rule behavior

| Rule | Default | Detection |
| --- | --- | --- |
| `no-debugger` | error | `DebuggerStatement` |
| `no-console` | warn | `PropertyAccessExpression` with `console` receiver |
| `eqeqeq` | warn | `==`, `!=` binary operator token |
| `no-var` | warn | VariableDeclarationList lacking `let`, `const`, or `using` |
| `no-eval` | error | CallExpression on identifier `eval` |
| `no-explicit-any` | warn | `AnyKeyword` |

These are minimal syntactic rules, **not fully ESLint/Oxlint-equivalent**: e.g. shadowed `console`, permissive `eqeqeq` exceptions, and framework template scope are not evaluated.

Suppression directives (`// maplint-disable-line` and `// maplint-disable-next-line`, optionally followed by rule names) are read from comment trivia in the virtual AST and mapped back to original lines. Template markup, strings, regexes, and JSX text never act as directives, so a directive must sit inside a mapped script region.

## External code security

- Content mappers are arbitrary commands declared by installed packages.
- `--allow-external` is mandatory before launching a mapper and before running native `tsc --runExternalCode`.
- Execution uses `spawn(..., shell: false)`, the mapper's package as `cwd`, and a bounded JSON-RPC response buffer plus request timeout.
- This is a **permission gate, not a sandbox**. Use only trusted mapper packages.
- Mapper stderr is captured as errors; stdout must remain framed protocol traffic.

## CLI output contract

`maplint --project <path> [paths...] [--allow-external] [--typecheck] [--json]`.

- Exit `0`: no lint errors and native compiler successful (if invoked).
- Exit `1`: one or more lint errors or native compiler failure.
- Exit `2`: invalid configuration, missing dependencies or mapper failure.
- JSON: `{ files, errors, warnings, diagnostics, compiler? }`.
- Native `compiler.output` preserves TypeScript 7.1 CLI diagnostics; it does not yet normalize them into the same shape as Maplint rule diagnostics.

## Test evidence and acceptance criteria

Locally validated 2026-10-26: the unit/integration suite passes after strict TypeScript compilation using Node 22 and TypeScript 7.1. Tests cover a third-party mapper and UTF-8, original Vue and Astro source spans, controls and suppressed synthetic spans, suppression directives in framework files, teardown of a mapper that fails its handshake, CLI exit codes, errors and a mock `tsc` command preserving `--runExternalCode`. The compiled CLI and bundled mapper successfully ran against the TypeScript 7.1 beta.

Not validated locally: TypeScript 7.1 editor support, framework-specific type soundness, performance relative to Oxlint.

Preproduction gate: add golden fixtures for third-party real Vue/Svelte/Astro content mapper implementations and test cross-platform compiler behavior.

## Boundaries

- **In scope:** virtual JS/TS linting from arbitrary protocol-compliant mappers, safe remapping, core AST checks, optional TypeScript 7.1 compiler execution.
- **Out of scope:** full Oxlint rule parity, full framework grammars, symbol-resolved ESLint equivalents, edits/autofix mapping, arbitrary code safety sandboxing, incremental project graph, watch/LSP.

See [PLAN.md](PLAN.md) for a scoped path from prototype to a serious tool.