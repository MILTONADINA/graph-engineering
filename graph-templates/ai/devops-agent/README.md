# ai.devops-agent

**Lighter treatment.** Invokes `devops.docker` + `devops.github-actions` + `devops.environments` and records `deployment.schema.json`. Always runs after `ai.testing-agent` — never containerize/CI-wire untested code. Actual deployment/publishing (`devops.deployment`) is `planned`, out of scope.

**Hands off to.** `ai.validation-agent` (final full-graph pass).
