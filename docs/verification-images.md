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

Everything after the image is stored as the check's command exactly as
typed, including its own options and `--` (`make -C sub test`,
`mvn -B -V verify`, `npm test -- --run`). Put graph-engine's own options,
such as `-C <project>`, before `check-add`. Add checks before you plan: a
plan keeps the checks configured when it was created, so a plan made before
any `check-add` cannot run, and you create a new plan once checks exist.

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

### Dart

A starting point until exercised end to end.

```dockerfile
# Pin the tag's digest: `docker buildx imagetools inspect dart:3.13` prints it.
FROM dart:3.13@sha256:<digest>
ENV PUB_CACHE=/opt/pub-cache
COPY . /warm
RUN cd /warm && dart pub get --enforce-lockfile && { dart test || true; } \
 && cd / && rm -rf /warm && chmod -R a+rX /opt/pub-cache \
 && mkdir -p /opt/pub-cache/active_roots && chmod -R a+rwX /opt/pub-cache/active_roots
```

Check: `graph-engine check-add my-project-verify:local sh -c "cp -R . /tmp/src && cd /tmp/src && dart pub get --offline --enforce-lockfile && dart test"`

pub writes `.dart_tool/` next to the source, so the check works on a copy,
and `--enforce-lockfile` fails rather than resolve anything but the
committed `pubspec.lock`. pub also records every package it resolves under
`$PUB_CACHE/active_roots`: with that directory read-only,
`dart pub get --offline --enforce-lockfile` resolves and still exits 66
(seen with Dart 3.13.3), so that one directory is writable by every user
and the rest of the cache stays read-only.

### Flutter

A starting point until exercised end to end.

The documentation-only [toy widget fixture](flutter-widget-fixture.md) supplies
synthetic package, widget and test snippets. Prepare and review a real lockfile
with the selected SDK before using this recipe; no Flutter run is claimed by
the fixture or these instructions.

```dockerfile
# Pin the tag's digest: `docker buildx imagetools inspect debian:trixie-slim` prints it.
FROM debian:trixie-slim@sha256:<digest>
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
ARG FLUTTER_ARCHIVE
ARG FLUTTER_SHA256
ARG CHECK_UID
RUN curl -fsSL -o /tmp/flutter.tar.xz "https://storage.googleapis.com/flutter_infra_release/releases/${FLUTTER_ARCHIVE}" \
 && echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/flutter.tar.xz -C /opt && rm /tmp/flutter.tar.xz
ENV PATH=/opt/flutter/bin:$PATH PUB_CACHE=/opt/pub-cache FLUTTER_SUPPRESS_ANALYTICS=true
RUN git config --system --add safe.directory /opt/flutter && dart --disable-analytics
COPY . /warm
RUN cd /warm && flutter pub get --enforce-lockfile && { flutter test || true; } \
 && cd / && rm -rf /warm && chmod -R a+rX /opt/pub-cache \
 && mkdir -p /opt/pub-cache/active_roots && chmod -R a+rwX /opt/pub-cache/active_roots \
 && chown -R "$CHECK_UID" /opt/flutter
```

Build it with a release's `archive` path and `sha256` from the SDK's
published
[`releases_linux.json`](https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json)
(pick one whose `dart_sdk_arch` matches the machine Docker runs on) and
with the user ID the check runs as:

```sh
docker build -t my-project-verify:local -f verify.Dockerfile \
  --build-arg FLUTTER_ARCHIVE=stable/linux/flutter_linux_<version>-stable.tar.xz \
  --build-arg FLUTTER_SHA256=<sha256> --build-arg CHECK_UID="$(id -u)" .
```

Check: `graph-engine check-add my-project-verify:local sh -c "cp -R . /tmp/src && cd /tmp/src && flutter pub get --offline --enforce-lockfile && flutter test --no-pub"`

The Flutter tool writes into its own SDK directory, so the SDK belongs to
the check's user ID. `safe.directory` lets Git read the SDK's checkout
whoever owns it, which the build's root user needs as well.
`FLUTTER_SUPPRESS_ANALYTICS` turns the Flutter tool's analytics off for
every user, including the check's user, whose `HOME` is an empty `/tmp`;
`dart --disable-analytics` records the Dart tool's choice only in the
building user's home, and the check itself has no network. As with Dart,
the check works on a copy because pub writes `.dart_tool/`, `--no-pub`
keeps `flutter test` from running pub again, and pub needs
`$PUB_CACHE/active_roots` writable.

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
