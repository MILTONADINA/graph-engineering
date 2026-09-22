# Preprovision both images explicitly. Build and generated execution need no network.
FROM graph-engineering-verify:local
ENV GRAPH_ENGINE_REQUIRE_JAVA_RUNTIME=1
COPY --from=eclipse-temurin@sha256:92a2a4d7a928d057e7bd999c418d66c26a34eb9a0442f3ab67721c3f88110b2d /opt/java/openjdk/ /opt/java/openjdk/
WORKDIR /opt/graph-deps
COPY tsconfig.base.json ./
COPY packages/contracts/src/ packages/contracts/src/
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/engine/src/ packages/engine/src/
COPY packages/engine/tests/context-java.test.ts packages/engine/tests/context-java.test.ts
COPY packages/engine/tests/fixtures/java-runtime/vitest.config.mjs packages/engine/vitest.java.config.mjs
RUN ./node_modules/.bin/tsc -p packages/contracts/tsconfig.json
USER 65534:65534
WORKDIR /opt/graph-deps/packages/engine
ENTRYPOINT ["node", "/opt/graph-deps/node_modules/vitest/vitest.mjs", "run", "--config", "vitest.java.config.mjs", "--configLoader", "native", "tests/context-java.test.ts"]
