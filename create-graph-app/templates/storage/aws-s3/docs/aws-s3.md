# AWS S3

## What it is

This project uses AWS S3 (or any S3-compatible provider) for object/file storage.

## Why it exists

S3 is the standard for storing user-uploaded files — images, documents, exports — outside your application server, with fine-grained access control via presigned URLs.

## Files it generated

- `src/config/s3Client.ts` — the `S3Client` instance and `storageBucket` name
- `src/utils/storage.ts` — `uploadFile`, `getDownloadUrl`, `getUploadUrl`, `deleteFile`

## Environment variables

| Name | Required | Description |
|---|---|---|
| `AWS_REGION` | Yes | Bucket region, e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | Yes | IAM access key with S3 permissions |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM secret key |
| `AWS_BUCKET_NAME` | Yes | Target bucket, default `media` |
| `AWS_ENDPOINT_URL_S3` | No | Only for an S3-compatible provider that isn't AWS (Neon Object Storage, R2, etc.) — leave unset for real AWS S3 |

## Installation

Already installed if `create-graph-app` ran `npm install`.

## Configuration

Create an S3 bucket and an IAM user/role with `s3:PutObject`/`s3:GetObject`/`s3:DeleteObject` on it, then fill in `.env`.

## Usage

```ts
import { uploadFile, getDownloadUrl, deleteFile } from './utils/storage';

const key = await uploadFile({ buffer, originalname: 'photo.png', mimetype: 'image/png' });
const url = await getDownloadUrl(key); // valid for 1 hour by default
await deleteFile(key);
```

Wire `uploadFile` into a route with an upload-handling middleware (e.g. `multer`'s memory storage) — this template intentionally ships the storage layer, not a specific route shape, since that depends on your API design.

## Development workflow

No local emulator is bundled — point at a real (dev/staging) bucket during development, or use an S3-compatible local emulator (e.g. MinIO) by setting `AWS_ENDPOINT_URL_S3`.

## Testing

Mock `s3Client.send` in unit tests rather than hitting real S3; reserve real-bucket tests for a manual/staging check.

## Security considerations

- Objects are private by default — reads go through `getDownloadUrl`'s presigned URL, never a public bucket policy.
- Presigned URL expiry is clamped to a maximum of 24 hours server-side, regardless of what's requested — an unbounded presigned URL is effectively a permanent public link.
- `uploadFile` throws on failure (unlike some older examples that silently return `null`) — always handle the rejection.
- This template does not validate file type or size — add that check (MIME allowlist, size limit) in your upload middleware before calling `uploadFile`, since accepting arbitrary files is a real attack surface.

## Common problems

- **Access Denied**: your IAM credentials don't have permission on the bucket, or the bucket name/region is wrong.
- **Works with real AWS but not your local emulator**: set `AWS_ENDPOINT_URL_S3` to the emulator's URL.

## How to replace it

Swap providers by changing `AWS_ENDPOINT_URL_S3` (most S3-compatible providers need only that plus new credentials) — `src/utils/storage.ts` doesn't change. For a genuinely different storage model (e.g. local filesystem for a single-server deployment), replace `src/utils/storage.ts`'s four functions with filesystem equivalents and keep the same function signatures so nothing else in your app has to change.
