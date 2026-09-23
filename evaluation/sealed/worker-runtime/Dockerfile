# Explicit provisioning only. The intake has no package dependencies.
FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /opt/sealed-public-intake
COPY packet.mjs executor.mjs ./
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/node", "/opt/sealed-public-intake/executor.mjs"]
