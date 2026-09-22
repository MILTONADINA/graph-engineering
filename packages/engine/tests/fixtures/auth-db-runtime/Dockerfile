FROM graph-testing-template-test:local
WORKDIR /opt/template-deps
COPY backend-runtime/package.json backend-runtime/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
