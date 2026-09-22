/** Reviewed source strings, never evaluated or interpreted as user-supplied templates. */
export const apiClientSource = String.raw`import { ENV } from './env';
export class ApiError extends Error { constructor(message:string,public readonly status:number){super(message);this.name='ApiError';} }
export interface ApiSuccess<T>{message:string;data:T}
export interface PaginationMeta{page:number;pageSize:number;total:number;totalPages:number}
export interface ApiPaginated<T>{message:string;data:T[];pagination:PaginationMeta}
export interface ApiOptions{method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';body?:string;signal?:AbortSignal}
export function apiUrl(path:string):string {
  if(typeof path!=='string'||path.length>4096||/[\\#\u0000-\u0020\u007f]/.test(path)||!/^\/api\/[A-Za-z0-9_/-]+(?:\?[^#]*)?$/.test(path))throw new ApiError('Invalid API path',400);
  const target=new URL(path,ENV.API_URL);
  if(target.origin!==ENV.API_URL||!target.pathname.startsWith('/api/')||target.pathname.includes('//')||target.pathname.split('/').some(part=>part==='.'||part==='..'))throw new ApiError('Invalid API path',400);
  return target.href;
}
export async function apiFetch<T>(path:string,options:ApiOptions={}):Promise<T>{
  const target=apiUrl(path),method=options.method??'GET';
  if(!['GET','POST','PUT','PATCH','DELETE'].includes(method)||Object.keys(options).some(key=>!['method','body','signal'].includes(key))||
    (options.body!==undefined&&(typeof options.body!=='string'||new TextEncoder().encode(options.body).length>65536||method==='GET')))throw new ApiError('Invalid API request',400);
  if(options.body!==undefined){try{JSON.parse(options.body);}catch{throw new ApiError('Invalid JSON request',400);}}
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  try {
    const response=await fetch(target,{method,body:options.body,signal,credentials:'include',redirect:'error',cache:'no-store',headers:{Accept:'application/json',...(options.body===undefined?{}:{'Content-Type':'application/json'})}});
    if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===401?'Authentication required':response.status===403?'Access denied':response.status===429?'Too many requests':'Request failed',response.status);}
    if(response.status===204)return undefined as T;
    if(response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){await response.body?.cancel();throw new ApiError('Invalid API response',502);}
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>1048576)){await response.body?.cancel();throw new ApiError('API response exceeds limit',502);}
    const reader=response.body?.getReader();if(!reader)throw new ApiError('Invalid API response',502);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>1048576||chunks.length>=2048)throw new ApiError('API response exceeds limit',502);chunks.push(result.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;}catch{throw new ApiError('Invalid API response',502);}
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(signal.aborted?'Request cancelled or timed out':'Network request failed',0);}
}
`;

export const formSource = String.raw`'use client';
import {useCallback,useEffect,useRef,useState,type ChangeEvent,type FormEvent} from 'react';
import {ApiError} from '../apiClient';
export type FieldErrors<T>=Partial<Record<keyof T,string>>;
export interface UseFormStateResult<T>{values:T;errors:FieldErrors<T>;formError:string|null;isSubmitting:boolean;setValue:<K extends keyof T>(field:K,value:T[K])=>void;setErrors:(errors:FieldErrors<T>)=>void;handleChange:<K extends keyof T>(field:K)=>(event:ChangeEvent<HTMLInputElement>)=>void;handleSubmit:(submit:(values:Readonly<T>)=>Promise<void>)=>(event:FormEvent)=>Promise<void>}
export function useFormState<T extends Record<string,string>>(initialValues:T):UseFormStateResult<T>{
  const [values,setValues]=useState<T>(()=>({...initialValues})),[errors,setErrors]=useState<FieldErrors<T>>({}),[formError,setFormError]=useState<string|null>(null),[isSubmitting,setSubmitting]=useState(false);
  const valuesRef=useRef(values),busy=useRef(false),mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const setValue=useCallback(<K extends keyof T>(field:K,value:T[K])=>{if(!Object.hasOwn(valuesRef.current,field)||typeof value!=='string'||value.length>65536)throw new Error('Invalid form field');valuesRef.current={...valuesRef.current,[field]:value};setValues(valuesRef.current);setErrors(previous=>({...previous,[field]:undefined}));},[]);
  const handleChange=useCallback(<K extends keyof T>(field:K)=>(event:ChangeEvent<HTMLInputElement>)=>setValue(field,event.currentTarget.value as T[K]),[setValue]);
  const handleSubmit=useCallback((submit:(values:Readonly<T>)=>Promise<void>)=>async(event:FormEvent)=>{event.preventDefault();if(busy.current)return;busy.current=true;setSubmitting(true);setFormError(null);const snapshot=Object.freeze({...valuesRef.current});try{await submit(snapshot);}catch(error){if(mounted.current)setFormError(error instanceof ApiError?error.message:'Submission failed');}finally{busy.current=false;if(mounted.current)setSubmitting(false);}},[]);
  return {values,errors,formError,isSubmitting,setValue,setErrors,handleChange,handleSubmit};
}
`;

