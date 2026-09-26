# Template catalog rendering

- ID: template-catalog
- Status: implemented
- Area: templates

## Problem

Teams want common building blocks (project scaffold, backend entities, authentication, database, frontend, storage, search, webhooks, testing, docs, DevOps and deployment) generated deterministically instead of re-prompted from a model each time. An operator needs each catalog template to render as a reviewable proposal from audited code, with validated inputs, no hidden installs or commands, and no overwriting of existing work.

## Acceptance criteria

- AC1: Every implemented catalog identity has an audited renderer, and planned or prompt-only nodes are reported as unavailable.
  - Test: packages/engine/tests/template-runtime.test.ts :: keeps every implemented catalog identity and manifest aligned with an audited renderer
  - Test: packages/engine/tests/template-runtime.test.ts :: keeps planned and unsupported prompt-only nodes explicitly unavailable
- AC2: Rendering produces source and tests as an unapplied proposal with a validated instance manifest and zero model usage.
  - Test: packages/engine/tests/template-runtime.test.ts :: creates source and tests as a proposal with a validated instance manifest and zero model usage
- AC3: Rendering never installs packages or runs manifest commands or target scripts.
  - Test: packages/engine/tests/template-runtime.test.ts :: does not install missing packages or invoke manifest commands
  - Test: packages/engine/tests/template-runtime-project.test.ts :: creates deterministic source, pinned dependencies, tests and a public-only ledger without installing or executing
- AC4: Unknown inputs, unsafe interpolation, excessive bounds, forbidden target paths and manifests that add scripts or unsupported versions are rejected.
  - Test: packages/engine/tests/template-runtime.test.ts :: rejects unknown inputs, unsafe interpolation, excessive bounds, and forbidden target paths
  - Test: packages/engine/tests/template-runtime.test.ts :: rejects manifests that introduce scripts, modified paths, or unsupported versions
- AC5: Rendering is deterministic and idempotent and never overwrites an existing conflicting file.
  - Test: packages/engine/tests/template-runtime.test.ts :: never overwrites an existing conflicting output
  - Test: packages/engine/tests/template-runtime-frontend.test.ts :: renders the Vite scaffold and shared API client deterministically and idempotently
- AC6: Backend, database, authentication and frontend templates compose into a full-stack application without credential values in source.
  - Test: packages/engine/tests/template-runtime-fullstack.test.ts :: composes real backend/database/auth/frontend templates with explicit fixture dependencies and no source credential values
- AC7: Deployment templates produce a local proposal without contacting AWS and keep account and network identifiers out of cloud context.
  - Test: packages/engine/tests/template-runtime-aws.test.ts :: offers an idempotent local proposal through the audited engine without AWS activity
  - Test: packages/engine/tests/template-runtime-aws.test.ts :: keeps account and VPC IDs out of cloud MCP context with a broad export allowlist

## Security considerations

Template inputs come from operators, plans or models and are validated against schemas with bounded literals; interpolation that could inject code, paths that escape the target or hit exclusions, and symlinked destinations are refused. Renderers do not execute repository scripts, install packages or connect to databases or cloud accounts, so a template cannot become a code-execution path. Generated secrets are never written as values, and private deployment descriptors (account IDs, VPC IDs, secret ARNs) are kept out of cloud exports. Root public ledgers and environment examples require explicit policy permission.

## Non-goals

The catalog does not deploy anything, run generated tests, or reconcile custom edits to generated files. Planned catalog nodes stay unavailable until they have an audited renderer, and generated output is not human acceptance.
