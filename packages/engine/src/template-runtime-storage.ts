import ts from "typescript";
import { z } from "zod";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const code = (
  path: string,
  content: string,
  before?: string,
): TemplateArtifact => ({
  path,
  content,
  kind: "code",
  ...(before === undefined ? {} : { before }),
});
const test = (path: string, content: string): TemplateArtifact => ({
  path,
  content,
  kind: "test",
});
const result = (artifacts: TemplateArtifact[], exports: string[]) => ({
  artifacts,
  outputs: { files: artifacts.map((item) => item.path), exports },
});
function exact(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Storage prerequisite differs from the audited scaffold");
  return source.replace(before, () => after);
}
const prerequisites = {
  "src/config/s3-client.ts": ["s3Client", "storageBucket"],
  "src/utils/storagePolicy.ts": [
    "authorizeObject",
    "newObjectKey",
    "validateObjectKey",
  ],
  "src/middlewares/errorMiddleware.ts": ["APIError"],
};
const s3Modifications = [
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-FIELDS:",
    template:
      "  AWS_ENDPOINT_URL_S3: string;\n  AWS_REGION: string;\n  AWS_ACCESS_KEY_ID: string;\n  AWS_SECRET_ACCESS_KEY: string;\n  AWS_BUCKET_NAME: string;",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template:
      "  AWS_ENDPOINT_URL_S3: process.env.AWS_ENDPOINT_URL_S3!,\n  AWS_REGION: process.env.AWS_REGION!,\n  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,\n  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!,\n  AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME ?? '{{input.defaultBucketName}}',",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-into-array",
    marker: "requiredEnvironmentVariables: readonly string[] = [",
    template:
      "'AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',",
  },
];
async function environment(context: TemplateRenderContext, bucket: string) {
  const before = await context.readTarget("src/utils/helpers.ts");
  let content = before;
  const names = [
    "AWS_ENDPOINT_URL_S3",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_BUCKET_NAME",
  ];
  for (const name of names) {
    const declaration = `  ${name}: string;`,
      value = `  ${name}: ${name === "AWS_BUCKET_NAME" ? `process.env.${name} ?? ${JSON.stringify(bucket)}` : `process.env.${name}!`},`;
    const occurrences = [...before.matchAll(new RegExp(`\\b${name}:`, "g"))]
      .length;
    if (
      occurrences &&
      !(
        occurrences === 2 &&
        before.includes(declaration) &&
        before.includes(value)
      )
    )
      throw new Error(
        "Existing storage environment fields need explicit reconciliation",
      );
    if (!content.includes(declaration))
      content = exact(
        content,
        "  // ENV-VAR-FIELDS:",
        declaration + "\n  // ENV-VAR-FIELDS:",
      );
    if (!content.includes(value))
      content = exact(
        content,
        "  // ENV-VAR-VALUES:",
        value + "\n  // ENV-VAR-VALUES:",
      );
  }
  const file = ts.createSourceFile(
    "helpers.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "requiredEnvironmentVariables",
    );
  if (
    declarations.length !== 1 ||
    !declarations[0]!.initializer ||
    !ts.isArrayLiteralExpression(declarations[0]!.initializer)
  )
    throw new Error(
      "Storage requires a literal requiredEnvironmentVariables array",
    );
  const array = declarations[0]!.initializer,
    required = array.elements.map((node) => {
      if (!ts.isStringLiteral(node))
        throw new Error("Dynamic environment prerequisites are unsupported");
      return node.text;
    });
  for (const name of names.slice(0, 4))
    if (!required.includes(name)) required.push(name);
  content =
    content.slice(0, array.getStart(file)) +
    JSON.stringify(required) +
    content.slice(array.getEnd());
  return code("src/utils/helpers.ts", content, before);
}

