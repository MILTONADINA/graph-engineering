FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-15
RUN useradd --uid 501 --no-create-home graphmac && useradd --uid 1001 --no-create-home graphci
WORKDIR /opt/template-deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV PATH="/usr/lib/postgresql/15/bin:${PATH}"
WORKDIR /workspace
