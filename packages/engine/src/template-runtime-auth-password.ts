import ts from "typescript";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";
interface Helpers {
  assertPackagePins(
    context: TemplateRenderContext,
    password: boolean,
  ): Promise<void>;
  appendSchema(
    context: TemplateRenderContext,
    fragment: string,
    names: string[],
  ): Promise<TemplateArtifact>;
  helperEnvironment(
    context: TemplateRenderContext,
    fields: { name: string; type: string; value: string; required: boolean }[],
  ): Promise<TemplateArtifact>;
  mount(
    context: TemplateRenderContext,
    binding: string,
    moduleName: string,
  ): Promise<TemplateArtifact>;
}
const exact = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2)
    throw new Error("Password asset differs from the audited source");
  return source.replace(before, () => after);
};
function method(source: string, name: string, replacement: string): string {
  const file = ts.createSourceFile(
    "Authentication.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = file.statements
    .filter(ts.isClassDeclaration)
    .flatMap((item) =>
      item.members.filter(
        (member) =>
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === name,
      ),
    );
  if (found.length !== 1)
    throw new Error(`Password repository must contain one ${name} method`);
  return (
    source.slice(0, found[0].getStart(file)) +
    replacement +
    source.slice(found[0].getEnd())
  );
}
async function repository(
  context: TemplateRenderContext,
  min: number,
): Promise<string> {
  let source = await context.readAsset("files/Authentication.ts");
  source = exact(
    source,
    "import { eq } from 'drizzle-orm';",
    "import { and, eq, gt, isNull, sql } from 'drizzle-orm';",
  );
  source = exact(
    source,
    "import { validate } from 'email-validator';",
    "import { z } from 'zod';",
  );
  source = exact(
    source,
    "import { authTokenTable, userProfileTable, userTable }",
    "import { authTokenTable, userProfileTable, userTable, refreshTokenTable }",
  );
  source = exact(source, "{{input.minPasswordLength}}", String(min));
  source = exact(
    source,
    "!validate(data.email.trim())",
    "!z.string().email().max(320).safeParse(data.email.trim()).success",
  );
  source = exact(
    source,
    "const MIN_PASSWORD_LENGTH = " + min + ";",
    `const MIN_PASSWORD_LENGTH = ${min};
export interface ActionToken {token:string;expiresAt:Date}
export function assertPassword(password:unknown):asserts password is string {
  if(typeof password!=='string'||Array.from(password).length<MIN_PASSWORD_LENGTH||Buffer.byteLength(password)>72||password.includes('\\0'))
    throw new APIError('Password does not meet length and byte limits',400);
}
function saltRounds():number {
  const value=SECRETS.SALT_ROUNDS;
  if(!Number.isInteger(value)||value<10||value>14)throw new Error('SALT_ROUNDS must be an integer from 10 through 14');
  return value;
}`,
  );
  source = method(
    source,
    "hashPassword",
    `async hashPassword(password:string):Promise<string>{assertPassword(password);return hash(password,saltRounds());}`,
  );
  source = method(
    source,
    "comparePasswords",
    `async comparePasswords(password:string,passwordHash:string):Promise<boolean>{
    if(typeof password!=='string'||Buffer.byteLength(password)>72||password.includes('\\0'))return false;
    return compare(password,passwordHash);
  }`,
  );
  source = method(
    source,
    "generateEmailVerificationToken",
    `async generateEmailVerificationToken(userId:string):Promise<ActionToken>{return this.createActionToken(userId,'email_verification',24*60*60*1000);}`,
  );
  source = method(
    source,
    "generatePasswordResetToken",
    `async generatePasswordResetToken(userId:string):Promise<ActionToken>{return this.createActionToken(userId,'password_reset',15*60*1000);}`,
  );
  source = method(
    source,
    "verifyActionToken",
    `async consumeActionToken(token:string,type:'email_verification'|'password_reset',passwordHash?:string):Promise<string|null>{
    if(typeof token!=='string'||token.length!==64||!/^[a-f0-9]{64}$/.test(token))return null;
    return database.transaction(async tx=>{
      const [known]=await tx.select().from(authTokenTable).where(and(eq(authTokenTable.tokenHash,this.hashToken(token)),eq(authTokenTable.type,type))).limit(1);
      if(!known)return null;
      // Serialize all credential issuance and reset effects for this account before taking row locks.
      await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(\${'graph-auth:'+known.userId}, 0))\`);
      const now=new Date();
      const [stored]=await tx.update(authTokenTable).set({consumedAt:now})
        .where(and(eq(authTokenTable.tokenHash,this.hashToken(token)),eq(authTokenTable.type,type),isNull(authTokenTable.consumedAt),gt(authTokenTable.expiresAt,now))).returning();
      if(!stored)return null;
      if(type==='password_reset'){
        if(!passwordHash)throw new Error('Password reset requires a prepared password hash');
        const changed=await tx.update(userTable).set({passwordHash,updatedAt:now}).where(eq(userTable.id,stored.userId)).returning({id:userTable.id});
        if(changed.length!==1)throw new APIError('Invalid action token',400);
        await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,stored.userId));
      }else{
        const changed=await tx.update(userTable).set({emailVerifiedAt:now,updatedAt:now}).where(eq(userTable.id,stored.userId)).returning({id:userTable.id});
        if(changed.length!==1)throw new APIError('Invalid action token',400);
      }
      return stored.userId;
    },{isolationLevel:'read committed'});
  }`,
  );
  source = method(source, "updateUserPassword", "");
  source = method(source, "markEmailAsVerified", "");
  source = method(
    source,
    "createActionToken",
    `private async createActionToken(userId:string,type:'email_verification'|'password_reset',lifetimeMs:number):Promise<ActionToken>{
    const token=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+lifetimeMs);
    await database.insert(authTokenTable).values({userId,type,tokenHash:this.hashToken(token),expiresAt});
    return {token,expiresAt};
  }`,
  );
  return source;
}
const identity = `import {AuthenticationRepository} from '../repository/Authentication';
import type {AuthIdentity} from '../utils/tokens';
const repository=new AuthenticationRepository();
/** Account roles/status come from the database, never untrusted request fields or stale token claims. */
export async function resolveAuthenticationIdentity(id:string):Promise<AuthIdentity|null>{
  const user=await repository.findUserById(id);
  return user&&user.emailVerifiedAt?{id:user.id,email:user.email,role:user.role,status:user.status}:null;
}
`;
const service = `import {hash} from 'bcrypt';
import {randomBytes} from 'node:crypto';
import {and,eq,gt,sql} from 'drizzle-orm';
import {database} from '../config/database';
import {refreshTokenTable,userTable} from '../config/schema';
import {generateAccessToken,generateRefreshToken,hashToken} from '../utils/tokens';
import {SECRETS} from '../utils/helpers';
import {APIError} from '../middlewares/errorMiddleware';
import {AuthenticationRepository,PublicUser,RegisterInput,assertPassword} from '../repository/Authentication';
import {deliverAuthenticationToken} from './authenticationDelivery';
export interface AuthenticationDelivery {kind:'email_verification'|'password_reset';email:string;token:string;expiresAt:Date}
const deliver:(message:AuthenticationDelivery)=>Promise<void>=deliverAuthenticationToken;
let dummyHash:Promise<string>|undefined;
function dummyCredential():Promise<string>{
  if(!Number.isInteger(SECRETS.SALT_ROUNDS)||SECRETS.SALT_ROUNDS<10||SECRETS.SALT_ROUNDS>14)throw new Error('SALT_ROUNDS must be an integer from 10 through 14');
  return dummyHash??=(hash(randomBytes(32).toString('hex'),SECRETS.SALT_ROUNDS));
}
export class AuthenticationService {
  private readonly repository=new AuthenticationRepository();
  async register(data:RegisterInput):Promise<{user:PublicUser}>{
    assertPassword(data.password);await this.repository.validateRegistration(data);
    const user=await this.repository.createUser(data);
    const action=await this.repository.generateEmailVerificationToken(user.id);
    await deliver({kind:'email_verification',email:user.email,...action});
    const stored=await this.repository.findUserById(user.id);
    if(!stored)throw new Error('Registered user profile is unavailable');
    return {user:this.repository.toPublicUser(stored,stored.profile)};
  }
  async login(email:string,password:string){
    const fallback=await dummyCredential();
    const user=await this.repository.findUserByEmail(email);
    if(!user){await this.repository.comparePasswords(password,fallback);throw new APIError('Invalid credentials',401);}
    return database.transaction(async tx=>{
      await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(\${'graph-auth:'+user.id}, 0))\`);
      const [current]=await tx.select().from(userTable).where(eq(userTable.id,user.id)).limit(1);
      const valid=await this.repository.comparePasswords(password,current?.passwordHash??fallback);
      if(!current||!valid||current.status!=='active'||!current.emailVerifiedAt)throw new APIError('Invalid credentials',401);
      const refresh=generateRefreshToken();
      await tx.insert(refreshTokenTable).values({userId:current.id,tokenHash:refresh.tokenHash,expiresAt:refresh.expiresAt});
      const signed=generateAccessToken(current.id,current.role);
      return {user:this.repository.toPublicUser(current,user.profile),accessToken:signed,refreshToken:refresh.token,refreshTokenExpiresAt:refresh.expiresAt};
    },{isolationLevel:'read committed'});
  }
  async getCurrentUser(id:string):Promise<PublicUser>{const user=await this.repository.findUserById(id);if(!user||user.status!=='active')throw new APIError('Authentication required',401);return this.repository.toPublicUser(user,user.profile);}
  async forgotPassword(email:string):Promise<void>{
    const user=await this.repository.findUserByEmail(email);
    if(user&&user.status==='active'){
      const action=await this.repository.generatePasswordResetToken(user.id);
      try{await deliver({kind:'password_reset',email:user.email,...action});}catch{console.error('Authentication token delivery failed');}
    }
  }
  async resetPassword(token:string,password:string,confirmation:string):Promise<void>{
    assertPassword(password);if(password!==confirmation)throw new APIError('Passwords do not match',400);
    const passwordHash=await this.repository.hashPassword(password);
    if(!await this.repository.consumeActionToken(token,'password_reset',passwordHash))throw new APIError('Invalid or expired action token',400);
  }
  async verifyEmail(token:string):Promise<void>{if(!await this.repository.consumeActionToken(token,'email_verification'))throw new APIError('Invalid or expired action token',400);}
  async logout(token:unknown):Promise<void>{
    if(typeof token!=='string'||token.length!==64||!/^[a-f0-9]{64}$/.test(token))return;
    const tokenHash=hashToken(token);
    const [known]=await database.select().from(refreshTokenTable).where(eq(refreshTokenTable.tokenHash,tokenHash)).limit(1);
    if(!known||known.expiresAt<=new Date())return;
    await database.transaction(async tx=>{
      await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(\${'graph-auth:'+known.userId}, 0))\`);
      const now=new Date();
      const [proof]=await tx.select().from(refreshTokenTable).where(and(eq(refreshTokenTable.tokenHash,tokenHash),gt(refreshTokenTable.expiresAt,now))).limit(1);
      if(!proof||proof.userId!==known.userId)return;
      // No family identifier is stored: revocation is deliberately account-wide, including rotated descendants.
      await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,known.userId));
    },{isolationLevel:'read committed'});
  }
}
`;
const controller = `import {Request,Response} from 'express';
import {AuthenticationService} from '../services/authenticationService';
import {authCookieOptions,ACCESS_TOKEN_TTL_MS} from '../utils/tokens';
import {sendSuccess} from '../utils/apiResponse';
export class AuthenticationController {
  private readonly service=new AuthenticationService();
  register=async(req:Request,res:Response):Promise<Response>=>{const {user}=await this.service.register(req.body);return sendSuccess(res,{user},'Registration received; complete email verification',201);};
  login=async(req:Request,res:Response):Promise<Response>=>{
    const result=await this.service.login(req.body.email,req.body.password);
    res.cookie('access_token',result.accessToken,{...authCookieOptions,maxAge:ACCESS_TOKEN_TTL_MS});
    res.cookie('refresh_token',result.refreshToken,{...authCookieOptions,maxAge:Math.max(0,result.refreshTokenExpiresAt.getTime()-Date.now())});
    return sendSuccess(res,{user:result.user},'Login successful');
  };
  me=async(req:Request,res:Response):Promise<Response>=>sendSuccess(res,{user:await this.service.getCurrentUser(req.user!.id)});
  forgotPassword=async(req:Request,res:Response):Promise<Response>=>{await this.service.forgotPassword(req.body.email);return sendSuccess(res,null,'Password recovery request received');};
  resetPassword=async(req:Request,res:Response):Promise<Response>=>{await this.service.resetPassword(req.params.resetToken,req.body.password,req.body.confirmPassword);return sendSuccess(res,null,'Password reset');};
  verifyEmail=async(req:Request,res:Response):Promise<Response>=>{await this.service.verifyEmail(req.params.verifyToken);return sendSuccess(res,null,'Email verified');};
  logout=async(req:Request,res:Response):Promise<Response>=>{
    // Clear the browser even on database failure; only return success after revocation completes.
    res.clearCookie('access_token',authCookieOptions);res.clearCookie('refresh_token',authCookieOptions);
    await this.service.logout(req.cookies?.refresh_token);
    return sendSuccess(res,null,'Logged out');
  };
}
`;
function routes(min: number): string {
  return `import express from 'express';
import {z} from 'zod';
import {AuthenticationController} from '../controllers/authenticationController';
import {authMiddleware} from '../middlewares/authMiddleware';
import {asyncHandler} from '../middlewares/asyncHandler';
import {validateBody,validateParams} from '../middlewares/validationMiddleware';
import {requireTrustedOrigin,authenticationRateLimit} from '../utils/tokens';
const router=express.Router(),controller=new AuthenticationController();
const password=z.string().refine(value=>Array.from(value).length>=${min}&&Buffer.byteLength(value)<=72&&!value.includes('\\0'),'Password does not meet length and byte limits');
const email=z.string().trim().email().max(320);
const registration=z.object({firstName:z.string().trim().min(1).max(100),lastName:z.string().trim().min(1).max(100),email,password,phone:z.string().max(32).optional()}).strict();
const login=z.object({email,password:z.string().min(1).refine(value=>Buffer.byteLength(value)<=72&&!value.includes('\\0'))}).strict();
const reset=z.object({password,confirmPassword:password}).strict();
const token=z.string().length(64).regex(/^[a-f0-9]{64}$/);
router.post('/register',requireTrustedOrigin,authenticationRateLimit,validateBody(registration),asyncHandler(controller.register));
router.post('/login',requireTrustedOrigin,authenticationRateLimit,validateBody(login),asyncHandler(controller.login));
router.get('/me',authMiddleware,asyncHandler(controller.me));
router.post('/forgot-password',requireTrustedOrigin,authenticationRateLimit,validateBody(z.object({email}).strict()),asyncHandler(controller.forgotPassword));
router.post('/reset-password/:resetToken',requireTrustedOrigin,authenticationRateLimit,validateParams(z.object({resetToken:token}).strict()),validateBody(reset),asyncHandler(controller.resetPassword));
router.post('/verify-email/:verifyToken',requireTrustedOrigin,authenticationRateLimit,validateParams(z.object({verifyToken:token}).strict()),asyncHandler(controller.verifyEmail));
router.post('/logout',requireTrustedOrigin,authenticationRateLimit,asyncHandler(controller.logout));
export const authenticationRoutes=router;
`;
}
const passwordTests = `import {describe,expect,it,vi} from 'vitest';
import {assertPassword,AuthenticationRepository} from '../src/repository/Authentication';
import {SECRETS} from '../src/utils/helpers';
describe('password hashing boundary',()=>{
  it('rejects short, excessive-byte and NUL passwords before hashing',()=>{
    for(const value of ['short','x'.repeat(73),'😀'.repeat(30),'long-enough-password\\0',undefined])expect(()=>assertPassword(value)).toThrow();
  });
  it('uses actual bcrypt with bounded cost and does not truncate long inputs',async()=>{
    const repository=new AuthenticationRepository();const value='fixture-'+Array.from({length:16},(_,index)=>String.fromCharCode(65+index)).join('');
    const encoded=await repository.hashPassword(value);expect(await repository.comparePasswords(value,encoded)).toBe(true);expect(await repository.comparePasswords(value+'wrong',encoded)).toBe(false);expect(await repository.comparePasswords('x'.repeat(73),encoded)).toBe(false);
    const old=SECRETS.SALT_ROUNDS;try{SECRETS.SALT_ROUNDS=4;await expect(repository.hashPassword(value)).rejects.toThrow('SALT_ROUNDS');}finally{SECRETS.SALT_ROUNDS=old;}
  });
});
`;

const modifications = [
  {
    path: "src/config/schema.ts",
    operation: "append",
    source: "files/schema.fragment.ts",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-FIELDS:",
    template: "  SALT_ROUNDS: number;",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template:
      "  SALT_ROUNDS: process.env.SALT_ROUNDS ? parseInt(process.env.SALT_ROUNDS, 10) : 12,",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Import routes",
    template:
      "import { authenticationRoutes } from './routes/authenticationRoutes';",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Health check route",
    template: "app.use('/api/auth', authenticationRoutes);",
  },
  {
    path: "src/middlewares/authMiddleware.ts",
    operation: "insert-import",
    template:
      "import { AuthenticationRepository } from '../repository/Authentication';",
  },
  {
    path: "src/middlewares/authMiddleware.ts",
    operation: "insert-before-marker",
    marker: "export const authMiddleware",
    template:
      "const authenticationRepository = new AuthenticationRepository();",
  },
  {
    path: "src/middlewares/authMiddleware.ts",
    operation: "replace-method",
    target: "authMiddleware",
    source: "files/authMiddleware.enhanced.ts.template",
  },
];
export function createPasswordTemplates(
  helpers: Helpers,
): Record<string, AuditedTemplateExtension> {
  return {
    "authentication.password": {
      directory: "authentication/password",
      creates: [
        {
          path: "src/repository/Authentication.ts",
          source: "files/Authentication.ts",
        },
        {
          path: "src/services/authenticationService.ts",
          source: "files/authenticationService.ts",
        },
        {
          path: "src/controllers/authenticationController.ts",
          source: "files/authenticationController.ts",
        },
        {
          path: "src/routes/authenticationRoutes.ts",
          source: "files/authenticationRoutes.ts",
        },
      ],
      modifications,
      packages: [
        "express",
        "zod",
        "bcrypt",
        "jsonwebtoken",
        "drizzle-orm",
        "vitest",
      ],
      prerequisites: {
        "src/config/database.ts": ["database"],
        "src/services/authenticationDelivery.ts": [
          "deliverAuthenticationToken",
        ],
      },
      composes: [
        ...["error-handler", "middleware", "api-response", "validation"].map(
          (name) => `backend.${name}`,
        ),
        "authentication.jwt",
      ],
      async render(context) {
        await helpers.assertPackagePins(context, true);
        const min = context.inputs.minPasswordLength;
        if (!Number.isInteger(min) || Number(min) < 12 || Number(min) > 64)
          throw new Error(
            "Audited password policy requires 12–64 minimum characters and at most 72 UTF-8 bytes",
          );
        const artifacts = new Map<string, TemplateArtifact>(),
          overlay = new Map<string, string>();
        const include = (artifact: TemplateArtifact) => {
          const previous = artifacts.get(artifact.path);
          artifacts.set(artifact.path, {
            ...artifact,
            ...(previous ? { before: previous.before } : {}),
          });
          overlay.set(artifact.path, artifact.content);
        };
        const scoped = {
          ...context,
          readTarget: (relative: string) =>
            overlay.has(relative)
              ? Promise.resolve(overlay.get(relative)!)
              : context.readTarget(relative),
        };
        for (const name of [
          "error-handler",
          "middleware",
          "api-response",
          "validation",
        ]) {
          const child = await context.renderDependency(
            `backend.${name}`,
            {},
            overlay,
          );
          for (const artifact of child.artifacts) include(artifact);
        }
        include(
          await helpers.appendSchema(
            scoped,
            await context.readAsset("files/schema.fragment.ts"),
            [
              "userRole",
              "userStatus",
              "authTokenType",
              "userTable",
              "userProfileTable",
              "authTokenTable",
            ],
          ),
        );
        include(
          await helpers.helperEnvironment(scoped, [
            {
              name: "SALT_ROUNDS",
              type: "number",
              value: "Number(process.env.SALT_ROUNDS ?? 12)",
              required: false,
            },
          ]),
        );
        for (const [path, content] of [
          [
            "src/repository/Authentication.ts",
            await repository(context, Number(min)),
          ],
          ["src/services/authIdentity.ts", identity],
          ["src/services/authenticationService.ts", service],
          ["src/controllers/authenticationController.ts", controller],
          ["src/routes/authenticationRoutes.ts", routes(Number(min))],
        ])
          include({ path, content, kind: "code" });
        const jwt = await context.renderDependency(
          "authentication.jwt",
          {},
          overlay,
        );
        for (const artifact of jwt.artifacts) include(artifact);
        const mounted = await helpers.mount(
          scoped,
          "authenticationRoutes",
          "authenticationRoutes",
        );
        const logger = "app.use(morgan(':method :status :response-time ms'));";
        if (!mounted.content.includes(logger))
          mounted.content = exact(
            mounted.content,
            "app.use(morgan('dev'));",
            logger,
          );
        else if (mounted.content.split(logger).length !== 2)
          throw new Error("Ambiguous authentication access logger");
        include(mounted);
        include({
          path: "tests/authenticationPassword.test.ts",
          content: passwordTests,
          kind: "test",
        });
        const result = [...artifacts.values()];
        return {
          artifacts: result,
          outputs: {
            files: result.map((item) => item.path),
            exports: [
              "AuthenticationRepository",
              "AuthenticationService",
              "AuthenticationController",
              "authenticationRoutes",
              "resolveAuthenticationIdentity",
            ],
            routes: [
              "POST /api/auth/register",
              "POST /api/auth/login",
              "GET /api/auth/me",
              "POST /api/auth/forgot-password",
              "POST /api/auth/reset-password/:resetToken",
              "POST /api/auth/verify-email/:verifyToken",
              "POST /api/auth/logout",
              "POST /api/auth/refresh",
            ],
          },
        };
      },
    },
  };
}
