# Explicitly provision the verified binary into the rust_tool build context.
# This build performs no downloads. Runtime has no Cargo/rustc on PATH.
FROM graph-engineering-verify:local
COPY --from=rust_tool /rust-analyzer /opt/graph-rust/rust-analyzer
WORKDIR /opt/graph-deps
COPY tsconfig.base.json ./
COPY packages/contracts/src/ packages/contracts/src/
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/engine/src/ packages/engine/src/
COPY packages/engine/tests/context-rust.test.ts packages/engine/tests/context-rust.test.ts
COPY packages/engine/tests/context-rust-integration.test.ts packages/engine/tests/context-rust-integration.test.ts
COPY packages/engine/tests/fixtures/rust-runtime/vitest.config.mjs packages/engine/vitest.rust.config.mjs
RUN ./node_modules/.bin/tsc -p packages/contracts/tsconfig.json
USER 65534:65534
ENV GRAPH_ENGINE_REQUIRE_RUST_RUNTIME=1
WORKDIR /opt/graph-deps/packages/engine
ENTRYPOINT ["node", "/opt/graph-deps/node_modules/vitest/vitest.mjs", "run", "--config", "vitest.rust.config.mjs", "--configLoader", "native"]
