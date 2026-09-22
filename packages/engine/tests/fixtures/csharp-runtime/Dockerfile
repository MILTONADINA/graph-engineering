FROM graph-engineering-verify:local
COPY --from=mcr.microsoft.com/dotnet/sdk@sha256:78235e09001f52b6592c458ac010775ebac6725422e80cd0c1650590f67b2743 /usr/share/dotnet/ /usr/share/dotnet/
WORKDIR /opt/graph-deps
COPY tsconfig.base.json ./
COPY packages/contracts/src/ packages/contracts/src/
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/engine/src/ packages/engine/src/
COPY packages/engine/tests/context-csharp.test.ts packages/engine/tests/context-csharp.test.ts
COPY packages/engine/tests/fixtures/csharp-runtime/vitest.config.mjs packages/engine/vitest.csharp.config.mjs
RUN ./node_modules/.bin/tsc -p packages/contracts/tsconfig.json
USER 65534:65534
ENV GRAPH_ENGINE_REQUIRE_CSHARP_RUNTIME=1
WORKDIR /opt/graph-deps/packages/engine
ENTRYPOINT ["node", "/opt/graph-deps/node_modules/vitest/vitest.mjs", "run", "--config", "vitest.csharp.config.mjs", "--configLoader", "native", "tests/context-csharp.test.ts"]
