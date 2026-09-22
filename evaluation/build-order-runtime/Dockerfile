FROM node@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7
ENV npm_config_update_notifier=false
WORKDIR /opt/build-order/source
COPY snapshot/ ./
# Network is permitted only during explicit provisioning. No repository or
# dependency lifecycle scripts execute at installation time.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY runtime/ /opt/build-order/runtime/
COPY source-manifest.json /opt/build-order/source-manifest.json
RUN node /opt/build-order/runtime/provision-check.mjs
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/build-order/runtime/container.mjs"]
