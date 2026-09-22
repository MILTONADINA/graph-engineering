# Audited storage runtime

All six implemented `storage.*` catalog nodes now have deterministic proposal renderers. The runtime validates the exact reviewed catalog manifest, bounded inputs, package/export prerequisites, filesystem policy and shared-file edits. It never executes catalog hooks, installs application dependencies on the host, or contacts a storage provider while rendering.

The emitted APIs intentionally harden the original catalog examples. Raw `files/` assets are not the executable renderer and must not be used as an interchangeable security implementation.

## Application prerequisites and APIs

Use the Node/Express scaffold with its `SECRETS` environment markers and `APIError` export. Install and lock application dependencies through your reviewed dependency workflow before rendering. The offline fixture pins AWS SDK client/presigner `3.1137.0`, Multer `2.4.0`, Express `4.22.3`, TypeScript `5.9.3` and Vitest `4.1.11`; upload/file-validation renderers require exactly `multer: "2.4.0"` and reject the catalog's legacy 1.x range. The renderer does not silently upgrade dependencies.

| Node                      | Emitted API / additional prerequisite                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.aws-s3`          | `s3Client`, `storageBucket`, `storagePolicy.ts`; updates the existing environment helper                                                                                           |
| `storage.upload`          | `new FileUpload(authorize).uploadFileToS3(principal, file)`; `upload` Multer middleware                                                                                            |
| `storage.delete`          | Adds `.deleteFile(principal, key)` to the exact audited upload repository                                                                                                          |
| `storage.download`        | `new FileDownload(authorize).streamToResponse(principal, key, response, filename?)`                                                                                                |
| `storage.presigned-url`   | `new PresignedUrl(authorize).getUploadUrl(principal, contentType, size, expiry?)` and `.getDownloadUrl(principal, key, expiry?)`; requires upload's shared size/type configuration |
| `storage.file-validation` | Replaces the exact audited Multer configuration with shared configurable size/type limits                                                                                          |

Apply `aws-s3` before storage operations, `upload` before `delete`, `file-validation` or `presigned-url`. File-validation can precede or follow presigned generation because both use the same imported policy constants. The runtime refuses edited scope-policy/client prerequisites; reconcile intentional customizations explicitly instead of overwriting them.

Every operation requires a `StorageAuthorizer` callback. It receives a frozen `{ principal: { tenantId, subjectId }, action, key }` snapshot and must return exactly `true`; missing, false, truthy nonboolean, thrown and rejected decisions fail closed. The application must derive principal identity from trusted authentication and check action/resource authorization. Passing client-supplied tenant/user identifiers or an unconditional `() => true` is not authentication. These templates do not automatically mount protected routes.

Keys have the exact form `tenants/<tenant>/subjects/<subject>/<prefix>/<UUID-v4>`. Scope identifiers, prefixes, UUIDs and total key length are validated; cross-subject/tenant keys are rejected before transport. The model deliberately does not grant team-shared object access: that needs a separately reviewed authorization/key design. Uploads create fresh keys and ignore client filenames. The SDK operations have no public ACL, but existing bucket policy is not inspected or changed.

## Bounds and security properties

- Buffered uploads default to 5 MiB, may be configured up to a 10 MiB hard cap, and require matching actual-buffer/declaration lengths. Multer allows one file, eight fields, ten parts, 1 KiB field values and 100-byte field names. Both upload paths use the same declared media-type allowlist. This is **not file-content sniffing or malware scanning**; tests explicitly demonstrate a falsely labelled image can pass metadata checking.
- Server uploads use conditional `If-None-Match: *` and request SHA256 integrity checking. Presigned PUT URLs bind exact `Content-Length`, `Content-Type` and `If-None-Match` headers and return the headers clients must send. The SDK is configured not to attach an empty-body checksum while presigning; signed uploads do not bind an application-provided content digest. Expiry must be a positive finite integer and is capped by reviewed configuration, at most 86,400 seconds.
- Proxy downloads enforce a 10 MiB metadata **and actual stream-byte** ceiling, fixed attachment/octet-stream/nosniff/no-store/sandbox headers, a 30-second pipeline timeout and stream cleanup. SDK transport operations have 15-second abort signals. Direct presigned downloads bypass this proxy byte/time limit; they request attachment/octet-stream/no-store response metadata.
- The endpoint is administrator-controlled HTTPS with no embedded credentials, path, query or fragment. Configuration and provider failures use constant messages; raw provider errors, URLs and credentials are not logged. Explicit access-key credentials are required; automatic discovery, temporary-session credential configuration, bucket/IAM setup and key rotation are not implemented by this renderer.

Presigned URLs are bearer credentials: do not log, persist publicly, or send them to an unrelated principal. Browser CORS, exact content-length transmission, signed-header enforcement, conditional writes, integrity-check compatibility and private bucket/IAM policy must be verified for the chosen provider. Concurrency/rate limits, upload quarantine/scanning, encryption/retention policy, audit logging, object lifecycle and deletion/version recovery remain deployment responsibilities. HTTPS configuration is not proof that an administrator-selected endpoint is trustworthy.

## Reproducible verification and limits

Build the explicit test dependency image, then run the generated application in the existing network-disabled sandbox:

```sh
docker build -t graph-storage-template-test:local packages/engine/tests/fixtures/storage-runtime
GRAPH_ENGINE_STORAGE_DOCKER_TESTS=1 npx vitest run packages/engine/tests/template-runtime-storage.test.ts --silent=false
```

The fixture uses a lockfile and actual SDK, presigner, Express and Multer implementations. SDK `send` calls are mocked at the provider boundary; signing, multipart parsing and download streaming run locally. The generated application passes strict TypeScript and 21 checks, including six emitted tests plus boundary/security fixtures. The engine test also covers manifest tampering, unsafe inputs, obsolete dependencies, edited prerequisites and idempotent shared modifications. Verification records the resolved Docker image identity; the local measured image was `sha256:6964aa377d20229a97ba38991005208a6ed048b36507df8097713fad9ca6c12b`. Rebuilds can produce a different identity, which must be recorded for that run.

No live AWS/S3-compatible provider, IAM policy, browser upload or provider-side enforcement was exercised. Offline signatures establish the generated request contract, not live-service compatibility. For provider semantics, consult [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [presigned URL access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), and [SDK checksum behavior](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html).
