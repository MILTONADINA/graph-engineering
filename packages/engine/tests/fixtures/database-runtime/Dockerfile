FROM graph-testing-template-test:local
WORKDIR /opt/database-deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
