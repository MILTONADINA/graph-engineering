# Explicit provisioning only. Candidate execution never installs dependencies.
FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /opt/graph-guest
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY build-zod.mjs executor.mjs ./
RUN node build-zod.mjs
USER 65534:65534
ENV GRAPH_EVALUATION_GUEST_CONTAINER=1
ENTRYPOINT ["/usr/local/bin/node", "/opt/graph-guest/executor.mjs"]
