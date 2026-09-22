FROM node:24-bookworm
WORKDIR /opt/graph-deps
COPY package.json package-lock.json ./
COPY create-graph-app/package.json create-graph-app/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
RUN npm ci --no-audit --no-fund
COPY graph-templates/tools/validate-graph/package.json graph-templates/tools/validate-graph/package-lock.json graph-templates/tools/validate-graph/
RUN npm ci --prefix graph-templates/tools/validate-graph --no-audit --no-fund
COPY scripts/verify-project.mjs /opt/verify-project.mjs
WORKDIR /workspace
CMD ["node", "/opt/verify-project.mjs"]
