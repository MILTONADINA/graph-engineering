FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /opt/template-guest
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY build-ajv.mjs fixture.js executor.mjs context.json ./
RUN node build-ajv.mjs
USER 65534:65534
ENV GRAPH_TEMPLATE_GUEST=1
ENTRYPOINT ["/usr/local/bin/node", "/opt/template-guest/executor.mjs"]
