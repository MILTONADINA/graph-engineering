FROM node:24-bookworm
WORKDIR /opt/template-deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
