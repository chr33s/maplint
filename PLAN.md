# Maplint implementation roadmap

Date: 2026-10-25 · Scope: transition the working MVP into a credible Oxlint competitor, not a compatibility claim.

## Completed in this prototype

- [x] Define CLI, JSON output, six AST lint rules, per-rule severity.
- [x] Implement TypeScript content mapper protocol client and example mapper server.
- [x] Decode UTF-16 and UTF-8 content-mapper maps for lint spans; suppress unmappable diagnostics.
- [x] Accept arbitrary npm mapper packages declared in project `tsconfig.json`.
- [x] Include mapper canonical and supplemental virtual source outputs.
- [x] Add opt-in permission and optional `tsc --runExternalCode` type checking.
- [x] Add local tests for Unicode, protocol, cross-file virtual source, original-line diagnostics and CLI, including third-party package.
- [x] Migrate runtime and test sources to strict TypeScript with ESM JavaScript build output.
- [x] Validate compiled CLI, bundled mapper, and native TypeScript 7.1 typechecking end-to-end.

## Milestone 1 — validate on TypeScript 7.1 beta (highest priority)

1. Install using Node 22+ and `npm install` with `typescript@7.1.0-beta`.
2. Run `npm test` and `node dist/bin/maplint.js --project examples/demo/tsconfig.json --allow-external --typecheck`; independently run TypeScript 7.1 with `--runExternalCode`.
3. Verify TypeScript locates the workspace-linked `@maplint/embedded-mapper` package and honors the TypeScript 7.1 JSON-RPC protocol/position encoding.
4. Add golden compiler-diagnostic tests for `.vue`, `.svelte`, `.astro`, `.mdx` (via real framework-provided mappers), and UTF-8/UTF-16 discrepancies.
5. Pin an exact supported TypeScript beta if the interface changes and add CI across supported OSes.

**Gate:** mapped native TypeScript diagnostics point to the authored framework file in integration tests. No claim of full TypeScript 7.1 integration until this gate passes.

## Milestone 2 — remove transitional duplicate parsing

1. Explore `typescript/sync` and `typescript/ast` AST traversal against virtual/embedded source.
2. Migrate rules from the TypeScript 6 compatibility API if API and performance meet requirements.
3. Eliminate duplicate parsing/program work by reusing TypeScript 7.1 snapshots or exposing a shared mapped virtual AST to the rules engine.
4. Benchmark startup, memory, and steady-state incremental latency against Oxlint.

**Gate:** typed and syntax linting share a coherent source representation without loss of mapper diagnostics.

## Milestone 3 — production correctness

1. Add framework AST/templating-specific plugins rather than relying on the demo script extractor.
2. Implement source-safe `--fix` by rejecting edits that overlap synthesized or non-bijective mappings.
3. Replace simplistic suppression comments with full block/line directive semantics, including mapper-provided diagnostic directives.
4. Support TypeScript project's `extends` custom mapper merging, project references, config diagnostics, watched files and dynamic mapper identities.
5. Enforce tighter process permissions (timeouts, environment allowlist, optional isolated execution) and improve crash recovery.

**Gate:** golden rule/fix compatibility tests on real-world framework projects and fuzz testing of mappings.

## Milestone 4 — competitive lint capabilities

1. Implement dataflow/semantic rules using the TypeScript 7.1 checker and complete framework type modeling.
2. Add rule packs, per-directory configurations, ignores, plugin versioning, and machine-readable SARIF.
3. Add incremental watch/LSP and cross-project caching.
4. Establish Oxlint baseline on equivalent supported rules, synthetic workloads, and framework files.

**Gate:** reproducible external benchmark results and a documented compatibility matrix.

## Known blockers

- The content-mapper API and native TS7 AST interface are new in the 7.1 beta and may still change.
- Mappers do not implement lint rules; a rule engine is required regardless.
- Virtual ASTs may include synthesized code with no valid original span; those diagnostics must be filtered or remapped safely.
- This environment could validate Node rule tests but could not fetch/install TypeScript 7.1. No complete native 7.1 test result is claimed.