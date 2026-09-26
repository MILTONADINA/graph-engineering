# Offline security scanners for `graph-engine security-scan`.
# Building needs network access; scans run with --network=none.
# Pinned: the base image by digest, the gitleaks and hadolint binaries by
# version and SHA-256, semgrep and checkov by version (their Python
# dependencies are resolved at build time), and the Semgrep rules by commit.
# The rules use the Semgrep Rules License v1.0, which limits redistributing
# this image; build it locally rather than publishing it.
FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG HADOLINT_VERSION=2.15.1
ARG HADOLINT_SHA256_AMD64=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
ARG HADOLINT_SHA256_ARM64=f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d
ARG SEMGREP_VERSION=1.178.0
ARG CHECKOV_VERSION=3.3.19
# Semgrep Rules at a reviewed commit, so scans need no registry access.
ARG SEMGREP_RULES_COMMIT=a84ff9cc2453ca91d581380de4b8b3f272f6f4be

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) gl_arch=x64; gl_sum="$GITLEAKS_SHA256_AMD64"; hl_arch=x86_64; hl_sum="$HADOLINT_SHA256_AMD64" ;; \
    arm64) gl_arch=arm64; gl_sum="$GITLEAKS_SHA256_ARM64"; hl_arch=arm64; hl_sum="$HADOLINT_SHA256_ARM64" ;; \
    *) echo "unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/gitleaks.tgz \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz"; \
  echo "${gl_sum}  /tmp/gitleaks.tgz" | sha256sum -c -; \
  tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks; \
  curl -fsSL -o /usr/local/bin/hadolint \
    "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-${hl_arch}"; \
  echo "${hl_sum}  /usr/local/bin/hadolint" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/hadolint; \
  rm -f /tmp/gitleaks.tgz

RUN pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" "checkov==${CHECKOV_VERSION}"

# Keep only language rule sets; drop tests and fixtures that would scan as code.
RUN set -eu; \
  git clone --filter=blob:none https://github.com/semgrep/semgrep-rules /tmp/rules; \
  git -C /tmp/rules checkout --quiet "${SEMGREP_RULES_COMMIT}"; \
  mkdir -p /opt/semgrep-rules; \
  for dir in bash c csharp dockerfile go java javascript kotlin php python ruby rust scala swift terraform typescript yaml; do \
    if [ -d "/tmp/rules/$dir" ]; then cp -r "/tmp/rules/$dir" /opt/semgrep-rules/; fi; \
  done; \
  find /opt/semgrep-rules -type f ! -name '*.yaml' ! -name '*.yml' -delete; \
  find /opt/semgrep-rules -name '*.test.yaml' -delete; \
  rm -rf /tmp/rules

ENV SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 HOME=/tmp
WORKDIR /workspace
