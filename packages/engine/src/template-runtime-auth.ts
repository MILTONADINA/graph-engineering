import ts from "typescript";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";
import { createPasswordTemplates } from "./template-runtime-auth-password.js";

const foundation = [
  "error-handler",
  "middleware",
  "api-response",
  "validation",
];
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
function exact(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(
      "Authentication prerequisite differs from the reviewed scaffold",
    );
  return source.replace(before, () => after);
}
async function appendSchema(
  context: TemplateRenderContext,
  fragment: string,
  names: string[],
): Promise<TemplateArtifact> {
  const before = await context.readTarget("src/config/schema.ts");
  if (before.includes(fragment))
    return code("src/config/schema.ts", before, before);
  const exported = context.exportsIn(before);
  if (names.some((name) => exported.has(name)))
    throw new Error(
      "Authentication schema already exists with different content",
    );
  const marker =
    "// backend.repository nodes append one exported pgTable block per entity below this line.";
  if (before.split(marker).length !== 2)
    throw new Error(
      "Authentication schema requires the reviewed append marker",
    );
  const file = ts.createSourceFile(
    "schema.ts",
    before,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set<string>();
  for (const statement of file.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "drizzle-orm/pg-core" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const element of statement.importClause.namedBindings.elements)
        if (
          !element.propertyName ||
          element.propertyName.text === element.name.text
        )
          imports.add(element.name.text);
  for (const name of [
    "pgTable",
    "uuid",
    "varchar",
    "timestamp",
    "uniqueIndex",
    ...(names.includes("userTable") ? ["pgEnum"] : []),
  ])
    if (!imports.has(name))
      throw new Error(
        `Authentication schema must import ${name} without aliasing`,
      );
  return code(
    "src/config/schema.ts",
    `${before.trimEnd()}\n${fragment}`,
    before,
  );
}
async function helperEnvironment(
  context: TemplateRenderContext,
  fields: { name: string; type: string; value: string; required: boolean }[],
): Promise<TemplateArtifact> {
  const before = await context.readTarget("src/utils/helpers.ts");
  let content = before;
  for (const field of fields) {
    const declaration = `  ${field.name}: ${field.type};`,
      value = `  ${field.name}: ${field.value},`;
    const declared =
      content.match(new RegExp(`^\\s*${field.name}\\s*:.*$`, "gm")) ?? [];
    if (
      declared.some(
        (line) => ![declaration.trim(), value.trim()].includes(line.trim()),
      )
    )
      throw new Error(
        "Existing authentication environment binding differs from the reviewed declaration",
      );
    for (const [line, marker] of [
      [declaration, "  // ENV-VAR-FIELDS:"],
      [value, "  // ENV-VAR-VALUES:"],
    ]) {
      if (!content.includes(line))
        content = exact(content, marker, `${line}\n${marker}`);
      else if (content.split(line).length !== 2)
        throw new Error("Ambiguous authentication environment declaration");
    }
  }
  const file = ts.createSourceFile(
    "helpers.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const arrays = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "requiredEnvironmentVariables",
    );
  if (
    arrays.length !== 1 ||
    !arrays[0].initializer ||
    !ts.isArrayLiteralExpression(arrays[0].initializer)
  )
    throw new Error(
      "Authentication requires a literal requiredEnvironmentVariables array",
    );
  const array = arrays[0].initializer;
  const required = array.elements.map((element) => {
    if (!ts.isStringLiteral(element))
      throw new Error("Dynamic environment declaration is unsupported");
    return element.text;
  });
  for (const field of fields)
    if (field.required && !required.includes(field.name))
      required.push(field.name);
  content =
    content.slice(0, array.getStart(file)) +
    `[${required.map((name) => JSON.stringify(name)).join(", ")}]` +
    content.slice(array.getEnd());
  return code("src/utils/helpers.ts", content, before);
}
async function assertPackagePins(
  context: TemplateRenderContext,
  password = false,
): Promise<void> {
  const declared = JSON.parse(await context.readTarget("package.json"));
  for (const [name, version] of Object.entries({
    jsonwebtoken: "9.0.3",
    ...(password ? { bcrypt: "6.0.0" } : {}),
  })) {
    if (
      declared.dependencies?.[name] !== version ||
      (declared.devDependencies?.[name] !== undefined &&
        declared.devDependencies[name] !== version)
    )
      throw new Error(
        `Audited authentication requires exact runtime dependency ${name}@${version}`,
      );
  }
}
async function mount(
  context: TemplateRenderContext,
  binding: string,
  moduleName: string,
): Promise<TemplateArtifact> {
  const before = await context.readTarget("src/app.ts");
  const importLine = `import { ${binding} } from './routes/${moduleName}';`,
    mountLine = `app.use('/api/auth', ${binding});`;
  if (before.includes(importLine) && before.includes(mountLine)) {
    if (
      before.split(importLine).length !== 2 ||
      before.split(mountLine).length !== 2
    )
      throw new Error("Ambiguous authentication route mount");
    return code("src/app.ts", before, before);
  }
  if (before.includes(importLine) || before.includes(mountLine))
    throw new Error(
      "Partial authentication route registration needs explicit reconciliation",
    );
  if (!(
    before.indexOf("// Import routes") <
      before.indexOf("const app = express();") &&
    before.indexOf("const app = express();") <
      before.indexOf("// Health check route") &&
    before.indexOf("// Health check route") < before.indexOf("// 404 Route")
  ))
    throw new Error("Authentication requires reviewed Express scaffold order");
  return code(
    "src/app.ts",
    exact(
      exact(before, "// Import routes", `${importLine}\n// Import routes`),
      "// Health check route",
      `${mountLine}\n\n// Health check route`,
    ),
    before,
  );
}

function tokensSource(accessSeconds: number, refreshDays: number): string {
  return `import { createHash, randomBytes } from 'node:crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import { SECRETS } from './helpers';
import { APIError } from '../middlewares/errorMiddleware';

export type AuthRole = 'customer' | 'admin';
export interface AuthIdentity { id: string; email: string; role: AuthRole; status: 'active' | 'suspended'; tenantId?: string }
export const ACCESS_TOKEN_TTL_MS = ${accessSeconds} * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isIdentityId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value);
export function validIdentity(value: unknown): value is AuthIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AuthIdentity>;
  return isIdentityId(item.id) && typeof item.email === 'string' && item.email.length <= 320 &&
    (item.role === 'customer' || item.role === 'admin') && (item.status === 'active' || item.status === 'suspended') &&
    (item.tenantId === undefined || isIdentityId(item.tenantId));
}
function signingKey(): string {
  const value = SECRETS.ACCESS_TOKEN_SECRET;
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096 || new Set(value).size < 12)
    throw new Error('Configure a cryptographically random ACCESS_TOKEN_SECRET of at least 32 bytes');
  return value;
}
const origins = SECRETS.CORS_ORIGIN.split(',').map(value => {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (SECRETS.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('Authentication requires explicit trusted origins and HTTPS in production');
  return url.origin;
});
const issuer = origins[0];
const audience = issuer + '/api';
export const authCookieOptions = { httpOnly: true, secure: SECRETS.NODE_ENV === 'production' || issuer.startsWith('https:'), sameSite: 'strict' as const, path: '/' };
export const isTrustedOrigin = (origin:unknown):boolean => typeof origin === 'string' && origins.includes(origin);
export const requireTrustedOrigin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!isTrustedOrigin(req.headers.origin)) { next(new APIError('Origin not permitted', 403)); return; }
  next();
};
const attempts = new Map<string, {count:number;until:number}>();
export const authenticationRateLimit = (req: Request, _res: Response, next: NextFunction): void => {
  const now=Date.now(),key=req.ip ?? req.socket.remoteAddress ?? 'unknown';
  for(const [address,value] of attempts)if(value.until<=now)attempts.delete(address);
  const current=attempts.get(key)??{count:0,until:now+15*60*1000};
  if((!attempts.has(key)&&attempts.size>=10000)||current.count>=30){next(new APIError('Too many authentication attempts',429));return;}
  current.count++;attempts.set(key,current);next();
};
export function generateAccessToken(userId: string, role: AuthRole, tenantId?: string): string {
  if (!isIdentityId(userId) || !['customer','admin'].includes(role) || (tenantId !== undefined && !isIdentityId(tenantId))) throw new Error('Invalid authenticated identity');
  return jwt.sign({sub:userId,role,type:'access',...(tenantId ? {tenantId} : {})},signingKey(),{algorithm:'HS256',expiresIn:${accessSeconds},issuer,audience});
}
export function verifyAccessToken(token: unknown): (JwtPayload & {sub:string;role:AuthRole;type:'access';tenantId?:string}) | null {
  if(typeof token!=='string'||token.length>8192)return null;
  try {
    const payload=jwt.verify(token,signingKey(),{algorithms:['HS256'],issuer,audience,maxAge:${accessSeconds}});
    if(typeof payload==='string'||payload.type!=='access'||!isIdentityId(payload.sub)||!['customer','admin'].includes(payload.role)||
      !Number.isInteger(payload.iat)||!Number.isInteger(payload.exp)||payload.iat!>Math.floor(Date.now()/1000)||payload.exp!-payload.iat!>${accessSeconds}||
      (payload.tenantId!==undefined&&!isIdentityId(payload.tenantId)))return null;
    return payload as JwtPayload & {sub:string;role:AuthRole;type:'access';tenantId?:string};
  }catch{return null;}
}
export function generateRefreshToken(): {token:string;tokenHash:string;expiresAt:Date} {
  const token=randomBytes(32).toString('hex');
  return {token,tokenHash:hashToken(token),expiresAt:new Date(Date.now()+${refreshDays}*24*60*60*1000)};
}
export function hashToken(token:string):string {return createHash('sha256').update(token).digest('hex');}
`;
}
const middlewareSource = `import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, validIdentity, isTrustedOrigin, AuthRole } from '../utils/tokens';
import { resolveAuthenticationIdentity } from '../services/authIdentity';
import {APIError} from './errorMiddleware';
declare global { namespace Express { interface Request { user?: {id:string;email:string;role:AuthRole;tenantId?:string}; } } }
export const authMiddleware = async (req:Request,res:Response,next:NextFunction):Promise<void> => {
  delete req.user;
  const authorization=req.headers.authorization;
  if(authorization===undefined&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!isTrustedOrigin(req.headers.origin)){next(new APIError('Origin not permitted',403));return;}
  const token=authorization===undefined?req.cookies?.access_token:
    typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):undefined;
  const payload=verifyAccessToken(token);
  if(!payload){next(new APIError('Authentication required',401));return;}
  let identity;
  try {
    identity=await resolveAuthenticationIdentity(payload.sub);
  }catch{next(new APIError('Authentication required',401));return;}
  if(!validIdentity(identity)||identity.id!==payload.sub||identity.status!=='active'){next(new APIError('Authentication required',401));return;}
  req.user={id:identity.id,email:identity.email,role:identity.role,...(identity.tenantId?{tenantId:identity.tenantId}:{})};
  next();
};
`;
const refreshSource = `import express, { Request, Response } from 'express';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { database } from '../config/database';
import { refreshTokenTable } from '../config/schema';
import { resolveAuthenticationIdentity } from '../services/authIdentity';
import { asyncHandler } from '../middlewares/asyncHandler';
import { APIError } from '../middlewares/errorMiddleware';
import { generateAccessToken,generateRefreshToken,hashToken,validIdentity,authCookieOptions,ACCESS_TOKEN_TTL_MS,requireTrustedOrigin,authenticationRateLimit } from '../utils/tokens';
const router=express.Router();
router.post('/refresh',requireTrustedOrigin,authenticationRateLimit,asyncHandler(async(req:Request,res:Response)=>{
  const token=req.cookies?.refresh_token;
  if(typeof token!=='string'||token.length!==64||!/^[a-f0-9]{64}$/.test(token))throw new APIError('Authentication required',401);
  const tokenHash=hashToken(token);
  const [known]=await database.select().from(refreshTokenTable).where(eq(refreshTokenTable.tokenHash,tokenHash)).limit(1);
  if(!known)throw new APIError('Authentication required',401);
  // Resolve identity before the transaction so even a one-connection pool cannot deadlock its own resolver.
  const identity=await resolveAuthenticationIdentity(known.userId);
  const result=await database.transaction(async tx=>{
    // This same account lock orders login, refresh, replay revocation, and password reset before row locks.
    await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(\${'graph-auth:'+known.userId}, 0))\`);
    const now=new Date();
    const [stored]=await tx.update(refreshTokenTable).set({revokedAt:now})
      .where(and(eq(refreshTokenTable.tokenHash,tokenHash),isNull(refreshTokenTable.revokedAt),gt(refreshTokenTable.expiresAt,now))).returning();
    if(!stored){
      const [used]=await tx.select().from(refreshTokenTable).where(eq(refreshTokenTable.tokenHash,tokenHash)).limit(1);
      if(used?.revokedAt&&used.expiresAt>now)await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,used.userId));
      return null;
    }
    if(!validIdentity(identity)||identity.id!==stored.userId||identity.status!=='active')return null;
    const rotated=generateRefreshToken();
    await tx.insert(refreshTokenTable).values({userId:identity.id,tokenHash:rotated.tokenHash,expiresAt:rotated.expiresAt});
    return {rotated,access:generateAccessToken(identity.id,identity.role,identity.tenantId)};
  },{isolationLevel:'read committed'});
  if(!result)throw new APIError('Authentication required',401);
  res.cookie('access_token',result.access,{...authCookieOptions,maxAge:ACCESS_TOKEN_TTL_MS});
  res.cookie('refresh_token',result.rotated.token,{...authCookieOptions,maxAge:Math.max(0,result.rotated.expiresAt.getTime()-Date.now())});
  return res.status(200).json({message:'Token refreshed',data:null});
}));
export const authRefreshRoutes=router;
`;
const rbacSource = `import {NextFunction,Request,Response} from 'express';
import {APIError} from './errorMiddleware';
import type {AuthRole} from '../utils/tokens';
export const requireRole=(...roles:AuthRole[])=>(req:Request,_res:Response,next:NextFunction):void=>{
  if(!req.user){next(new APIError('Authentication required',401));return;}
  if(!roles.length||roles.some(role=>role!=='customer'&&role!=='admin')||!roles.includes(req.user.role)){next(new APIError('Forbidden',403));return;}
  next();
};
`;
const tenantMiddleware = `import {NextFunction,Request,Response} from 'express';
import {APIError} from './errorMiddleware';
import {isIdentityId} from '../utils/tokens';
declare global {namespace Express {interface Request {tenantId?:string;}}}
export const requireTenant=(req:Request,_res:Response,next:NextFunction):void=>{
  delete req.tenantId;
  const tenantId=req.user?.tenantId;
  if(!req.user||!isIdentityId(tenantId)){next(new APIError('Tenant context required',401));return;}
  req.tenantId=tenantId;next();
};
`;
const tenantScope = `import {and,eq,SQL} from 'drizzle-orm';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';
import {isIdentityId} from './tokens';
/** Must be applied to every scoped read/update/delete. Inserts require the same trusted tenant separately. */
export function withTenantScope(baseCondition:SQL|undefined,table:{tenantId:AnyPgColumn},tenantId:string):SQL{
  if(!isIdentityId(tenantId)||!table.tenantId)throw new Error('Valid trusted tenant scope is required');
  const condition=eq(table.tenantId,tenantId);
  return baseCondition?and(baseCondition,condition)!:condition;
}
`;

function tokenTests(): string {
  return `import {describe,expect,it,vi} from 'vitest';
import jwt from 'jsonwebtoken';
import {SECRETS} from '../src/utils/helpers';
import {generateAccessToken,verifyAccessToken,generateRefreshToken,hashToken,requireTrustedOrigin} from '../src/utils/tokens';
const id='11111111-1111-4111-8111-111111111111';
describe('audited JWT security boundaries',()=>{
  it('verifies only signed access tokens of the right algorithm and bounded lifetime',()=>{
    expect(verifyAccessToken(generateAccessToken(id,'admin'))?.sub).toBe(id);
    const common={sub:id,role:'admin',type:'access'},options={issuer:SECRETS.CORS_ORIGIN,audience:SECRETS.CORS_ORIGIN+'/api'};
    for(const token of [jwt.sign(common,SECRETS.ACCESS_TOKEN_SECRET,{...options,algorithm:'HS384',expiresIn:60}),jwt.sign({...common,type:'refresh'},SECRETS.ACCESS_TOKEN_SECRET,{...options,expiresIn:60}),jwt.sign(common,SECRETS.ACCESS_TOKEN_SECRET,{...options,expiresIn:-1}),jwt.sign(common,SECRETS.ACCESS_TOKEN_SECRET,options),jwt.sign({...common,iat:Math.floor(Date.now()/1000)+60},SECRETS.ACCESS_TOKEN_SECRET,{...options,expiresIn:60}),jwt.sign(common,SECRETS.ACCESS_TOKEN_SECRET,{...options,expiresIn:3600}), 'garbage'])expect(verifyAccessToken(token)).toBeNull();
  });
  it('creates opaque refresh tokens and persists only an independent hash',()=>{
    const value=generateRefreshToken();expect(value.token).toMatch(/^[a-f0-9]{64}$/);expect(value.tokenHash).toBe(hashToken(value.token));expect(value.tokenHash).not.toBe(value.token);expect(verifyAccessToken(value.token)).toBeNull();
  });
  it('rejects malformed identities and missing or untrusted CSRF origins',()=>{
    expect(()=>generateAccessToken('invalid','admin')).toThrow();
    expect(()=>generateAccessToken(id+'\\n','admin')).toThrow();
    for(const origin of [undefined,'https://untrusted.invalid']){const next=vi.fn();requireTrustedOrigin({headers:{origin}} as any,{} as any,next);expect(next.mock.calls[0][0].status).toBe(403);}
    const next=vi.fn();requireTrustedOrigin({headers:{origin:SECRETS.CORS_ORIGIN}} as any,{} as any,next);expect(next).toHaveBeenCalledWith();
  });
});
`;
}
const authorizationTests = `import {describe,expect,it,vi} from 'vitest';
import {requireRole} from '../src/middlewares/rbacMiddleware';
describe('RBAC enforcement',()=>{
  it('denies missing identity, wrong role and empty or invalid allowlists',()=>{
    for(const [roles,user,status] of [[['admin'],undefined,401],[['admin'],{role:'customer'},403],[[],{role:'admin'},403],[['owner'],{role:'owner'},403]] as any[]){const next=vi.fn();requireRole(...roles)({user} as any,{} as any,next);expect(next.mock.calls[0][0].status).toBe(status);}
  });
  it('allows only explicitly requested roles',()=>{const next=vi.fn();requireRole('admin')({user:{role:'admin'}} as any,{} as any,next);expect(next).toHaveBeenCalledWith();});
});
`;
const tenantTests = `import {describe,expect,it,vi} from 'vitest';
import {pgTable,uuid,PgDialect} from 'drizzle-orm/pg-core';
import {eq} from 'drizzle-orm';
import {requireTenant} from '../src/middlewares/tenantMiddleware';
import {withTenantScope} from '../src/utils/tenantScope';
const id='11111111-1111-4111-8111-111111111111';
describe('explicit tenant isolation plumbing',()=>{
  it('ignores header/body/preexisting tenant claims and denies malformed authenticated claims',()=>{
    for(const user of [undefined,{}, {tenantId:'invalid'}]){const req:any={user,tenantId:id,headers:{'x-tenant-id':id},body:{tenantId:id}},next=vi.fn();requireTenant(req,{} as any,next);expect(next.mock.calls[0][0].status).toBe(401);expect(req.tenantId).toBeUndefined();}
  });
  it('attaches only the authenticated tenant and combines actual parameterized SQL predicates',()=>{
    const req:any={user:{tenantId:id}},next=vi.fn();requireTenant(req,{} as any,next);expect(req.tenantId).toBe(id);expect(next).toHaveBeenCalledWith();
    const table=pgTable('tenant_test',{id:uuid('id'),tenantId:uuid('tenant_id')});
    const query=new PgDialect().sqlToQuery(withTenantScope(eq(table.id,id),table,id));expect(query.params).toEqual([id,id]);expect(query.sql).toContain(' and ');
    expect(()=>withTenantScope(undefined,table,'')).toThrow();
  });
});
`;

const jwtModifications = [
  {
    path: "src/config/schema.ts",
    operation: "append",
    source: "files/schema.fragment.ts",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-FIELDS:",
    template: "  ACCESS_TOKEN_SECRET: string;",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-into-array",
    marker: "requiredEnvironmentVariables",
    template: "'ACCESS_TOKEN_SECRET'",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template: "  ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET!,",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Import routes",
    template: "import { authRefreshRoutes } from './routes/authRefreshRoutes';",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Health check route",
    template: "app.use('/api/auth', authRefreshRoutes);",
  },
];
export const authenticationTemplates: Record<string, AuditedTemplateExtension> =
  {
    ...createPasswordTemplates({
      appendSchema,
      helperEnvironment,
      mount,
      assertPackagePins,
    }),
    "authentication.jwt": {
      directory: "authentication/jwt",
      creates: [
        {
          path: "src/middlewares/authMiddleware.ts",
          source: "files/authMiddleware.ts",
        },
        { path: "src/utils/tokens.ts", source: "files/tokens.ts.template" },
        {
          path: "src/routes/authRefreshRoutes.ts",
          source: "files/authRefreshRoutes.ts",
        },
      ],
      modifications: jwtModifications,
      packages: ["express", "jsonwebtoken", "drizzle-orm", "vitest"],
      prerequisites: {
        "src/config/database.ts": ["database"],
        "src/services/authIdentity.ts": ["resolveAuthenticationIdentity"],
        "src/middlewares/asyncHandler.ts": ["asyncHandler"],
        "src/middlewares/errorMiddleware.ts": ["APIError"],
        "src/utils/helpers.ts": ["SECRETS"],
      },
      async render(context) {
        await assertPackagePins(context);
        const access =
          typeof context.inputs.accessTokenTtl === "string"
            ? context.inputs.accessTokenTtl.match(/^([1-9][0-9]*)(s|m)$/)
            : null;
        const refresh =
          typeof context.inputs.refreshTokenTtl === "string"
            ? context.inputs.refreshTokenTtl.match(/^([1-9][0-9]*)d$/)
            : null;
        const seconds = access
            ? Number(access[1]) * (access[2] === "m" ? 60 : 1)
            : 0,
          days = refresh ? Number(refresh[1]) : 0;
        if (
          access?.[0] !== context.inputs.accessTokenTtl ||
          refresh?.[0] !== context.inputs.refreshTokenTtl ||
          !Number.isSafeInteger(seconds) ||
          seconds < 60 ||
          seconds > 1800 ||
          !Number.isSafeInteger(days) ||
          days < 1 ||
          days > 90
        )
          throw new Error(
            "JWT runtime requires access TTL 60s–30m and refresh TTL 1d–90d with explicit units",
          );
        const artifacts = [
          code("src/utils/tokens.ts", tokensSource(seconds, days)),
          code("src/middlewares/authMiddleware.ts", middlewareSource),
          code("src/routes/authRefreshRoutes.ts", refreshSource),
          await appendSchema(
            context,
            await context.readAsset("files/schema.fragment.ts"),
            ["refreshTokenTable"],
          ),
          await helperEnvironment(context, [
            {
              name: "ACCESS_TOKEN_SECRET",
              type: "string",
              value: "process.env.ACCESS_TOKEN_SECRET!",
              required: true,
            },
          ]),
          await mount(context, "authRefreshRoutes", "authRefreshRoutes"),
          test("tests/authenticationJwt.test.ts", tokenTests()),
        ];
        return {
          artifacts,
          outputs: {
            files: artifacts.map((item) => item.path),
            exports: [
              "authMiddleware",
              "generateAccessToken",
              "verifyAccessToken",
              "generateRefreshToken",
              "hashToken",
            ],
          },
        };
      },
    },
    "authorization.rbac": {
      directory: "authorization/rbac",
      creates: [
        {
          path: "src/middlewares/rbacMiddleware.ts",
          source: "files/rbacMiddleware.ts",
        },
      ],
      packages: ["express", "vitest"],
      prerequisites: {
        "src/middlewares/authMiddleware.ts": ["authMiddleware"],
        "src/middlewares/errorMiddleware.ts": ["APIError"],
        "src/utils/tokens.ts": ["AuthRole"],
      },
      async render() {
        const artifacts = [
          code("src/middlewares/rbacMiddleware.ts", rbacSource),
          test("tests/rbacMiddleware.test.ts", authorizationTests),
        ];
        return {
          artifacts,
          outputs: {
            files: artifacts.map((item) => item.path),
            exports: ["requireRole"],
          },
        };
      },
    },
    "authorization.tenant-isolation": {
      directory: "authorization/tenant-isolation",
      creates: [
        {
          path: "src/middlewares/tenantMiddleware.ts",
          source: "files/tenantMiddleware.ts",
        },
        { path: "src/utils/tenantScope.ts", source: "files/tenantScope.ts" },
      ],
      packages: ["express", "drizzle-orm", "vitest"],
      prerequisites: {
        "src/middlewares/authMiddleware.ts": ["authMiddleware"],
        "src/middlewares/errorMiddleware.ts": ["APIError"],
        "src/utils/tokens.ts": ["isIdentityId"],
      },
      async render() {
        const artifacts = [
          code("src/middlewares/tenantMiddleware.ts", tenantMiddleware),
          code("src/utils/tenantScope.ts", tenantScope),
          test("tests/tenantMiddleware.test.ts", tenantTests),
        ];
        return {
          artifacts,
          outputs: {
            files: artifacts.map((item) => item.path),
            exports: ["requireTenant", "withTenantScope"],
          },
        };
      },
    },
  };
