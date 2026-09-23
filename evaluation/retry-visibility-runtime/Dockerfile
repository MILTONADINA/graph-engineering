FROM node@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7
ENV npm_config_update_notifier=false
WORKDIR /opt/retry/source
COPY snapshot/ ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run build:dependencies \
  && npm run build -w @graph-engineering/engine
COPY runtime/ /opt/retry/runtime/
COPY source-manifest.json /opt/retry/source-manifest.json
RUN node /opt/retry/runtime/provision-check.mjs
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/retry/runtime/execute.mjs"]
