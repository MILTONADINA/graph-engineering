# storage.upload

**What.** `upload` (multer, memory storage) and `FileUpload.uploadFileToS3(file)` — buffers an incoming multipart file entirely in memory then `PutObjectCommand`s it under `<keyPrefix>/<uuid>-<originalname>`, returning the object key.

**When.** After `storage.aws-s3`, `backend.error-handler`. Before `storage.file-validation` (extends — adds size/MIME limits), `storage.delete` (appends a delete method to the same repository file), and whichever `backend.express` route calls `upload.single('file')` then this method.

**Requires.** `storage.aws-s3`, `backend.error-handler`.

**Configure via.** `keyPrefix` (default `'uploads'`).

**Produces.** `src/config/multer.config.ts`, `src/repository/FileUpload.ts`.

**Diverges from the reference app.** The original `uploadFileToS3` caught its own error and returned `null` — every caller had to remember to check for `null`, and a swallowed error there is invisible in logs beyond a `console.error`. This node throws `APIError('Failed to upload file', 502)` instead, so a failed upload surfaces through the same `backend.error-handler` path as every other failure in the app (REFERENCE_ARCHITECTURE.md §8/§9).

**Connects to.** Downstream: `storage.file-validation`, `storage.delete`, `backend.express`.

**Test.** `npm test -- upload` — mocks `s3Client.send` to reject, asserts `uploadFileToS3` throws `APIError` (not resolves to `null`).

**Security.** No size/MIME validation here — pair with `storage.file-validation` for anything accepting uploads from untrusted users; treat that pairing as required, not optional. Keys are UUID-randomized under a fixed prefix, so they can't be enumerated or guessed.
