# devops.docker

**What.** A multi-stage `Dockerfile` (build stage compiles TypeScript with dev dependencies; slim `node:{{nodeVersion}}-alpine` runtime stage installs only production dependencies and copies `dist/`), `.dockerignore`, and a `docker-compose.yml` for local runs.

**When.** After `project.node-express` (and typically after the database/storage/auth nodes, since it just packages whatever `npm run build` produces — order relative to those doesn't matter to this node).

**Requires.** `project.node-express`.

**Configure via.** `port` (default 3000 — must match `project.node-express`'s `port` input, this node doesn't re-derive it), `nodeVersion` (default `20`).

**Produces.** `Dockerfile`, `.dockerignore`, `docker-compose.yml`.

**Connects to.** Downstream: `devops.github-actions` (CI builds/pushes this image), `devops.deployment` (planned — higher-level target-specific deploy).

**Validate.** `npm run build` and `docker build -t app-validate .` must both succeed.

**Security.** No `.env`/`.env.local` ever gets `COPY`'d into the image — secrets are injected at run time (`docker-compose`'s `env_file`, or your platform's secret store). The runtime stage runs as the non-root `node` user. The multi-stage split means TypeScript source and dev dependencies never reach the shipped image. `docker-compose.yml` deliberately has no bundled Postgres service — this stack targets Neon serverless; adding a local Postgres container would silently diverge from production.
