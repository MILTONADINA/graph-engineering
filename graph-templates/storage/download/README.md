# storage.download

**What.** `FileDownload.streamToResponse(key, res, filename?)` — fetches an object via `GetObjectCommand` and pipes its body (a Node `Readable` in the AWS SDK v3 S3 client) straight to the Express response, setting `Content-Type`/optional `Content-Disposition`.

**When.** After `storage.aws-s3`, `backend.error-handler`. Use instead of `storage.presigned-url`'s download mode when the server needs to control the response directly (force a filename, apply a transform, avoid exposing a time-limited link).

**Requires.** `storage.aws-s3`, `backend.error-handler`.

**Produces.** `src/repository/FileDownload.ts` exporting `FileDownload`.

**Connects to.** Downstream: `backend.express` (a route calls `FileDownload.streamToResponse`).

**Test.** `npm test -- download` — mocks `s3Client.send` to reject, asserts `streamToResponse` throws `APIError(404)` rather than crashing the handler.

**Security.** The `key` parameter must always come from a trusted source — your own database, resolved from an id the caller is already authorized to access — never directly from a client-supplied path or query parameter. Accepting a raw key from the client is the object-storage equivalent of a path-traversal bug: any authenticated caller could read any object in the bucket by guessing keys. This node performs no authorization check of its own; the calling route is responsible for verifying the caller may access that specific object before calling `streamToResponse` (pair with `authorization.rbac`/`authorization.tenant-isolation`).
