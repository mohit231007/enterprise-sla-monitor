import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { authorize, Conflict, Denied, event, hash, withTenant, type Principal } from "./axiomera-pg-service.js";
import { claimExport, renderExport } from "./axiomera-pg-export.js";
import { makeObjectKey, type ImmutableObjectStore } from "./axiomera-object-store.js";

type Frozen={status:string;payload:unknown;digest:string};
type Job={id:string;report_id:string;format:"CSV"|"JSON";generation:number;attempts:number;lease_owner:string};
type ArtifactRow={report_id:string;format:"CSV"|"JSON";state:string;object_key:string|null;artifact_sha256:string|null;artifact_length:number|null};
const checksum=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const readerRoles=["OWNER","ANALYST","REVIEWER","AUDITOR"];
function approved(x:Frozen|undefined):unknown{
  if(!x||x.status!=="RELEASED")throw new Denied("report not released");
  if(hash(x.payload)!==x.digest)throw new Conflict("frozen snapshot mismatch");
  return x.payload;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Reference two-phase storage integration:
 * 1) write immutable content-addressed object,
 * 2) commit fenced PostgreSQL publication metadata.
 * A crash between steps may leave an orphan object. Production requires orphan GC and
 * a managed object provider implementing WORM/retention policies.
 */
export async function processOneObjectExport(db:PrismaClient,p:Principal,worker:string,store:ImmutableObjectStore){
  const job=await claimExport(db,p,worker);
  if(!job)return null;
  const snapshot=await withTenant(db,p,async tx=>{
    await authorize(tx,p,["WORKER"]);
    const r=await tx.$queryRawUnsafe<Frozen[]>(
      "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
      p.tenantId,job.report_id);
    return approved(r[0]);
  });
  const bytes=renderExport(snapshot,job.format as "CSV"|"JSON");
  const key=makeObjectKey(p.tenantId,job.id,bytes);
  await store.putImmutable(key,bytes);
  return withTenant(db,p,async tx=>{
    await authorize(tx,p,["WORKER"]);
    const rows=await tx.$queryRawUnsafe<
      {report_id:string;state:string;generation:number;lease_owner:string;valid:boolean;format:"CSV"|"JSON"}[]>(
      "SELECT report_id,state,generation,lease_owner,(lease_until>clock_timestamp()) AS valid,format "+
      "FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
      p.tenantId,job.id);
    const row=rows[0];
    if(!row||row.state!=="LEASED"||!row.valid||row.generation!==job.generation||
       row.lease_owner!==job.lease_owner)throw new Conflict("worker lease lost before publication");
    const current=await tx.$queryRawUnsafe<Frozen[]>(
      "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
      p.tenantId,row.report_id);
    const recomputed=renderExport(approved(current[0]),row.format);
    if(!recomputed.equals(bytes))throw new Conflict("snapshot differs from staged bytes");
    await tx.$executeRawUnsafe(
      "UPDATE axiomera_service_ci.export_jobs SET state='DONE',artifact=NULL,object_key=$1,"+
      "artifact_sha256=$2,artifact_length=$3,lease_until=NULL "+
      "WHERE tenant_id=$4::uuid AND id=$5::uuid",
      key,checksum(bytes),bytes.length,p.tenantId,job.id);
    await event(tx,p,"export.object.complete",job.id);
    return {id:job.id,key,sha256:checksum(bytes),length:bytes.length};
  });
}
/** Enforce policy at download time; return bytes, not provider-issued public presigned URLs. */
export async function fetchObjectExport(db:PrismaClient,p:Principal,id:string,store:ImmutableObjectStore){
  if(!uuid.test(id))throw new Denied();
  async function readMetadata(){
    return withTenant(db,p,async tx=>{
      await authorize(tx,p,readerRoles);
      const jobs=await tx.$queryRawUnsafe<ArtifactRow[]>(
        "SELECT report_id,format,state,object_key,artifact_sha256,artifact_length "+
        "FROM axiomera_service_ci.export_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid",
        p.tenantId,id);
      const job=jobs[0];
      if(!job||job.state!=="DONE"||!job.object_key||!job.artifact_sha256||
         job.artifact_length===null)throw new Denied("object unavailable");
      const reports=await tx.$queryRawUnsafe<Frozen[]>(
        "SELECT status,payload,digest FROM axiomera_service_ci.reports WHERE tenant_id=$1::uuid AND id=$2::uuid",
        p.tenantId,job.report_id);
      return {job,expected:renderExport(approved(reports[0]),job.format)};
    });
  }
  const first=await readMetadata();
  let bytes:Buffer;
  try{bytes=await store.read(first.job.object_key!);}catch{throw new Conflict("object storage verification failed");}
  if(bytes.length!==first.job.artifact_length||checksum(bytes)!==first.job.artifact_sha256||
     !bytes.equals(first.expected))throw new Conflict("object content mismatch");
  const second=await readMetadata(); // Recheck user membership/report status after storage I/O.
  if(second.job.object_key!==first.job.object_key||
     second.job.artifact_sha256!==first.job.artifact_sha256||
     !second.expected.equals(bytes))throw new Conflict("object publication changed");
  return {body:bytes,sha256:checksum(bytes),
    mime:first.job.format==="CSV"?"text/csv; charset=utf-8":"application/json"};
}