const policy = String.raw`import { randomUUID } from 'node:crypto';
import { APIError } from '../middlewares/errorMiddleware';

export interface StoragePrincipal { tenantId: string; subjectId: string }
export type StorageAction = 'upload' | 'download' | 'delete';
export type StorageAuthorizer = (request: Readonly<{principal: Readonly<StoragePrincipal>; action: StorageAction; key: string}>) => boolean | Promise<boolean>;
export const STORAGE_HARD_LIMIT_BYTES = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function storagePrincipal(value: StoragePrincipal): Readonly<StoragePrincipal> {
  if (!value || typeof value.tenantId!=='string' || typeof value.subjectId!=='string' || ID.exec(value.tenantId)?.[0]!==value.tenantId || ID.exec(value.subjectId)?.[0]!==value.subjectId) throw new APIError('Invalid storage scope', 400);
  return Object.freeze({tenantId:value.tenantId,subjectId:value.subjectId});
}
export function validateObjectKey(principal: StoragePrincipal, key: string): void {
  const scope=storagePrincipal(principal);
  if(typeof key!=='string'||key.length>512)throw new APIError('Storage access denied',403);
  const parts=key.split('/');
  if (parts.length!==6 || parts[0]!=='tenants' || parts[1]!==scope.tenantId || parts[2]!=='subjects' || parts[3]!==scope.subjectId || PREFIX.exec(parts[4])?.[0]!==parts[4] || UUID.exec(parts[5])?.[0]!==parts[5]) throw new APIError('Storage access denied',403);
}
export function newObjectKey(principal: StoragePrincipal, prefix='uploads'): string {
  const scope=storagePrincipal(principal);
  if(typeof prefix!=='string'||PREFIX.exec(prefix)?.[0]!==prefix)throw new APIError('Invalid storage prefix',400);
  return ['tenants',scope.tenantId,'subjects',scope.subjectId,prefix,randomUUID()].join('/');
}
export async function authorizeObject(authorizer: StorageAuthorizer, principal: StoragePrincipal, action: StorageAction, key: string): Promise<void> {
  const scope=storagePrincipal(principal);validateObjectKey(scope,key);
  try { if(typeof authorizer!=='function'||await authorizer(Object.freeze({principal:scope,action,key}))!==true)throw new Error('denied'); }
  catch { throw new APIError('Storage access denied',403); }
}
export function storageFilename(value='download.bin'): string {
  if(typeof value!=='string'||!value.length||value.length>128||/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.exec(value)?.[0]!==value)throw new APIError('Invalid download filename',400);
  return value;
}
export function validateUploadMetadata(contentType: string, size: number, allowed: readonly string[], maximum: number): void {
  if(typeof contentType!=='string'||!allowed.includes(contentType)||!Number.isSafeInteger(size)||size<1||size>maximum||size>STORAGE_HARD_LIMIT_BYTES)throw new APIError('Upload rejected by size or declared media-type policy',400);
}
`;
const client = String.raw`import { S3Client } from '@aws-sdk/client-s3';
import { SECRETS } from '../utils/helpers';
const endpoint=(()=>{try{return new URL(SECRETS.AWS_ENDPOINT_URL_S3);}catch{throw new Error('Invalid storage endpoint configuration');}})();
if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw new Error('Configure a trusted HTTPS S3 endpoint without URL credentials, query, or path');
if(!SECRETS.AWS_REGION||!SECRETS.AWS_ACCESS_KEY_ID||!SECRETS.AWS_SECRET_ACCESS_KEY)throw new Error('Required storage credentials/configuration are missing');
export const storageBucket=SECRETS.AWS_BUCKET_NAME;
if(typeof storageBucket!=='string'||/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.exec(storageBucket)?.[0]!==storageBucket)throw new Error('Invalid private storage bucket name');
// Presigned uploads do not have a body yet: avoid signing the SDK's empty-body checksum.
// Buffered server-side uploads request SHA256 explicitly in their PutObjectCommand.
export const s3Client=new S3Client({endpoint:endpoint.origin,region:SECRETS.AWS_REGION,credentials:{accessKeyId:SECRETS.AWS_ACCESS_KEY_ID,secretAccessKey:SECRETS.AWS_SECRET_ACCESS_KEY},forcePathStyle:true,maxAttempts:2,requestChecksumCalculation:'WHEN_REQUIRED'});
`;
const defaultTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
];
function multerSource(
  types = defaultTypes,
  maximum = 5242880,
  external = false,
) {
  return `import multer from 'multer';
import type { Request } from 'express';
${external ? "import { fileFilter, MAX_SIZE_BYTES as VALIDATED_MAX_SIZE_BYTES, ALLOWED_MIME_TYPES as VALIDATED_ALLOWED_MIME_TYPES } from '../middlewares/fileValidation';\nexport const MAX_SIZE_BYTES=VALIDATED_MAX_SIZE_BYTES;\nexport const ALLOWED_MIME_TYPES=VALIDATED_ALLOWED_MIME_TYPES;" : `import { APIError } from '../middlewares/errorMiddleware';\nexport const MAX_SIZE_BYTES=${maximum};\nexport const ALLOWED_MIME_TYPES: readonly string[]=${JSON.stringify(types)};\nconst fileFilter: multer.Options['fileFilter']=(_req,file,next)=>{if(!ALLOWED_MIME_TYPES.includes(file.mimetype))next(new APIError('Unsupported declared media type',400));else next(null,true);};`}
export interface MulterRequest extends Request { files: { [fieldname:string]: Express.Multer.File[] } }
export const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_SIZE_BYTES,files:1,fields:8,parts:10,fieldSize:1024,fieldNameSize:100},fileFilter});
`;
}
function uploadSource(prefix: string) {
  return `import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, storageBucket } from '../config/s3-client';
import { MAX_SIZE_BYTES, ALLOWED_MIME_TYPES } from '../config/multer.config';
import { APIError } from '../middlewares/errorMiddleware';
import { authorizeObject, newObjectKey, storagePrincipal, validateUploadMetadata, type StorageAuthorizer, type StoragePrincipal } from '../utils/storagePolicy';
export class FileUpload {
  constructor(private readonly authorizer:StorageAuthorizer) { if(typeof authorizer!=='function')throw new APIError('Storage authorizer is required',403); }
  async uploadFileToS3(principal:StoragePrincipal,file:Express.Multer.File):Promise<string> {
    if(!file||!Buffer.isBuffer(file.buffer)||file.size!==file.buffer.length)throw new APIError('Invalid buffered upload',400);
    validateUploadMetadata(file.mimetype,file.buffer.length,ALLOWED_MIME_TYPES,MAX_SIZE_BYTES);
    const scope=storagePrincipal(principal),key=newObjectKey(scope,${JSON.stringify(prefix)}),body=Buffer.from(file.buffer),contentType=file.mimetype;
    await authorizeObject(this.authorizer,scope,'upload',key);
    try { await s3Client.send(new PutObjectCommand({Bucket:storageBucket,Key:key,Body:body,ContentLength:body.length,ContentType:contentType,IfNoneMatch:'*',ChecksumAlgorithm:'SHA256'}),{abortSignal:AbortSignal.timeout(15000)});return key; }
    catch {throw new APIError('Storage upload failed',502);}
  }
  // STORAGE-DELETE-METHOD
}
export const uploadFileToS3=(authorizer:StorageAuthorizer,principal:StoragePrincipal,file:Express.Multer.File)=>new FileUpload(authorizer).uploadFileToS3(principal,file);
`;
}
const deleteMethod = String.raw`  async deleteFile(principal:StoragePrincipal,key:string):Promise<void> {
    await authorizeObject(this.authorizer,principal,'delete',key);
    try {await s3Client.send(new DeleteObjectCommand({Bucket:storageBucket,Key:key}),{abortSignal:AbortSignal.timeout(15000)});}
    catch {throw new APIError('Storage deletion failed',502);}
  }
  // STORAGE-DELETE-METHOD`;
