FROM graph-frontend-template-test:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 openssl
RUN if ! getent passwd 501 >/dev/null; then useradd --uid 501 --no-create-home graphmac; fi && if ! getent passwd 1001 >/dev/null; then useradd --uid 1001 --no-create-home graphci; fi
WORKDIR /opt/backend-deps
COPY fullstack-runtime/backend/package.json fullstack-runtime/backend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"
WORKDIR /workspace
