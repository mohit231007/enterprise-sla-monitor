import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

// Isolated PostgreSQL application service core. No HTTP route is registered.
// An upstream verified OIDC principal is REQUIRED, and the DB role must be non-owner/NOBYPASSRLS.
export type Principal = { tenantId: string; subject: string };
export type Fact = { branch: string; date: string; amount: string; currency: string; source: string };
type Tx = Prisma.TransactionClient;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,4})?$/;
export class Denied extends Error {}
export class Conflict extends Error {}
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if(x !== null && typeof x === "object") {
    const o=x as Record<string,unknown>;
    return "{" + Object.keys(o).sort().map(k=>JSON.stringify(k)+":"+canonical(o[k])).join(",")+"}";
  }
  return JSON.stringify(x);
}
export const hash = (x:unknown) => createHash("sha256").update(canonical(x)).digest("hex");
export async function withTenant<T>(db:PrismaClient,p:Principal,fn:(tx:Tx)=>Promise<T>):Promise<T> {
  if(!uuid.test(p.tenantId)||!p.subject||p.subject.length>120) throw new Denied("invalid scoped identity");
  return db.$transaction(async tx=>{
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)",p.tenantId);
    return fn(tx);
  });
}
export async function authorize(tx:Tx,p:Principal,allowed:string[]) {
  const r=await tx.$queryRawUnsafe<{role:string}[]>(
    "SELECT role FROM axiomera_service_ci.memberships WHERE tenant_id=$1::uuid AND subject=$2 AND status='ACTIVE'",
    p.tenantId,p.subject);
  if(!r[0]||!allowed.includes(r[0].role))throw new Denied("not found");
}
export async function event(tx:Tx,p:Principal,op:string,id:string) {
  await tx.$executeRawUnsafe(
    "INSERT INTO axiomera_service_ci.events(tenant_id,actor,operation,subject_id) VALUES ($1::uuid,$2,$3,$4)",
    p.tenantId,p.subject,op,id);
}
export async function ingest(db:PrismaClient,p:Principal,dataset:string,rows:Fact[],idem:string) {
  if(!/^[a-z][a-z0-9_]{1,39}$/.test(dataset)||!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)||
     rows.length<1||rows.length>1000)throw new Denied("invalid ingest contract");
  const logical=new Set<string>();
  for(const r of rows){
    const day=new Date(r.date+"T00:00:00.000Z");
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(r.branch)||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(day.valueOf())||
      day.toISOString().slice(0,10)!==r.date||!money.test(r.amount)||
      !["INR","USD","GBP","EUR"].includes(r.currency)||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,119}$/.test(r.source))throw new Denied("invalid fact");
    const key=r.branch+"|"+r.date+"|"+r.currency;
    if(logical.has(key))throw new Denied("duplicate logical key within batch");
    logical.add(key);
  }
  return withTenant(db,p,async tx=>{
    await authorize(tx,p,["OWNER","INGESTOR"]);
    await tx.$queryRawUnsafe("SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))",
      "ingest:"+p.tenantId+":"+dataset+":"+idem);
    const checksum=hash({dataset,rows});
    const prior=await tx.$queryRawUnsafe<{id:string;digest:string;received:number}[]>(
      "SELECT id,digest,received FROM axiomera_service_ci.runs WHERE tenant_id=$1::uuid AND dataset=$2 AND idem=$3",
      p.tenantId,dataset,idem);
    if(prior[0]) {
      if(prior[0].digest!==checksum)throw new Conflict("idempotency mismatch");
      return {id:prior[0].id,replayed:true,received:prior[0].received};
    }
    const id=randomUUID();
    await tx.$executeRawUnsafe("INSERT INTO axiomera_service_ci.runs VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)",
      p.tenantId,id,dataset,idem,checksum,rows.length);
    for(const row of rows)
      await tx.$executeRawUnsafe(
        "INSERT INTO axiomera_service_ci.facts(tenant_id,run_id,dataset,branch,date,amount,currency,source) VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6::numeric,$7,$8)",
        p.tenantId,id,dataset,row.branch,row.date,row.amount,row.currency,row.source);
    await event(tx,p,"ingest",id);
    return {id,replayed:false,received:rows.length};
  });
}
export async function freeze(db:PrismaClient,p:Principal,dataset:string,asOf?:string) {
  if(!/^[a-z][a-z0-9_]{1,39}$/.test(dataset))throw new Denied();
  const cutoff=asOf??new Date().toISOString();
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(cutoff)||!Number.isFinite(Date.parse(cutoff)))throw new Denied("offset-qualified cutoff required");
  return withTenant(db,p,async tx=>{
    await authorize(tx,p,["OWNER","ANALYST"]);
    const rows=await tx.$queryRawUnsafe<{branch:string;currency:string;amount:string}[]>(
      "WITH ranked AS (SELECT branch,currency,date,amount,ROW_NUMBER() OVER "+
      "(PARTITION BY tenant_id,dataset,branch,date,currency ORDER BY accepted_at DESC,id DESC) rn "+
      "FROM axiomera_service_ci.facts WHERE tenant_id=$1::uuid AND dataset=$2 "+
      "AND accepted_at<=$3::timestamptz) "+
      "SELECT branch,currency,SUM(amount)::text AS amount FROM ranked WHERE rn=1 "+
      "GROUP BY branch,currency ORDER BY branch,currency",
      p.tenantId,dataset,cutoff);
    const payload={tenant:p.tenantId,dataset,cutoff:new Date(cutoff).toISOString(),
      lines:rows,metric:"revenue_sum.v1"};
    const id=randomUUID(),digest=hash(payload);
    await tx.$executeRawUnsafe(
      "INSERT INTO axiomera_service_ci.reports(tenant_id,id,maker,status,payload,digest) VALUES($1::uuid,$2::uuid,$3,'DRAFT',$4::jsonb,$5)",
      p.tenantId,id,p.subject,canonical(payload),digest);
    await event(tx,p,"report.draft",id);
    return {id,payload,digest,status:"DRAFT"};
  });
}
export async function approve(db:PrismaClient,p:Principal,id:string) {
  if(!uuid.test(id))throw new Denied();
  return withTenant(db,p,async tx=>{
    await authorize(tx,p,["OWNER","REVIEWER"]);
    const r=await tx.$queryRawUnsafe<{maker:string;status:string;payload:unknown;digest:string}[]>(
      "SELECT maker,status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
      p.tenantId,id);
    if(!r[0]||r[0].maker===p.subject)throw new Denied();
    if(hash(r[0].payload)!==r[0].digest)throw new Conflict("frozen report tampered");
    if(r[0].status==="RELEASED")return {id,replayed:true};
    await tx.$executeRawUnsafe("UPDATE axiomera_service_ci.reports SET status='RELEASED',checker=$1 WHERE tenant_id=$2::uuid AND id=$3::uuid",
      p.subject,p.tenantId,id);
    await event(tx,p,"report.release",id);
    return {id,replayed:false};
  });
}
export async function readReleased(db:PrismaClient,p:Principal,id:string) {
  if(!uuid.test(id))throw new Denied();
  return withTenant(db,p,async tx=>{
    await authorize(tx,p,["OWNER","ANALYST","REVIEWER","AUDITOR"]);
    const r=await tx.$queryRawUnsafe<{status:string;payload:unknown;digest:string}[]>(
      "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
      p.tenantId,id);
    if(!r[0]||r[0].status!=="RELEASED")throw new Denied();
    if(hash(r[0].payload)!==r[0].digest)throw new Conflict("frozen report tampered");
    return {id,digest:r[0].digest,payload:r[0].payload};
  });
}