const download = String.raw`import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { s3Client, storageBucket } from '../config/s3-client';
import { APIError } from '../middlewares/errorMiddleware';
import { authorizeObject, storageFilename, STORAGE_HARD_LIMIT_BYTES, type StorageAuthorizer, type StoragePrincipal } from '../utils/storagePolicy';
export class FileDownload {
  constructor(private readonly authorizer:StorageAuthorizer){if(typeof authorizer!=='function')throw new APIError('Storage authorizer is required',403);}
  async streamToResponse(principal:StoragePrincipal,key:string,res:Response,filename='download.bin'):Promise<void>{
    const name=storageFilename(filename);await authorizeObject(this.authorizer,principal,'download',key);
    let object;
    try{object=await s3Client.send(new GetObjectCommand({Bucket:storageBucket,Key:key}),{abortSignal:AbortSignal.timeout(15000)});}
    catch{throw new APIError('Storage download failed',502);}
    if(!(object.Body instanceof Readable))throw new APIError('Storage returned an unsupported response',502);
    if(object.ContentLength!==undefined&&(!Number.isSafeInteger(object.ContentLength)||object.ContentLength<0||object.ContentLength>STORAGE_HARD_LIMIT_BYTES)){object.Body.destroy();throw new APIError('Storage download exceeds size limit',502);}
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition','attachment; filename="'+name+'"');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Security-Policy','sandbox');
    let received=0;
    const limit=new Transform({transform(chunk:Buffer,_encoding,next){received+=chunk.length;if(received>STORAGE_HARD_LIMIT_BYTES)next(new Error('Download size limit'));else next(null,chunk);}});
    try{await pipeline(object.Body,limit,res,{signal:AbortSignal.timeout(30000)});}
    catch{object.Body.destroy();if(res.headersSent){res.destroy();return;}throw new APIError('Storage stream failed',502);}
  }
}
`;
function presigned(defaultExpiry: number, maxExpiry: number) {
  return `import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, storageBucket } from '../config/s3-client';
import { MAX_SIZE_BYTES, ALLOWED_MIME_TYPES } from '../config/multer.config';
import { APIError } from '../middlewares/errorMiddleware';
import { authorizeObject, newObjectKey, storagePrincipal, validateUploadMetadata, STORAGE_HARD_LIMIT_BYTES, type StorageAuthorizer, type StoragePrincipal } from '../utils/storagePolicy';
function expiry(value=${defaultExpiry}){if(!Number.isSafeInteger(value)||value<1)throw new APIError('Invalid signed URL expiry',400);return Math.min(value,${maxExpiry});}
export class PresignedUrl {
  constructor(private readonly authorizer:StorageAuthorizer){if(typeof authorizer!=='function')throw new APIError('Storage authorizer is required',403);}
  async getUploadUrl(principal:StoragePrincipal,contentType:string,size:number,expiresIn?:number):Promise<{url:string;key:string;headers:Record<string,string>;expiresIn:number}>{
    validateUploadMetadata(contentType,size,ALLOWED_MIME_TYPES,MAX_SIZE_BYTES);
    const scope=storagePrincipal(principal),key=newObjectKey(scope),seconds=expiry(expiresIn);
    await authorizeObject(this.authorizer,scope,'upload',key);
    try{const url=await getSignedUrl(s3Client,new PutObjectCommand({Bucket:storageBucket,Key:key,ContentType:contentType,ContentLength:size,IfNoneMatch:'*'}),{expiresIn:seconds,signableHeaders:new Set(['content-type','content-length','if-none-match'])});return {url,key,headers:{'Content-Type':contentType,'Content-Length':String(size),'If-None-Match':'*'},expiresIn:seconds};}
    catch{throw new APIError('Storage URL signing failed',502);}
  }
  async getDownloadUrl(principal:StoragePrincipal,key:string,expiresIn?:number):Promise<string>{
    const seconds=expiry(expiresIn);await authorizeObject(this.authorizer,principal,'download',key);
    try{return await getSignedUrl(s3Client,new GetObjectCommand({Bucket:storageBucket,Key:key,ResponseContentType:'application/octet-stream',ResponseContentDisposition:'attachment',ResponseCacheControl:'private, no-store'}),{expiresIn:seconds});}
    catch{throw new APIError('Storage URL signing failed',502);}
  }
}
`;
}
const smoke = String.raw`import { describe, expect, it } from 'vitest';
import { newObjectKey, validateObjectKey } from '../src/utils/storagePolicy';
describe('storage scope boundaries',()=>{it('rejects another tenant and noncanonical keys',()=>{const scope={tenantId:'tenant',subjectId:'user'},key=newObjectKey(scope);expect(()=>validateObjectKey(scope,key)).not.toThrow();expect(()=>validateObjectKey({...scope,tenantId:'other'},key)).toThrow();expect(()=>validateObjectKey(scope,key+'/../other')).toThrow();});});
`;
function guardTest(name: string) {
  return `import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/config/s3-client',()=>({s3Client:{send:vi.fn()},storageBucket:'fixture'}));
import { ${name} } from '../src/repository/${name}';
describe('${name} authorization prerequisite',()=>{it('rejects a missing authorizer',()=>{expect(()=>new ${name}(undefined as never)).toThrow();});});\n`;
}
const deleteTest = String.raw`import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/config/s3-client',()=>({s3Client:{send:vi.fn()},storageBucket:'fixture'}));
import { s3Client } from '../src/config/s3-client';
import { FileUpload } from '../src/repository/FileUpload';
import { newObjectKey } from '../src/utils/storagePolicy';
describe('storage delete authorization',()=>{it('rejects a false authorizer before transport',async()=>{const scope={tenantId:'tenant',subjectId:'user'};await expect(new FileUpload(()=>false).deleteFile(scope,newObjectKey(scope))).rejects.toThrow('Storage access denied');expect(s3Client.send).not.toHaveBeenCalled();});});
`;
const validationTest = String.raw`import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { fileFilter, MAX_SIZE_BYTES } from '../src/middlewares/fileValidation';
describe('declared upload metadata policy',()=>{it('rejects an unlisted declared type without claiming content inspection',()=>{let result:Error|undefined;fileFilter({} as Request,{mimetype:''} as Express.Multer.File,(error:Error|null)=>{result=error??undefined;});expect(result).toBeInstanceOf(Error);expect(MAX_SIZE_BYTES).toBeGreaterThan(0);expect(MAX_SIZE_BYTES).toBeLessThanOrEqual(10485760);});});
`;
async function checkedMulter(context: TemplateRenderContext) {
  const manifest = JSON.parse(await context.readTarget("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (
    (manifest.dependencies?.multer ?? manifest.devDependencies?.multer) !==
    "2.4.0"
  )
    throw new Error(
      "Audited storage uploads require pinned multer 2.4.0; legacy catalog ranges are not accepted",
    );
}
async function checkedStorage(context: TemplateRenderContext) {
  if (
    (await context.readTarget("src/utils/storagePolicy.ts")) !== policy ||
    (await context.readTarget("src/config/s3-client.ts")) !== client
  )
    throw new Error(
      "Storage operations require the exact audited scope policy and client; edited prerequisites need explicit reconciliation",
    );
}
export const storageTemplates: Record<string, AuditedTemplateExtension> = {
  "storage.aws-s3": {
    directory: "storage/aws-s3",
    creates: [
      {
        path: "src/config/s3-client.ts",
        source: "files/s3-client.ts.template",
      },
    ],
    modifications: s3Modifications,
    packages: ["@aws-sdk/client-s3", "vitest"],
    prerequisites: {
      "src/utils/helpers.ts": ["SECRETS"],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
    },
    async render(context) {
      const bucket = z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
        .refine((value) => !/[\r\n]/.test(value))
        .parse(context.inputs.defaultBucketName);
      return result(
        [
          code("src/config/s3-client.ts", client),
          code("src/utils/storagePolicy.ts", policy),
          await environment(context, bucket),
          test("tests/storageScope.test.ts", smoke),
        ],
        [
          "s3Client",
          "storageBucket",
          "authorizeObject",
          "newObjectKey",
          "validateObjectKey",
        ],
      );
    },
  },
  "storage.upload": {
    directory: "storage/upload",
    creates: [
      { path: "src/config/multer.config.ts", source: "files/multer.config.ts" },
      {
        path: "src/repository/FileUpload.ts",
        source: "files/FileUpload.ts.template",
      },
    ],
    packages: [
      "@aws-sdk/client-s3",
      "multer",
      "@types/multer",
      "express",
      "vitest",
    ],
    prerequisites,
    async render(context) {
      await checkedStorage(context);
      await checkedMulter(context);
      const prefix = z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,47}$/)
        .refine((value) => !/[\r\n]/.test(value))
        .parse(context.inputs.keyPrefix);
      return result(
        [
          code("src/config/multer.config.ts", multerSource()),
          code("src/repository/FileUpload.ts", uploadSource(prefix)),
          test("tests/storageUpload.test.ts", guardTest("FileUpload")),
        ],
        ["upload", "FileUpload", "uploadFileToS3"],
      );
    },
  },
  "storage.delete": {
    directory: "storage/delete",
    creates: [],
    modifications: [
      {
        path: "src/repository/FileUpload.ts",
        operation: "append-to-class",
        className: "FileUpload",
        source: "files/deleteFile.method.ts",
      },
    ],
    packages: ["@aws-sdk/client-s3", "vitest"],
    prerequisites: {
      ...prerequisites,
      "src/repository/FileUpload.ts": ["FileUpload", "uploadFileToS3"],
    },
    async render(context) {
      await checkedStorage(context);
      const before = await context.readTarget("src/repository/FileUpload.ts");
      const source = ts.createSourceFile(
          "FileUpload.ts",
          before,
          ts.ScriptTarget.Latest,
          true,
        ),
        prefixes: string[] = [];
      const walk = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "newObjectKey" &&
          node.arguments[1] &&
          ts.isStringLiteral(node.arguments[1])
        )
          prefixes.push(node.arguments[1].text);
        ts.forEachChild(node, walk);
      };
      walk(source);
      if (prefixes.length !== 1)
        throw new Error(
          "Storage delete requires the exact audited upload repository",
        );
      const base = uploadSource(prefixes[0]!),
        content = exact(base, "  // STORAGE-DELETE-METHOD", deleteMethod);
      if (before !== base && before !== content)
        throw new Error(
          "Storage delete requires the exact audited upload repository",
        );
      return result(
        [
          code("src/repository/FileUpload.ts", content, before),
          test("tests/storageDelete.test.ts", deleteTest),
        ],
        ["FileUpload", "uploadFileToS3"],
      );
    },
  },
  "storage.download": {
    directory: "storage/download",
    creates: [
      {
        path: "src/repository/FileDownload.ts",
        source: "files/FileDownload.ts",
      },
    ],
    packages: ["@aws-sdk/client-s3", "express", "vitest"],
    prerequisites,
    async render(context) {
      await checkedStorage(context);
      return result(
        [
          code("src/repository/FileDownload.ts", download),
          test("tests/storageDownload.test.ts", guardTest("FileDownload")),
        ],
        ["FileDownload"],
      );
    },
  },
  "storage.presigned-url": {
    directory: "storage/presigned-url",
    creates: [
      {
        path: "src/repository/PresignedUrl.ts",
        source: "files/PresignedUrl.ts.template",
      },
    ],
    packages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "vitest"],
    prerequisites: {
      ...prerequisites,
      "src/config/multer.config.ts": ["MAX_SIZE_BYTES", "ALLOWED_MIME_TYPES"],
    },
    async render(context) {
      await checkedStorage(context);
      const maximum = z
          .number()
          .int()
          .min(1)
          .max(86400)
          .parse(context.inputs.maxExpirySeconds),
        initial = z
          .number()
          .int()
          .min(1)
          .max(maximum)
          .parse(context.inputs.defaultExpirySeconds);
      return result(
        [
          code("src/repository/PresignedUrl.ts", presigned(initial, maximum)),
          test("tests/storagePresigned.test.ts", guardTest("PresignedUrl")),
        ],
        ["PresignedUrl"],
      );
    },
  },
  "storage.file-validation": {
    directory: "storage/file-validation",
    creates: [
      {
        path: "src/middlewares/fileValidation.ts",
        source: "files/fileValidation.ts.template",
      },
    ],
    modifications: [
      {
        path: "src/config/multer.config.ts",
        operation: "replace-file",
        source: "files/multer.config.reconfigured.ts.template",
        note: "Replaces storage.upload's bare `upload` export with one that applies limits + fileFilter.",
      },
    ],
    packages: ["multer", "@types/multer", "express", "vitest"],
    prerequisites: {
      "src/config/multer.config.ts": ["upload"],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
    },
    async render(context) {
      await checkedMulter(context);
      const maximum = z
          .number()
          .int()
          .min(1)
          .max(10 * 1024 * 1024)
          .parse(context.inputs.maxSizeBytes),
        types = z
          .array(
            z
              .string()
              .regex(/^[a-z0-9][a-z0-9.+-]{0,39}\/[a-z0-9][a-z0-9.+-]{0,39}$/)
              .refine((value) => !/[\r\n]/.test(value)),
          )
          .min(1)
          .max(16)
          .parse(context.inputs.allowedMimeTypes);
      if (new Set(types).size !== types.length)
        throw new Error("Duplicate allowed media type");
      const before = await context.readTarget("src/config/multer.config.ts"),
        after = multerSource(types, maximum, true);
      if (before !== multerSource() && before !== after)
        throw new Error(
          "File validation requires the exact audited multer configuration",
        );
      const validation = `import type { FileFilterCallback } from 'multer';\nimport type { Request } from 'express';\nimport { APIError } from './errorMiddleware';\nexport const MAX_SIZE_BYTES=${maximum};\nexport const ALLOWED_MIME_TYPES:readonly string[]=${JSON.stringify(types)};\n// Declared MIME only: not content sniffing, malware scanning, or proof of safety.\nexport const fileFilter=(_req:Request,file:Express.Multer.File,next:FileFilterCallback):void=>{if(!ALLOWED_MIME_TYPES.includes(file.mimetype))next(new APIError('Unsupported declared media type',400));else next(null,true);};\n`;
      return result(
        [
          code("src/middlewares/fileValidation.ts", validation),
          code("src/config/multer.config.ts", after, before),
          test("tests/storageValidation.test.ts", validationTest),
        ],
        ["fileFilter", "upload"],
      );
    },
  },
};