export function tableSource(defaultPageSize: number) {
  return String.raw`'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {apiFetch,apiUrl,ApiError,type ApiPaginated,type PaginationMeta} from '../apiClient';
export type SortDir='asc'|'desc';
export interface UseQueryTableResult<T>{rows:T[];meta:PaginationMeta|null;page:number;setPage:(value:number)=>void;sortBy:string|undefined;sortDir:SortDir;setSort:(field:string)=>void;filters:Record<string,string>;setFilter:(field:string,value:string)=>void;isLoading:boolean;error:string|null;refetch:()=>void}
const reserved=new Set(['page','pageSize','sortBy','sortDir','__proto__','constructor','prototype']);
function field(value:string){if(typeof value!=='string'||/^[A-Za-z][A-Za-z0-9_]{0,47}$/.exec(value)?.[0]!==value||reserved.has(value))throw new Error('Invalid table field');return value;}
export function useQueryTable<T>(basePath:string,initialPageSize=${defaultPageSize}):UseQueryTableResult<T>{
  if(!Number.isInteger(initialPageSize)||initialPageSize<1||initialPageSize>100)throw new Error('Invalid table page size');
  if(basePath.includes('?'))throw new Error('Table base path must not contain query parameters');apiUrl(basePath);
  const [page,pageState]=useState(1),[sort,setSortState]=useState<{by?:string;dir:SortDir}>({dir:'asc'}),[filters,setFilters]=useState<Record<string,string>>({}),[revision,setRevision]=useState(0);
  const [state,setState]=useState<{rows:T[];meta:PaginationMeta|null;isLoading:boolean;error:string|null}>({rows:[],meta:null,isLoading:true,error:null});
  const filtersRef=useRef(filters);
  const setPage=useCallback((value:number)=>{if(!Number.isInteger(value)||value<1||value>1000000)throw new Error('Invalid table page');pageState(value);},[]);
  const setSort=useCallback((name:string)=>{field(name);pageState(1);setSortState(previous=>({by:name,dir:previous.by===name&&previous.dir==='asc'?'desc':'asc'}));},[]);
  const setFilter=useCallback((name:string,value:string)=>{field(name);if(typeof value!=='string'||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Invalid table filter');const previous=filtersRef.current;if(value&&!Object.hasOwn(previous,name)&&Object.keys(previous).length>=8)throw new Error('Too many filters');const next={...previous};if(value)next[name]=value;else delete next[name];filtersRef.current=next;pageState(1);setFilters(next);},[]);
  const refetch=useCallback(()=>setRevision(value=>value+1),[]);
  const query=useMemo(()=>{const params=new URLSearchParams({page:String(page),pageSize:String(initialPageSize)});if(sort.by){params.set('sortBy',sort.by);params.set('sortDir',sort.dir);}for(const [name,value] of Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)))params.set(name,value);return basePath+'?'+params.toString();},[basePath,page,initialPageSize,sort,filters]);
  useEffect(()=>{let current=true;const controller=new AbortController();setState({rows:[],meta:null,isLoading:true,error:null});
    apiFetch<ApiPaginated<T>>(query,{signal:controller.signal}).then(result=>{if(!current)return;const meta=result?.pagination;
      if(!Array.isArray(result?.data)||result.data.length>initialPageSize||result.data.some(row=>!row||typeof row!=='object'||Array.isArray(row))||!meta||!['page','pageSize','total','totalPages'].every(key=>Number.isSafeInteger(meta[key as keyof PaginationMeta]))||meta.page!==page||meta.pageSize!==initialPageSize||meta.total<0||meta.totalPages!==Math.ceil(meta.total/meta.pageSize))throw new ApiError('Invalid pagination response',502);
      setState({rows:result.data,meta,isLoading:false,error:null});
    }).catch(error=>{if(current)setState({rows:[],meta:null,isLoading:false,error:error instanceof ApiError?error.message:'Failed to load data'});});
    return()=>{current=false;controller.abort();};
  },[query,revision,page,initialPageSize]);
  return {...state,page,setPage,sortBy:sort.by,sortDir:sort.dir,setSort,filters,setFilter,refetch};
}
`;
}

