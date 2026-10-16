import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { authorize, canonical, Conflict, Denied, event, hash, readReleased, withTenant, type Principal } from "./axiomera-pg-service.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idemPattern=/^[A-Za-z0-9._:-]{8,120}$/;
const workerPattern=/^[A-Za-z0-9._:-]{5,80}$/;
const allowedReaders=["OWNER","ANALYST","REVIEWER","AUDITOR"];
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

type WorkRow={id:string;report_id:string;format:string;generation:number;attempts:number;lease_owner:string};
type ReportRow={status:string;payload:unknown;digest:string};

function validatedReport(r:ReportRow|undefined):Record<string,unknown>{
 if(!r||r.status!=="RELEASED")throw new Denied("report unavailable");
 if(hash(r.payload)!==r.digest)throw new Conflict("report digest mismatch");
 return r.payload as Record<string,unknown>;
}
function csvField(v:string){
 // Prevent formula injection even if an upstream validation policy changes.
 if(/^[=+\-@\t\r]/.test(v))throw new Conflict("spreadsheet formula-like text refused");
 return '"'+v.replace(/"/g,'""')+'"';
}
export function renderExport(payload:unknown,format:"CSV"|"JSON"):Buffer {
 if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Conflict("invalid frozen snapshot");
 const p=payload as {lines?:unknown};
 if(!Array.isArray(p.lines)||p.lines.length>10000)throw new Conflict("invalid export rowset");
 const rows=p.lines.map(value=>{
   if(!value||typeof value!=="object")throw new Conflict("bad output row");
   const r=value as Record<string,unknown>;
   if(typeof r.branch!=="string"||typeof r.currency!=="string"||typeof r.amount!=="string"||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(r.branch)||
      !/^(?:INR|USD|GBP|EUR)$/.test(r.currency)||
      !/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,4})?$/.test(r.amount))
      throw new Conflict("invalid output value");
   return {branch:r.branch,currency:r.currency,amount:r.amount};
 });
 const output=format==="JSON"?canonical(payload):
   ["branch,currency,amount",...rows.map(r=>[r.branch,r.currency,r.amount].map(csvField).join(","))].join("\r\n")+"\r\n";
 const bytes=Buffer.from(output,"utf8");
 if(bytes.length>1_048_576)throw new Conflict("export exceeds pilot limit");
 return bytes;
}
export async function queueExport(db:PrismaClient,p:Principal,reportId:string,idempotencyKey:string,format:"CSV"|"JSON"){
 if(!uuid.test(reportId)||!idemPattern.test(idempotencyKey)||!["CSV","JSON"].includes(format))throw new Denied();
 return withTenant(db,p,async tx=>{
   await authorize(tx,p,allowedReaders);
   const reports=await tx.$queryRawUnsafe<ReportRow[]>(
     "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE",
     p.tenantId,reportId);
   validatedReport(reports[0]);
   const jobs=await tx.$queryRawUnsafe<{id:string;format:string}[]>(
     "SELECT id,format FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid AND requester=$2 AND report_id=$3::uuid AND idem=$4",
     p.tenantId,p.subject,reportId,idempotencyKey);
   if(jobs[0]){
     if(jobs[0].format!==format)throw new Conflict("export idempotency mismatch");
     return {id:jobs[0].id,replayed:true};
   }
   const id=randomUUID();
   // Unique constraint is the concurrency arbiter for the tenant+requester+report+key tuple.
   await tx.$executeRawUnsafe(
     "INSERT INTO axiomera_service_ci.export_jobs(tenant_id,id,report_id,requester,idem,format,state) "+
     "VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'QUEUED')",
     p.tenantId,id,reportId,p.subject,idempotencyKey,format);
   await event(tx,p,"export.queued",id);
   return {id,replayed:false};
 });
}
export async function claimExport(db:PrismaClient,p:Principal,workerId:string){
 if(!workerPattern.test(workerId))throw new Denied("invalid worker");
 return withTenant(db,p,async tx=>{
   await authorize(tx,p,["WORKER"]);
   const candidate=await tx.$queryRawUnsafe<{id:string}[]>(
     "SELECT id FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid "+
     "AND ((state='QUEUED') OR (state='LEASED' AND lease_until<clock_timestamp())) "+
     "AND attempts<3 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",p.tenantId);
   if(!candidate[0])return null;
   const row=await tx.$queryRawUnsafe<WorkRow[]>(
     "UPDATE axiomera_service_ci.export_jobs "+
     "SET state='LEASED', attempts=attempts+1, generation=generation+1, "+
     "lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' "+
     "WHERE tenant_id=$2::uuid AND id=$3::uuid "+
     "RETURNING id,report_id,format,generation,attempts,lease_owner",
     workerId,p.tenantId,candidate[0].id);
   if(!row[0])throw new Conflict("lost queue claim");
   await event(tx,p,"export.claimed",row[0].id);
   return row[0];
 });
}
export async function completeExport(db:PrismaClient,p:Principal,job:WorkRow,bytes:Buffer){
 if(!uuid.test(job.id)||!workerPattern.test(job.lease_owner)||job.generation<1)throw new Denied();
 if(bytes.length>1_048_576)throw new Conflict("too large");
 return withTenant(db,p,async tx=>{
   await authorize(tx,p,["WORKER"]);
   const lock=await tx.$queryRawUnsafe<
     {report_id:string;format:"CSV"|"JSON";generation:number;lease_owner:string;state:string;valid:boolean}[]>(
     "SELECT report_id,format,generation,lease_owner,state,(lease_until>clock_timestamp()) AS valid "+
     "FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
     p.tenantId,job.id);
   const current=lock[0];
   if(!current||current.state!=="LEASED"||!current.valid||
     current.generation!==job.generation||current.lease_owner!==job.lease_owner)throw new Conflict("stale lease");
   const report=await tx.$queryRawUnsafe<ReportRow[]>(
     "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
     p.tenantId,current.report_id);
   const payload=validatedReport(report[0]);
   const expected=renderExport(payload,current.format);
   if(!expected.equals(bytes))throw new Conflict("export bytes do not match frozen report");
   const sha=digest(bytes);
   await tx.$executeRawUnsafe(
     "UPDATE axiomera_service_ci.export_jobs SET state='DONE', artifact=$1,artifact_sha256=$2,"+
     "artifact_length=$3,lease_until=NULL WHERE tenant_id=$4::uuid AND id=$5::uuid",
     bytes,sha,bytes.length,p.tenantId,job.id);
   await event(tx,p,"export.complete",job.id);
   return {id:job.id,sha256:sha,length:bytes.length};
 });
}
export async function processOneExport(db:PrismaClient,p:Principal,workerId:string){
 const job=await claimExport(db,p,workerId);
 if(!job)return null;
 const snapshot=await withTenant(db,p,async tx=>{
   await authorize(tx,p,["WORKER"]);
   const r=await tx.$queryRawUnsafe<ReportRow[]>(
     "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
     p.tenantId,job.report_id);
   return validatedReport(r[0]);
 });
 return completeExport(db,p,job,renderExport(snapshot,job.format as "CSV"|"JSON"));
}
export async function fetchExport(db:PrismaClient,p:Principal,id:string){
 if(!uuid.test(id))throw new Denied();
 return withTenant(db,p,async tx=>{
   await authorize(tx,p,allowedReaders);
   const jobs=await tx.$queryRawUnsafe<
     {report_id:string;requester:string;format:string;state:string;artifact:Buffer|null;artifact_sha256:string|null;artifact_length:number|null}[]>(
     "SELECT report_id,requester,format,state,artifact,artifact_sha256,artifact_length "+
     "FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid",
     p.tenantId,id);
   const job=jobs[0];
   if(!job||job.state!=="DONE"||!job.artifact||!job.artifact_sha256||
       job.artifact.length!==job.artifact_length)throw new Denied("export not available");
   // Download-time re-authorization of report and digest (including after revocation).
   const report=await tx.$queryRawUnsafe<ReportRow[]>(
     "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
     p.tenantId,job.report_id);
   validatedReport(report[0]);
   if(digest(job.artifact)!==job.artifact_sha256||
     !renderExport(report[0].payload,job.format as "CSV"|"JSON").equals(job.artifact))
     throw new Conflict("artifact verification failed");
   return {body:job.artifact,mime:job.format==="CSV"?"text/csv; charset=utf-8":"application/json",
     sha256:job.artifact_sha256};
 });
}
