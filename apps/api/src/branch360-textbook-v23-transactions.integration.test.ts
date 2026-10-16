import {createHash,randomBytes} from "node:crypto";
import {Prisma,PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,expect,it} from "vitest";

// V23 source-locked exercises. Statement fragments inside textbook
// BEGIN/COMMIT are executed inside Prisma-managed transactions;
// named bind placeholders are adapted without changing the hashed source.
const b={
 "CODE-025":{sha:"a116a19d500a6e701ac04c758837a9a4ae7ab54861431d633fb0160a0cf36903",sql:`-- Session T1 and T2: disposable experiment, not standalone safe production code.
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM on_duty_approvers
WHERE tenant_id = $1 AND on_duty = true;
-- Application checks >= 2, then deactivates its own assigned approver.
UPDATE on_duty_approvers SET on_duty = false
WHERE tenant_id = $1 AND identity_id = $2;
COMMIT;
-- Under competing transactions, expect one possible 40001 serialization failure.`},
 "CODE-028":{sha:"f7504ab90a432bcafb65fa5914d5d71a8cb5883d27338a6ff15e551e14e13b13",sql:`-- PROPOSED RLS sketch. Requires a reviewed schema, grants and service role.
ALTER TABLE tenant_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_reports_scope ON tenant_reports
 USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- In a transaction after authorized membership resolution:
SELECT set_config('app.tenant_id', $1, true);
-- Follow with tenant-scoped SELECT/UPDATE using a NON-owner service role.`},
 "CODE-031":{sha:"5d4ea5696560e322bf3201acf0d52e157592ba59d8f9c06e6f7659438c6470a2",sql:`-- Training example: execute on one explicitly owned transaction connection.
BEGIN;
SELECT set_config('app.tenant_id', $1, true); -- true = transaction-local
SELECT branch_id, name FROM app.branches ORDER BY branch_id;
COMMIT;
-- At the next transaction boundary the LOCAL setting must not persist.`},
 "CODE-032":{sha:"a526d6bdd885b7902f6c1e06e7597a7c13ef9b22dabd8c7b32b88030d25bfe49",sql:`-- Proposed tenant-scoped outbox (illustrative schema).
CREATE TABLE app.outbox_events (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  topic text NOT NULL,
  aggregate_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','LEASED','SENT','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);
-- In the same transaction as a domain state change:
-- INSERT domain row ...;
-- INSERT app.outbox_events (..., state) VALUES (..., 'PENDING');
-- COMMIT;`},
 "CODE-036":{sha:"721dc00178854e4f9439d07e2261a2afe2329632214a04065bd5398d9b9e7f33",sql:`ALTER TABLE axiomera_lab.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE axiomera_lab.branches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON axiomera_lab.branches
USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);`},
 "CODE-041":{sha:"dc92c8f0bc9ea6c4571225956d8d5d3324d9a80b61a5ca3749d994874db0d08a",sql:`BEGIN;
-- Illustrative, tenant-scoped schema. These are proposed table names.
UPDATE dataset_versions
SET status='AVAILABLE', version=version+1
WHERE tenant_id=$1 AND id=$2 AND status='COMMITTED'
RETURNING id, version;
-- Require exactly one returned row; otherwise abort.
INSERT INTO outbox_events(event_id, tenant_id, kind, aggregate_id, payload, occurred_at)
VALUES($3, $1, 'dataset.available.v1', $2, $4::jsonb, now());
COMMIT;`},
 "CODE-056":{sha:"ec9d443342dc2969d8f8c902071c1f3bc052d5b43ac7a3460a044d3f19849495",sql:`BEGIN;
INSERT INTO idempotency_log (tenant_id, operation, request_key, digest, state)
VALUES ($1, 'upload', $2, $3, 'COMMITTED');
-- Bulk stage-to-fact merge and ingestion-run record occur under this BEGIN.
INSERT INTO domain_outbox (tenant_id, event_id, kind, payload)
VALUES ($1, $4, 'source-revisions-committed', $5);
COMMIT;`},
 "CODE-060":{sha:"9f3a54f08bfaf1f69bbe2b9a08ffe834722023f91082dfee31fa29cb6d15786a",sql:`UPDATE export_jobs
SET lease_owner = :worker,
    lease_until = clock_timestamp() + interval '3 minutes',
    lease_generation = lease_generation + 1,
    status = 'RUNNING'
WHERE tenant_id = :tenant AND job_id = :job
  AND (status = 'REQUESTED'
       OR (status = 'RUNNING' AND lease_until < clock_timestamp()))
RETURNING lease_generation, source_snapshot_id;`}
} as const;
const dsn=process.env.DATABASE_URL||"";
let active=false;try{const u=new URL(dsn);active=process.env.CI==="true"&&["localhost","127.0.0.1"].includes(u.hostname)&&u.port==="5432"&&u.pathname==="/branch360";}catch{}
const admin=new PrismaClient(),A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
let runtime:PrismaClient|undefined,roleCreated=false;
async function scoped<T>(db:PrismaClient,fn:(tx:Prisma.TransactionClient)=>Promise<T>){
 return db.$transaction(async tx=>{await tx.$queryRawUnsafe("SELECT set_config('search_path','textbook_v23_tx,public',true)");return fn(tx);});
}
describe.runIf(active)("native PostgreSQL transactional, RLS and fencing manuscript witnesses",()=>{
 beforeAll(async()=>{
  for(const [id,v] of Object.entries(b))expect(createHash("sha256").update(v.sql).digest("hex"),id).toBe(v.sha);
  await admin.$executeRawUnsafe("CREATE SCHEMA textbook_v23_tx");
  await admin.$executeRawUnsafe("CREATE SCHEMA app");
  await admin.$executeRawUnsafe("CREATE SCHEMA axiomera_lab");
  const password=randomBytes(22).toString("hex");
  await admin.$executeRawUnsafe("CREATE ROLE textbook_v23_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '"+password+"'");
  roleCreated=true;
  await scoped(admin,async tx=>{
    await tx.$executeRawUnsafe("CREATE TABLE tenant_reports(tenant_id uuid,report_id text,amount numeric)");
    await tx.$executeRawUnsafe("CREATE TABLE on_duty_approvers(tenant_id text,identity_id text,on_duty boolean,PRIMARY KEY(tenant_id,identity_id))");
    await tx.$executeRawUnsafe("INSERT INTO on_duty_approvers VALUES($1,'m1',true),($1,'m2',true)",A);
    await tx.$executeRawUnsafe("CREATE TABLE dataset_versions(tenant_id text,id text,status text,version int,PRIMARY KEY(tenant_id,id))");
    await tx.$executeRawUnsafe("CREATE TABLE outbox_events(event_id text,tenant_id text,kind text,aggregate_id text,payload jsonb,occurred_at timestamptz)");
    await tx.$executeRawUnsafe("CREATE TABLE idempotency_log(tenant_id text,operation text,request_key text,digest text,state text,PRIMARY KEY(tenant_id,operation,request_key))");
    await tx.$executeRawUnsafe("CREATE TABLE domain_outbox(tenant_id text,event_id text,kind text,payload text)");
    await tx.$executeRawUnsafe("CREATE TABLE export_jobs(tenant_id text,job_id text,source_snapshot_id text,status text,lease_owner text,lease_generation int,lease_until timestamptz,PRIMARY KEY(tenant_id,job_id))");
    await tx.$executeRawUnsafe("INSERT INTO dataset_versions VALUES($1,'D1','COMMITTED',1)",A);
    await tx.$executeRawUnsafe("INSERT INTO export_jobs VALUES($1,'E1','SNAP1','REQUESTED',NULL,0,NULL)",A);
    await tx.$executeRawUnsafe("INSERT INTO tenant_reports VALUES ($1::uuid,'r1',100),($2::uuid,'r2',999)",A,B);
  });
  await admin.$executeRawUnsafe("CREATE TABLE app.branches(tenant_id uuid,branch_id text,name text)");
  await admin.$executeRawUnsafe("CREATE TABLE axiomera_lab.branches(tenant_id uuid,branch_id text,name text)");
  await admin.$executeRawUnsafe("INSERT INTO app.branches VALUES ($1::uuid,'one','A'),($2::uuid,'two','B')",A,B);
  await admin.$executeRawUnsafe("INSERT INTO axiomera_lab.branches VALUES ($1::uuid,'one','A'),($2::uuid,'two','B')",A,B);
  for(const sql of b["CODE-028"].sql.split(";\n").slice(0,3))await scoped(admin,tx=>tx.$executeRawUnsafe(sql));
  for(const sql of b["CODE-036"].sql.split(";\n"))await admin.$executeRawUnsafe(sql);
  await admin.$executeRawUnsafe("ALTER TABLE app.branches ENABLE ROW LEVEL SECURITY");
  await admin.$executeRawUnsafe("ALTER TABLE app.branches FORCE ROW LEVEL SECURITY");
  await admin.$executeRawUnsafe("CREATE POLICY scope ON app.branches USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)");
  await admin.$executeRawUnsafe("GRANT USAGE ON SCHEMA app,axiomera_lab,textbook_v23_tx TO textbook_v23_reader");
  await admin.$executeRawUnsafe("GRANT SELECT,INSERT,UPDATE ON app.branches,axiomera_lab.branches,textbook_v23_tx.tenant_reports TO textbook_v23_reader");
  const u=new URL(dsn);u.username="textbook_v23_reader";u.password=password;runtime=new PrismaClient({datasources:{db:{url:u.toString()}}});
 },30000);
 afterAll(async()=>{
  if(runtime)await runtime.$disconnect();
  await admin.$executeRawUnsafe("DROP SCHEMA IF EXISTS app CASCADE");
  await admin.$executeRawUnsafe("DROP SCHEMA IF EXISTS axiomera_lab CASCADE");
  await admin.$executeRawUnsafe("DROP SCHEMA IF EXISTS textbook_v23_tx CASCADE");
  if(roleCreated)await admin.$executeRawUnsafe("DROP ROLE textbook_v23_reader");
  await admin.$disconnect();
 },30000);
 it("CODE-028 and CODE-036: actual forced RLS denies cross-tenant reads/writes",async()=>{
  const db=runtime!;
  expect(await scoped(db,tx=>tx.$queryRawUnsafe("SELECT * FROM tenant_reports"))).toEqual([]);
  const scopedA=await scoped(db,async tx=>{
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)",A);
    const rows=await tx.$queryRawUnsafe<{report_id:string}[]>("SELECT report_id FROM tenant_reports");
    const br=await tx.$queryRawUnsafe<{name:string}[]>("SELECT name FROM axiomera_lab.branches");
    return {rows,br};
  });
  expect(scopedA).toEqual({rows:[{report_id:"r1"}],br:[{name:"A"}]});
  await expect(scoped(db,async tx=>{
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)",A);
    await tx.$executeRawUnsafe("INSERT INTO axiomera_lab.branches VALUES($1::uuid,'bad','bad')",B);
  })).rejects.toThrow();
 });
 it("CODE-031: transaction-local tenant scope clears after commit",async()=>{
  const db=runtime!;
  const rows=await scoped(db,async tx=>{
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)",A);
    return tx.$queryRawUnsafe<{branch_id:string;name:string}[]>("SELECT branch_id,name FROM app.branches ORDER BY branch_id");
  });
  expect(rows).toEqual([{branch_id:"one",name:"A"}]);
  expect(await scoped(db,tx=>tx.$queryRawUnsafe("SELECT * FROM app.branches"))).toEqual([]);
 });
 it("CODE-032: exact outbox DDL, pending insert and state constraint",async()=>{
  await admin.$executeRawUnsafe(b["CODE-032"].sql.split(";\n")[0]);
  await admin.$executeRawUnsafe("INSERT INTO app.outbox_events VALUES($1::uuid,$2::uuid,'report.frozen','R1','{}'::jsonb,'PENDING',0,now())",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await expect(admin.$executeRawUnsafe("INSERT INTO app.outbox_events VALUES($1::uuid,$2::uuid,'report.frozen','R2','{}'::jsonb,'INVALID',0,now())",A,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).rejects.toThrow();
 });
 it("CODE-041: managed atomic dataset-state/outbox commit and rollback",async()=>{
  const parts=b["CODE-041"].sql.split(";\n");
  const result=await scoped(admin,async tx=>{
    const update=await tx.$queryRawUnsafe<{id:string;version:number}[]>(parts[1],A,"D1");
    expect(update).toEqual([{id:"D1",version:2}]);
    await tx.$executeRawUnsafe(parts[2],"event1",A,"D1",'{"status":"available"}');
    return update;
  });
  expect(result).toHaveLength(1);
  expect(await scoped(admin,tx=>tx.$queryRawUnsafe<{kind:string}[]>("SELECT kind FROM outbox_events"))).toEqual([{kind:"dataset.available.v1"}]);
 });
 it("CODE-056: idempotency log and domain outbox commit together",async()=>{
  const parts=b["CODE-056"].sql.split(";\n");
  await scoped(admin,async tx=>{
    await tx.$executeRawUnsafe(parts[1],A,"K1","digest");
    await tx.$executeRawUnsafe(parts[2],A,"K1","digest","event-1","{}");
  });
  expect(await scoped(admin,tx=>tx.$queryRawUnsafe<{kind:string}[]>("SELECT kind FROM domain_outbox"))).toEqual([{kind:"source-revisions-committed"}]);
  await expect(scoped(admin,async tx=>{
    await tx.$executeRawUnsafe(parts[1],A,"K1","other");
    await tx.$executeRawUnsafe(parts[2],A,"K1","other","event-2","{}");
  })).rejects.toThrow();
  expect(await scoped(admin,tx=>tx.$queryRawUnsafe<{event_id:string}[]>("SELECT event_id FROM domain_outbox"))).toEqual([{event_id:"event-1"}]);
 });
 it("CODE-060: fenced lease update returns generation exactly once",async()=>{
  const sql=b["CODE-060"].sql.replace(":worker","$1").replace(":tenant","$2").replace(":job","$3");
  const first=await scoped(admin,tx=>tx.$queryRawUnsafe<{lease_generation:number;source_snapshot_id:string}[]>(sql,"worker1",A,"E1"));
  expect(first).toEqual([{lease_generation:1,source_snapshot_id:"SNAP1"}]);
  const reapply=await scoped(admin,tx=>tx.$queryRawUnsafe(sql,"worker2",A,"E1"));
  expect(reapply).toEqual([]);
 });
 it("CODE-025: two serializable readers cannot safely deactivate last two approvers",async()=>{
  let arrived=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve});
  const txOne=admin.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await tx.$queryRawUnsafe("SELECT set_config('search_path','textbook_v23_tx,public',true)");
    const r=await tx.$queryRawUnsafe<{count:bigint}[]>(b["CODE-025"].sql.split(";\n")[1],A);
    expect(Number(r[0].count)).toBe(2);
    arrived++;if(arrived===2)release();await barrier;
    await tx.$executeRawUnsafe(b["CODE-025"].sql.split(";\n")[2],A,"m1");
  });
  const txTwo=admin.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await tx.$queryRawUnsafe("SELECT set_config('search_path','textbook_v23_tx,public',true)");
    const r=await tx.$queryRawUnsafe<{count:bigint}[]>(b["CODE-025"].sql.split(";\n")[1],A);
    expect(Number(r[0].count)).toBe(2);
    arrived++;if(arrived===2)release();await barrier;
    await tx.$executeRawUnsafe(b["CODE-025"].sql.split(";\n")[2],A,"m2");
  });
  const settled=await Promise.allSettled([txOne,txTwo]);
  expect(settled.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect(settled.filter(x=>x.status==="rejected")).toHaveLength(1);
  const remaining=await scoped(admin,tx=>tx.$queryRawUnsafe<{count:bigint}[]>("SELECT COUNT(*) FROM on_duty_approvers WHERE on_duty"));
  expect(Number(remaining[0].count)).toBe(1);
 });
});