export const dataTableSource = String.raw`'use client';
import type {ReactNode} from 'react';
import type {UseQueryTableResult} from '../lib/tables/useQueryTable';
export interface Column<T>{key:keyof T;label:string;sortable?:boolean;render?:(row:T)=>ReactNode}
export interface DataTableProps<T>{table:UseQueryTableResult<T>;columns:Column<T>[];getRowId:(row:T)=>string}
function cell(value:unknown):string{return value===null||value===undefined?'':['string','number','boolean'].includes(typeof value)?String(value).slice(0,4096):'[Unsupported value]';}
export function DataTable<T>({table,columns,getRowId}:DataTableProps<T>){
  if(columns.length<1||columns.length>32)throw new Error('Table requires 1–32 columns');
  const {rows,meta,page,setPage,sortBy,sortDir,setSort,isLoading,error}=table;
  if(error)return <p role="alert">{error}</p>;
  return <div><table aria-busy={isLoading}><thead><tr>{columns.map(column=><th key={String(column.key)} scope="col" aria-sort={sortBy===String(column.key)?sortDir==='asc'?'ascending':'descending':'none'}>{column.sortable?<button type="button" disabled={isLoading} onClick={()=>setSort(String(column.key))}>{column.label}</button>:column.label}</th>)}</tr></thead>
  <tbody>{isLoading?<tr><td colSpan={columns.length}>Loading…</td></tr>:!rows.length?<tr><td colSpan={columns.length}>No results</td></tr>:rows.map(row=><tr key={getRowId(row)}>{columns.map(column=><td key={String(column.key)}>{column.render?column.render(row):cell(row[column.key])}</td>)}</tr>)}</tbody></table>
  {meta&&<nav aria-label="Table pagination"><button type="button" disabled={isLoading||page<=1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {meta.page} of {meta.totalPages}</span><button type="button" disabled={isLoading||page>=meta.totalPages} onClick={()=>setPage(page+1)}>Next</button></nav>}</div>;
}
`;

export const authSource = String.raw`'use client';
import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {apiFetch,ApiError,type ApiSuccess} from '../apiClient';
export interface AuthUser{id:string;email:string;role:'customer'|'admin';status:'active';emailVerifiedAt:string|null;firstName:string;lastName:string}
export interface Registration{firstName:string;lastName:string;email:string;password:string}
interface AuthContextValue{user:AuthUser|null;isLoading:boolean;error:string|null;login:(email:string,password:string)=>Promise<void>;register:(data:Registration)=>Promise<void>;logout:()=>Promise<void>;refetch:()=>Promise<void>}
const AuthContext=createContext<AuthContextValue|undefined>(undefined);
// Serialize cookie-mutating session requests so stale hydration cannot replace a newer login/logout cookie.
let sessionQueue:Promise<unknown>=Promise.resolve();
function session<T>(operation:()=>Promise<T>):Promise<T>{const coordinated=async():Promise<T>=>{if(typeof navigator==='undefined'||!navigator.locks)throw new ApiError('This browser cannot safely coordinate authentication',0);return await navigator.locks.request('graph-auth-session',{mode:'exclusive',signal:AbortSignal.timeout(60000)},operation);};const next=sessionQueue.then(coordinated,coordinated);sessionQueue=next.then(()=>undefined,()=>undefined);return next;}
function readUser(result:ApiSuccess<{user:AuthUser}>):AuthUser {const user=result?.data?.user;if(!user||typeof user.id!=='string'||user.id.length>128||typeof user.email!=='string'||user.email.length>320||!['customer','admin'].includes(user.role)||user.status!=='active'||typeof user.firstName!=='string'||user.firstName.length>100||typeof user.lastName!=='string'||user.lastName.length>100||(user.emailVerifiedAt!==null&&(typeof user.emailVerifiedAt!=='string'||!Number.isFinite(Date.parse(user.emailVerifiedAt)))))throw new ApiError('Invalid authentication response',502);return {id:user.id,email:user.email,role:user.role,status:user.status,emailVerifiedAt:user.emailVerifiedAt,firstName:user.firstName,lastName:user.lastName};}
async function currentUser():Promise<AuthUser|null>{try{return readUser(await apiFetch<ApiSuccess<{user:AuthUser}>>('/api/auth/me'));}catch(error){if(!(error instanceof ApiError)||error.status!==401)throw error;}
  try{await apiFetch('/api/auth/refresh',{method:'POST'});return readUser(await apiFetch<ApiSuccess<{user:AuthUser}>>('/api/auth/me'));}catch(error){if(error instanceof ApiError&&error.status===401)return null;throw error;}
}
export function AuthProvider({children}:{children:ReactNode}){
  const [user,setUser]=useState<AuthUser|null>(null),[isLoading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),revision=useRef(0),mounted=useRef(true),pending=useRef<{version:number;request:Promise<AuthUser|null>}|null>(null);
  const refetch=useCallback(async()=>{const version=revision.current;setLoading(true);setError(null);const entry=pending.current?.version===version?pending.current:(pending.current={version,request:session(currentUser)});try{const value=await entry.request;if(mounted.current&&version===revision.current)setUser(value);}catch(failure){if(mounted.current&&version===revision.current){setUser(null);setError(failure instanceof ApiError?failure.message:'Authentication unavailable');}}finally{if(pending.current===entry)pending.current=null;if(mounted.current&&version===revision.current)setLoading(false);}},[]);
  useEffect(()=>{mounted.current=true;void refetch();return()=>{mounted.current=false;};},[refetch]);
  const login=useCallback(async(email:string,password:string)=>{const version=++revision.current;setError(null);setUser(null);setLoading(true);try{const value=await session(async()=>readUser(await apiFetch<ApiSuccess<{user:AuthUser}>>('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})})));if(mounted.current&&version===revision.current)setUser(value);}catch(failure){if(mounted.current&&version===revision.current)setError('Unable to sign in');throw failure;}finally{if(mounted.current&&version===revision.current)setLoading(false);}},[]);
  const register=useCallback(async(data:Registration)=>{await apiFetch('/api/auth/register',{method:'POST',body:JSON.stringify({firstName:data.firstName,lastName:data.lastName,email:data.email,password:data.password})});},[]);
  const logout=useCallback(async()=>{const version=++revision.current;setUser(null);setLoading(false);setError(null);try{await session(()=>apiFetch('/api/auth/logout',{method:'POST'}));}catch(failure){if(mounted.current&&version===revision.current)setError('Server logout could not be confirmed');throw failure;}},[]);
  return <AuthContext.Provider value={{user,isLoading,error,login,register,logout,refetch}}>{children}</AuthContext.Provider>;
}
export function useAuth():AuthContextValue{const value=useContext(AuthContext);if(!value)throw new Error('useAuth requires AuthProvider');return value;}
`;

