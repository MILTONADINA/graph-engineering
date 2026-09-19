# ai.storage-agent

**What.** Wires up file storage (`storage.aws-s3` + `storage.upload` + `storage.file-validation`, optionally `storage.presigned-url`/`storage.download`/`storage.delete`) for every requirement flagged `requiresFileStorage: true`; produces `storage.schema.json`.

**Non-negotiable rules.** Buckets default private; `storage.upload` is never invoked without `storage.file-validation`; every upload use case gets an explicit `maxSizeBytes` and `allowedMimeTypes` allowlist. Full reasoning in `system-prompt.md`.

**Requires.** `requirements.schema`.

**Produces.** `storage.schema`.

**Hands off to.** `ai.testing-agent`.

**Validate.** No bucket is `public` without explicit justification; every upload use case pairs with validation; presigned-url direction matches declared use case.
