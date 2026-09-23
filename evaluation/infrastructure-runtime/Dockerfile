FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /opt/infrastructure-guest
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY history/ ./history/
COPY context.json build-store.mjs ./
RUN node build-store.mjs
COPY executor.mjs service-controller.mjs service-fixture.js service-harness.js setup-controller.mjs setup-fixture.js setup-executor.mjs ./
USER 65534:65534
ENV GRAPH_INFRASTRUCTURE_GUEST=1
ENTRYPOINT ["/usr/local/bin/node", "/opt/infrastructure-guest/executor.mjs"]