export function loginSource(redirect: string) {
  return `'use client';
import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {useAuth} from '../../lib/auth/AuthContext';
export default function LoginPage(){const {login}=useAuth(),router=useRouter(),busy=useRef(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(busy.current)return;busy.current=true;setPending(true);setError(null);const form=event.currentTarget,data=new FormData(form);try{await login(String(data.get('email')??''),String(data.get('password')??''));form.reset();router.replace(${JSON.stringify(redirect)});}catch{setError('Unable to sign in');}finally{busy.current=false;setPending(false);}}
  return <main><h1>Sign in</h1><form onSubmit={submit}><label>Email<input name="email" type="email" autoComplete="username" required maxLength={320}/></label><label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={72}/></label><button type="submit" disabled={pending}>Sign in</button>{error&&<p role="alert">{error}</p>}</form><a href="/register">Create account</a></main>;
}
`;
}
export const registerSource = String.raw`'use client';
import {useRef,useState,type FormEvent} from 'react';
import {useAuth} from '../../lib/auth/AuthContext';
export default function RegisterPage(){const {register}=useAuth(),busy=useRef(false),[pending,setPending]=useState(false),[message,setMessage]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(busy.current)return;busy.current=true;setPending(true);setMessage(null);const form=event.currentTarget,data=new FormData(form);try{await register({firstName:String(data.get('firstName')??''),lastName:String(data.get('lastName')??''),email:String(data.get('email')??''),password:String(data.get('password')??'')});form.reset();setMessage('Registration received. Complete email verification before signing in.');}catch{setMessage('Unable to register');}finally{busy.current=false;setPending(false);}}
  return <main><h1>Create account</h1><form onSubmit={submit}><label>First name<input name="firstName" autoComplete="given-name" required maxLength={100}/></label><label>Last name<input name="lastName" autoComplete="family-name" required maxLength={100}/></label><label>Email<input name="email" type="email" autoComplete="username" required maxLength={320}/></label><label>Password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72}/></label><button type="submit" disabled={pending}>Register</button>{message&&<p role="status">{message}</p>}</form><a href="/login">Sign in</a></main>;
}
`;
