# Verification images

Every change the team makes is checked in a container with **no network**,
running as **your user ID** (not root) with `HOME=/tmp`. So the image must
already hold the language toolchain and every dependency and build plugin
the checks need, in a place that user can read. The graph never installs
anything during a check.

Build the image once, with network, from your repository; then register the
check:

```sh
docker build -t my-project-verify:local -f verify.Dockerfile .
graph-engine check-add my-project-verify:local <the check command>
```

## The reliable recipe: run the real check while building

The Maven recipe below has been exercised end to end on a real repository;
the others follow the same pattern and are starting points to adapt.

Resolving dependencies with a "download everything" command often misses
what a build uses only when it runs (test runners, compiler plugins,
report plugins). The dependable way is to run the same check once during
`docker build`, with network, so the cache holds exactly what it needs,
then make the cache readable by any user and point the tool at it.

### Maven

```dockerfile
FROM maven:3.9-eclipse-temurin-21
ENV MAVEN_ARGS="-Dmaven.repo.local=/opt/m2"
COPY . /warm
RUN cd /warm && mvn -B -q verify || true; rm -rf /warm; chmod -R a+rX /opt/m2
```

Check: `graph-engine check-add my-project-verify:local mvn -o -B -q verify`

`dependency:go-offline` alone misses the test-runner provider; the default
`~/.m2` under `/root` is not readable by the check's user, which is why the
cache moves to `/opt/m2` with `MAVEN_ARGS`.

### Gradle

```dockerfile
FROM gradle:8-jdk21
ENV GRADLE_USER_HOME=/opt/gradle-home
COPY . /warm
RUN cd /warm && gradle --no-daemon build || true; rm -rf /warm; chmod -R a+rwX /opt/gradle-home
```

Check: `graph-engine check-add my-project-verify:local gradle --offline --no-daemon build`

### Node.js

```dockerfile
FROM node:24-alpine
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci && chmod -R a+rX /deps
ENV NODE_PATH=/deps/node_modules PATH=/deps/node_modules/.bin:$PATH
```

Checks may not change the source they are given, so a check that needs
`node_modules` next to the source works on a copy:
`sh -c "cp -R . /tmp/src && cd /tmp/src && ln -s /deps/node_modules node_modules && npm test"`.
This repository's own [verification image](../infra/verification.Dockerfile)
follows the same idea.

### Python

```dockerfile
FROM python:3.13-slim
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
```

Check: `graph-engine check-add my-project-verify:local python -m pytest`

## When a check fails for the wrong reason

- **"offline mode" or "could not resolve"**: a dependency or plugin is
  missing from the image; rebuild it by running the real check during the
  build, as above.
- **"permission denied" under `/root` or `~`**: the cache is in root's home;
  move it to a readable path and point the tool at it.
- **"read-only file system"** or **"Verification changed a source
  input"**: the check writes where it may not; work on a copy in `/tmp`.

Warnings a tool prints on stderr (such as an unwritable cache log) are
harmless when the check passes; the worker sees both stdout and stderr when
it fails.
