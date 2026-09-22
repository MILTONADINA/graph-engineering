# Isolated Rust declaration-binding proof

This fixture provisions **rust-analyzer 0.3.3057-standalone**, official release
`2026-09-21`. It uses stable LSP `textDocument/definition` LocationLinks, not
rustc diagnostics, unstable compiler/HIR dumps, or name-based binding guesses.
The evidence engine is `rust-analyzer`; this is **not a full compiler check**.

## Provision and run

The explicit provisioning script downloads one fixed official release asset,
checks its pinned archive SHA256, decompresses with a size bound, then checks
the binary SHA256. It refuses to overwrite a binary. Nothing is installed
globally or added to PATH; binaries/cache must not be committed.

Preprovision `graph-engineering-verify:local`, then from the repository root:

```sh
RUST_FIXTURE_TOOLS=$(mktemp -d)
node packages/engine/tests/fixtures/rust-runtime/provision.mjs arm64 "$RUST_FIXTURE_TOOLS"
docker buildx build --load --pull=false --network=none \
  --build-context rust_tool="$RUST_FIXTURE_TOOLS" \
  -f packages/engine/tests/fixtures/rust-runtime/Dockerfile \
  -t graph-rust-native-test:local .
docker run --rm --network=none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --memory=1g --cpus=2 --pids-limit=128 \
  --cap-drop=ALL --security-opt=no-new-privileges graph-rust-native-test:local
```

Use `x64` instead of `arm64` on Linux x86-64 CI. The image requires its native
runtime; silently skipping every native test is an error. Provisioning needs
network access; image build and test execution do not. Only the Docker fixture
is supported at this checkpoint: the engine discovers the exact verified binary
at `/opt/graph-rust/rust-analyzer` on Linux. macOS and Windows explicitly report
syntax-only fallback. Runtime indexing never provisions or downloads anything.

| Architecture | Official gzip SHA256                                               | Expanded binary SHA256                                             |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Linux ARM64  | `32a75657041a7a2ebf635c1e3968753e2639778b68dd4fb13c4b2584255f2ba8` | `6d7a24eafea0f5a1d3b624b6dfe162931d5aa2a1117e69b8f90f3cbf22bc72b2` |
| Linux x86-64 | `b2d24ce2bda2ea05b1ad7c2917d205f8111775f703ccd908e6061803ae8257d0` | `10d555c6a8dbae1e24092407eef81c698930e55c8eed31de763dd25226fd5c44` |

## Deliberately bounded semantics

Each run receives a detached, hash-checked snapshot, materializes only its Rust
files in an owned temporary directory, and constructs its own non-Cargo crate
graph using edition 2021. All selected Rust files appear in every promoted
edge's provenance, including intermediate and unrelated private sources.
Source hashes are rechecked after analysis. Runtime identity is immutable;
caller-provided records cannot change the executable after validation.

Supported targets are explicit free functions without type parameters or
argument-position `impl Trait`. Direct/qualified calls and simple `use` aliases
and reexports must return one exact origin/name/full-declaration span matching
the indexed AST. Methods, trait/impl targets, function values, closures and
generic targets are not promoted. This is declaration navigation, not a proof
that the selected code compiles or executes successfully.

The preflight refuses macros, attributes (including cfg/path/derive/inner crate
attributes), external crates, foreign blocks, build.rs, grouped/wildcard/anonymous
imports, duplicate item/import bindings, ambiguous/missing modules, and files
owned by multiple crate contexts. Standard lib.rs/main.rs/mod.rs roots may own
external modules; arbitrary standalone root files may not. lib.rs/main.rs may
not be reused as submodules. Unsupported input retains syntax evidence instead
of guessing which compiler configuration or crate context applies.

No repository Cargo manifest, `.cargo` config, rust-analyzer config, build
script, plugin or proc macro is copied or evaluated. The client explicitly
disables Cargo autoreload/build scripts, proc macros, check-on-save, workspace
discovery, sysroot discovery, and test cfg. Its empty environment uses owned
config/cache/toolchain directories and a nonexistent PATH. It refuses all
server-initiated operations, including command execution and workspace edits.

Bounds: 64 files, 4 MiB source, 100,000 syntax nodes, 1,000 definition queries,
2 MiB total protocol/stderr output, and a monotonic 10-second analysis deadline.
An RSS watchdog kills sustained usage over 512 MiB; it is not an instantaneous
memory ceiling. The offline fixture additionally enforces a 1 GiB container
memory limit. The adapter itself is not an OS sandbox: this checkpoint's Linux
container provides the tested filesystem/network/process boundary.

## Evidence

The first small probe used the existing official Rust 1.85 image pinned to
`sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4`.
With networking disabled, read-only mounts, and no tools on PATH, `alias()` in
lib.rs resolved through `use helpers::target as alias` to helpers.rs's exact
function span. `probe.mjs` reproduces that ARM64-only capability check using a
previously verified binary; it is not the main adapter test suite.

The native suite additionally covers nested reexports, Unicode UTF-16 offsets,
closure/method/generic abstention, mandatory private provenance, immutable
runtime/getter safety, malformed protocol, unsupported source constructs,
resource limits, and a filesystem canary proving target function bodies are
not executed by that test. The canary is not a general sandbox proof.

The context integration additionally checks persisted bindings, snapshot reuse
and invalidation, complete private-source provenance, cloud export filtering and
historical exclusion changes. The combined Linux ARM64 fixture passed 34 tests;
the unavailable-runtime-only test skipped because its required analyzer was
present. Host tests cover that explicit missing-runtime fallback separately.

Primary references: [non-Cargo project format](https://rust-analyzer.github.io/book/non_cargo_based_projects.html),
[configuration controls](https://rust-analyzer.github.io/book/configuration.html),
[LSP vs internal API stability](https://rust-analyzer.github.io/book/contributing/architecture.html#stability-guarantees),
[official release](https://github.com/rust-lang/rust-analyzer/releases/tag/2026-09-21).
