# Explicitly preprovision graph-engineering-verify:local before this offline build.
FROM graph-engineering-verify:local
ENV GRAPH_ENGINE_REQUIRE_GO_RUNTIME=1
COPY --from=golang@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 /usr/local/go/ /usr/local/go/
WORKDIR /opt/graph-deps
COPY tsconfig.base.json ./
COPY packages/contracts/src/ packages/contracts/src/
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/engine/src/ packages/engine/src/
COPY packages/engine/tests/context-go.test.ts packages/engine/tests/context-go.test.ts
COPY packages/engine/tests/fixtures/go-runtime/vitest.config.mjs packages/engine/vitest.go.config.mjs
RUN ./node_modules/.bin/tsc -p packages/contracts/tsconfig.json
USER 65534:65534
WORKDIR /opt/graph-deps/packages/engine
ENTRYPOINT ["node", "/opt/graph-deps/node_modules/vitest/vitest.mjs", "run", "--config", "vitest.go.config.mjs", "--configLoader", "native", "tests/context-go.test.ts"]
