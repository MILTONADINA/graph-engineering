# A live security target: the Express app the graph's own templates generate
# (project.node-express composed with backend.error-handler). Build it with
# `npm run live-target:build`, which renders the templates into a private
# build context with the reviewed lockfile; this file is not built directly.
FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json \
  && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/app.js"]
