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

An optional initial `--` after the image separates registration options from
the command and is removed. The command and every argument after it are stored
exactly as typed, including command-owned options and later `--` arguments
(`make -C sub test`, `mvn -B -V verify`, `npm test -- --run`). Put global
graph-engine options, such as `-C <project>`, before `check-add`; put the
registration metadata options described below before the image. Add checks before you plan: a
plan keeps the checks configured when it was created, so a plan made before
any `check-add` cannot run, and you create a new plan once checks exist.

## Selecting optional checks for one plan

Per-plan selection was released in
[PR #123](https://github.com/MILTONADINA/graph-engineering/pull/123) at
`104accacf0c4389699bfab3f32140095e13654fa`; its verification record contains
the exact checked head, matching merged tree and all nine passing CI jobs.

Checks are mandatory by default. An operator can assign stable catalogue IDs
and explicitly mark a check optional when registering it:

```sh
graph-engine check-add --id lint toy-verify:local npm run lint
graph-engine check-add --id unit --optional toy-verify:local npm test
graph-engine check-add --id integration --optional toy-verify:local npm run integration
```

Put `--id` and `--optional` **after `check-add`, before the image**. After the
optional initial `--` separator, the command's arguments remain unchanged,
including later `--` arguments and flags with those same names. IDs are
case-sensitive, unique, and 1–80 characters: an ASCII letter or digit followed
by letters, digits, `_` or `-`. They are operator-assigned names, not array
positions, file paths or commands. `optional: true` requires an ID; an omitted
or false `optional` field means mandatory.

Select a complete set of checks with repeatable scalar `--check` options:

```sh
graph-engine plan "Update toy module" --accept "The module meets its contract" --check lint --check unit
graph-engine plan --spec specs/toy/module.md --check lint --check integration
```

Omitting `--check` still selects **every** configured check, including optional
ones. Explicit selection must name every mandatory check and may add any
optional checks. An optional check that is selected becomes required for that
plan's success; its failures are never ignored. Execution follows catalogue
order, not argument order. Unknown IDs, duplicates, empty selections, omitted
mandatory IDs and selection from a partly unnamed catalogue are refused.
At most 1,000 IDs can be selected explicitly. A selection never changes the
project catalogue, verification command, image, network boundary or working set.

Existing unnamed checks remain valid for all-check planning, including
duplicate unnamed descriptors. To adopt explicit selection, an operator adds
reviewed unique IDs to **every** existing catalogue entry in
`.graph/project.json`; do not register duplicate replacement commands merely
to assign names. Mark only intentionally omittable checks optional. No migration
or weakening of existing checks occurs automatically.

Tool-neutral engine input, MCP `plan_create` and HTTP `POST /api/plans` accept
the same optional `checkIds: string[]`. Omission means all; input `null` is
invalid. These interfaces resolve IDs against operator-registered commands;
they do not accept new command descriptors or catalogue changes from a model.
MCP responses do not disclose the registered image/argument descriptors.

Every new plan freezes its full resolved `verification` descriptors plus:

```json
{
  "verificationSelection": {
    "catalogueSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "checkIds": ["lint", "unit"]
  }
}
```

The hash above is illustrative. `checkIds: null` in a **stored binding** means
the plan selected all checks; it is distinct from omitting the binding on a
legacy plan. `catalogueSha256` covers the entire ordered catalogue, including
unselected optional entries, ID/optional-field presence, images and exact argv
order. Reordering JSON object keys alone does not change that identity.
The engine exports `verificationCatalogueSha256(catalogue)`. Its exact
canonical input is the strictly validated, parsed catalogue, without inserting
ID or optional defaults:

```js
const canonical = JSON.stringify(
  catalogue.map((check) => [
    Object.hasOwn(check, "id"),
    check.id ?? null,
    Object.hasOwn(check, "optional"),
    check.optional ?? null,
    check.image,
    check.argv,
  ]),
);
// SHA-256 of canonical's UTF-8 bytes, lowercase hex, no appended newline.
```

The image field binds the configured image text; it is not itself container
content attestation. The full plan retains the caller's `checkIds` order even
though execution follows catalogue order. Local verification results include
`checkId` for named checks; legacy unnamed results omit it. Like other check
results, this identifies the observed check, not human acceptance.

`plan-approve` shows both the binding and full resolved descriptors, and the
existing full-plan SHA and approval cover them. Selection does not grant
approval or alter publication policy.

Start and acknowledged resume refuse changed catalogues or inconsistent
retained descriptors, including changes to an unselected optional check.
Create and review a fresh plan; neither resume nor reapproval rewrites the old
binding. Legacy plans without `verificationSelection` keep their old all-check
behavior only while both their retained checks and the current catalogue have
no `id` or `optional` metadata. Adding metadata, even `optional: false`, requires
a fresh plan. Required security/reviewer gates are independent of this selector
and cannot be disabled by omitting an optional verification check.

See the [verification-selection spec](../specs/quality/verification-selection.md)
for acceptance criteria and verification status. Container provisioning and
check execution keep the same requirements below; selection does not download
dependencies or permit network access during verification.

## Execution deadlines

The optional policy field `verificationTimeoutSeconds` controls the built-in
container verification command, independently of installed-worker deadlines:

| Value              | Each verification command                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Absent             | Inherit `policy.timeoutSeconds`, preserving existing bounded behavior.                                      |
| Integer `1..86400` | Use that many seconds as its wall-clock limit.                                                              |
| `null`             | Wait for terminal completion, explicit cancellation or another existing guard; no fixed execution deadline. |

This field is not added to the default policy. An operator may add it to a
**complete reviewed policy document** and apply that document before planning:

```sh
graph-engine policy --file reviewed-policy.json
graph-engine plan "Update toy module" --accept "The module meets its contract"
graph-engine plan-status <planId>
graph-engine plan-approve <planId> --yes --expect <stored-plan-SHA>
graph-engine run <planId>
```

The reviewed document contains `"verificationTimeoutSeconds": null` only when
that mode is intended; preserve its other fields. Do not pass a partial policy
or change a budget, approval or export rule merely to select a deadline. The
existing CLI, MCP and HTTP run interfaces use the same operator-configured
policy; they provide no per-run override to weaken it. Adding, removing or
changing the field changes the policy hash and requires a fresh plan and any
required approval. Reapproving or resuming an old plan does not rewrite its
policy binding.

The resolved timeout is captured before asynchronous verification work and
applies separately to each selected command, not to the whole run. `null`
reaches the normal built-in verifier; no replacement hook is needed. It is
neither an inactivity watchdog nor a guarantee that a command is healthy.
Output does not reset a finite timer. A hung check can wait until an operator
uses `graph-engine cancel <runId>`; tools inside the container may also enforce
their own limits.

Every selected check must still finish successfully before verification passes.
Nonzero exits, output overflow, cancellation, changed inputs and uncertain
execution cannot authorize success or publication. Container isolation,
network denial, resource bounds, output limits, image inspection and cleanup
timeouts remain in force. Native worker, API/local inference, generator,
reviewer and security-scan deadlines are unchanged by this field.

Cancellation requests terminate the process and attempt container cleanup;
cleanup is best-effort, not proof that a container is absent. Dead-owner runs
require explicit reconciliation, not reattachment to an old check. Inspect the
retained workspace and execution state before an acknowledged resume; do not
infer a successful check from an interrupted run. Resume keeps the existing
approval, policy, snapshot and required-check guards.

See the [verification-deadline spec](../specs/quality/verification-deadlines.md)
for evidence and release status. This new opt-in is separate from the already
released check selector; its feature PR must record required CI and merge
before a consumer adopts it.

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
