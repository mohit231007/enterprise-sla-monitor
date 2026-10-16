import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { createPgPilotHttp } from "./axiomera-pg-http.js";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant,ingest,freeze,approve,readReleased,Denied,Conflict } from "./axiomera-pg-service.js";

// Runs only against the disposable local PostgreSQL16 service in GitHub CI.
const dsn=process.env.DATABASE_URL||"";
let enabled=false;
try { const u=new URL(dsn); enabled=process.env.CI==="true" &&
  ["localhost","127.0.0.1"].includes(u.hostname)&&u.port==="5432"&&u.pathname==="/branch360"; } catch {}
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222";
const admin=new PrismaClient();
let runtime:PrismaClient|undefined,roleMade=false,schemaMade=false;
const p=(tenantId:string,subject:string)=>({tenantId,subject});
const sample={branch:"CENTRAL",date:"2026-10-15",amount:"10.2000",currency:"INR",source:"SRC:RED:001"};
describe.runIf(enabled)("Axiomera restricted-role PostgreSQL application service core",()=>{
 beforeAll(async()=>{
   const password=randomBytes(24).toString("hex");
   await admin.$executeRawUnsafe("CREATE ROLE axiomera_service_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '"+password+"'");
   roleMade=true;
   await admin.$executeRawUnsafe("CREATE SCHEMA axiomera_service_ci");
   schemaMade=true;
   const ddl=[
    "CREATE TABLE axiomera_service_ci.memberships (tenant_id uuid NOT NULL, subject text NOT NULL, role text NOT NULL, status text NOT NULL, PRIMARY KEY(tenant_id,subject))",
    "CREATE TABLE axiomera_service_ci.branches (tenant_id uuid NOT NULL, branch text NOT NULL, PRIMARY KEY(tenant_id,branch))",
    "CREATE TABLE axiomera_service_ci.runs (tenant_id uuid NOT NULL,id uuid NOT NULL,dataset text NOT NULL,idem text NOT NULL,digest char(64) NOT NULL,received int NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,dataset,idem))",
    "CREATE TABLE axiomera_service_ci.facts (tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,run_id uuid NOT NULL,dataset text NOT NULL,branch text NOT NULL,date date NOT NULL,amount numeric(20,4) NOT NULL,currency char(3) NOT NULL,source text NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,dataset,source),FOREIGN KEY(tenant_id,run_id) REFERENCES axiomera_service_ci.runs(tenant_id,id),FOREIGN KEY(tenant_id,branch) REFERENCES axiomera_service_ci.branches(tenant_id,branch))",
    "CREATE TABLE axiomera_service_ci.reports (tenant_id uuid NOT NULL,id uuid NOT NULL,maker text NOT NULL,checker text,status text NOT NULL,payload jsonb NOT NULL,digest char(64) NOT NULL,PRIMARY KEY(tenant_id,id), CHECK(checker IS NULL OR checker<>maker))",
    "CREATE TABLE axiomera_service_ci.events (tenant_id uuid NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY,actor text NOT NULL,operation text NOT NULL,subject_id text NOT NULL,PRIMARY KEY(tenant_id,id))"
   ];
   for(const stmt of ddl)await admin.$executeRawUnsafe(stmt);
   for(const table of ["memberships","branches","runs","facts","reports","events"]){
     await admin.$executeRawUnsafe("ALTER TABLE axiomera_service_ci."+table+" ENABLE ROW LEVEL SECURITY");
     await admin.$executeRawUnsafe("ALTER TABLE axiomera_service_ci."+table+" FORCE ROW LEVEL SECURITY");
     await admin.$executeRawUnsafe("CREATE POLICY scope ON axiomera_service_ci."+table+
       " USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)"+
       " WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)");
   }
   await admin.$executeRawUnsafe("GRANT USAGE ON SCHEMA axiomera_service_ci TO axiomera_service_runtime");
   await admin.$executeRawUnsafe("GRANT SELECT ON ALL TABLES IN SCHEMA axiomera_service_ci TO axiomera_service_runtime");
   for(const table of ["runs","facts","reports","events"])
     await admin.$executeRawUnsafe("GRANT INSERT ON axiomera_service_ci."+table+" TO axiomera_service_runtime");
   await admin.$executeRawUnsafe("GRANT UPDATE(status,checker) ON axiomera_service_ci.reports TO axiomera_service_runtime");
   await admin.$executeRawUnsafe("GRANT USAGE ON ALL SEQUENCES IN SCHEMA axiomera_service_ci TO axiomera_service_runtime");
   await admin.$executeRawUnsafe("INSERT INTO axiomera_service_ci.branches VALUES ('"+A+"','CENTRAL'),('"+B+"','CENTRAL')");
   await admin.$executeRawUnsafe("INSERT INTO axiomera_service_ci.memberships VALUES "+
     "('"+A+"','alice','INGESTOR','ACTIVE'),('"+A+"','bob','ANALYST','ACTIVE'),"+
     "('"+A+"','carol','REVIEWER','ACTIVE'),('"+A+"','aud','AUDITOR','ACTIVE'),"+
     "('"+A+"','revoked','ANALYST','REVOKED'),"+
     "('"+B+"','alice','INGESTOR','ACTIVE'),('"+B+"','bob','ANALYST','ACTIVE'),"+
     "('"+B+"','carol','REVIEWER','ACTIVE'),('"+B+"','aud','AUDITOR','ACTIVE')");
   const u=new URL(dsn);u.username="axiomera_service_runtime";u.password=password;
   runtime=new PrismaClient({datasources:{db:{url:u.toString()}}});
   const roles=await runtime.$queryRawUnsafe<{rolsuper:boolean;rolbypassrls:boolean}[]>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
   expect(roles).toEqual([{rolsuper:false,rolbypassrls:false}]);
 },35000);
 afterAll(async()=>{
   if(runtime)await runtime.$disconnect();
   if(schemaMade)await admin.$executeRawUnsafe("DROP SCHEMA IF EXISTS axiomera_service_ci CASCADE");
   if(roleMade)await admin.$executeRawUnsafe("DROP ROLE IF EXISTS axiomera_service_runtime");
   await admin.$disconnect();
 },35000);
 function db(){if(!runtime)throw Error("setup incomplete");return runtime;}
 it("scope is absent by default and cleared after a transaction",async()=>{
   expect(await db().$queryRawUnsafe("SELECT branch FROM axiomera_service_ci.branches")).toEqual([]);
   expect(await withTenant(db(),p(A,"alice"),tx=>tx.$queryRawUnsafe("SELECT branch FROM axiomera_service_ci.branches"))).toEqual([{branch:"CENTRAL"}]);
   expect(await db().$queryRawUnsafe("SELECT branch FROM axiomera_service_ci.branches")).toEqual([]);
 });
 it("rejects unauthorized and revoked identities",async()=>{
   await expect(freeze(db(),p(A,"revoked"),"sales")).rejects.toBeInstanceOf(Denied);
   await expect(freeze(db(),p(A,"unknown"),"sales")).rejects.toBeInstanceOf(Denied);
 });
 it("rejects malformed exact-decimal inputs",async()=>{
   await expect(ingest(db(),p(A,"alice"),"sales",[{...sample,amount:"1e12"}],"idem-test-0001")).rejects.toBeInstanceOf(Denied);
 });
 it("ingests exact money, enforces idempotency and detects key conflicts",async()=>{
   const first=await ingest(db(),p(A,"alice"),"sales",[sample],"idempotent-key-1");
   const repeat=await ingest(db(),p(A,"alice"),"sales",[sample],"idempotent-key-1");
   expect(first.replayed).toBe(false);expect(repeat.id).toBe(first.id);expect(repeat.replayed).toBe(true);
   await expect(ingest(db(),p(A,"alice"),"sales",[{...sample,amount:"99.0000"}],"idempotent-key-1")).rejects.toBeInstanceOf(Conflict);
 });
 it("same branch/key may occur under another tenant without data mixing",async()=>{
   expect((await ingest(db(),p(B,"alice"),"sales",[{...sample,amount:"20.1000",source:"SRC:BLUE:001"}],"idempotent-key-1")).replayed).toBe(false);
   const a=await withTenant(db(),p(A,"aud"),tx=>tx.$queryRawUnsafe("SELECT amount::text AS amount FROM axiomera_service_ci.facts"));
   const b=await withTenant(db(),p(B,"aud"),tx=>tx.$queryRawUnsafe("SELECT amount::text AS amount FROM axiomera_service_ci.facts"));
   expect(a).toEqual([{amount:"10.2000"}]);expect(b).toEqual([{amount:"20.1000"}]);
 });
 let reportId="";
 it("freezes tenant-specified NUMERIC totals, denies pre-approval and cross-tenant reads",async()=>{
   const a=await freeze(db(),p(A,"bob"),"sales");reportId=a.id;
   const b=await freeze(db(),p(B,"bob"),"sales");
   expect(a.payload.lines).toEqual([{branch:"CENTRAL",currency:"INR",amount:"10.2000"}]);
   expect(b.payload.lines).toEqual([{branch:"CENTRAL",currency:"INR",amount:"20.1000"}]);
   await expect(readReleased(db(),p(A,"aud"),reportId)).rejects.toBeInstanceOf(Denied);
   await expect(readReleased(db(),p(B,"aud"),reportId)).rejects.toBeInstanceOf(Denied);
 });
 it("enforces independent approval and returns immutable released payload",async()=>{
   await expect(approve(db(),p(A,"bob"),reportId)).rejects.toBeInstanceOf(Denied);
   expect((await approve(db(),p(A,"carol"),reportId)).replayed).toBe(false);
   expect((await approve(db(),p(A,"carol"),reportId)).replayed).toBe(true);
   expect((await readReleased(db(),p(A,"aud"),reportId)).payload).toMatchObject({lines:[{branch:"CENTRAL",currency:"INR",amount:"10.2000"}]});
 });
 it("database prevents direct unauthorized fact updates, cross-tenant inserts and deletes",async()=>{
   await expect(withTenant(db(),p(A,"alice"),tx=>tx.$executeRawUnsafe("UPDATE axiomera_service_ci.facts SET amount=2"))).rejects.toThrow();
   await expect(withTenant(db(),p(A,"alice"),tx=>tx.$executeRawUnsafe("DELETE FROM axiomera_service_ci.reports"))).rejects.toThrow();
   await expect(withTenant(db(),p(A,"alice"),tx=>tx.$executeRawUnsafe(
     "INSERT INTO axiomera_service_ci.events(tenant_id,actor,operation,subject_id) VALUES($1::uuid,'alice','bad','bad')",B))).rejects.toThrow();
 });
 it("concurrent scoped transactions do not leak another tenant's rows",async()=>{
   const ids=[A,B,A,B,A,B];
   const rows=await Promise.all(ids.map(id=>withTenant(db(),p(id,"aud"),tx=>tx.$queryRawUnsafe<{tenant_id:string}[]>(
     "SELECT DISTINCT tenant_id::text AS tenant_id FROM axiomera_service_ci.facts"))));
   rows.forEach((value,i)=>expect(value).toEqual([{tenant_id:ids[i]}]));
   expect(await db().$queryRawUnsafe("SELECT * FROM axiomera_service_ci.reports")).toEqual([]);
 });

 it("serves an actual signed-JWT HTTP-to-Postgres ingest, review and report journey",async()=>{
   const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
   const trust={issuer:"https://synthetic-idp.invalid/",audience:"axiomera-ci",
     jwks:{keys:[{...publicKey.export({format:"jwk"}),kid:"ci-key",alg:"RS256",use:"sig"}]}};
   const makeJwt=(tenant:string,subject:string,adjust?:{exp?:number;nbf?:number;kid?:string;alg?:string})=>{
     const now=Math.floor(Date.now()/1000);
     const header={alg:adjust?.alg??"RS256",typ:"JWT",kid:adjust?.kid??"ci-key"};
     const payload={iss:trust.issuer,aud:trust.audience,sub:subject,tenant_id:tenant,
       iat:now-1,nbf:adjust?.nbf??now-1,exp:adjust?.exp??now+300};
     const head=Buffer.from(JSON.stringify(header)).toString("base64url");
     const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
     const signature=sign("RSA-SHA256",Buffer.from(head+"."+body),privateKey).toString("base64url");
     return [head,body,signature].join(".");
   };
   const app=createPgPilotHttp(db(),trust);
   const server=app.listen(0,"127.0.0.1");
   await new Promise<void>(resolve=>server.once("listening",resolve));
   const port=(server.address() as {port:number}).port;
   const base="http://127.0.0.1:"+port+"/v1/tenants/";
   const call=async (method:string,tenant:string,part:string,token?:string,data?:unknown,idem?:string)=>{
     const h:Record<string,string>={"Content-Type":"application/json"};
     if(token)h.Authorization="Bearer "+token;
     if(idem)h["Idempotency-Key"]=idem;
     const res=await fetch(base+tenant+part,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
     return {status:res.status,body:await res.json() as any};
   };
   try{
     const uploader=makeJwt(A,"alice"),analyst=makeJwt(A,"bob"),reviewer=makeJwt(A,"carol"),auditor=makeJwt(A,"aud");
     const upload=await call("POST",A,"/ingestions",uploader,{dataset:"sales",rows:[
       {branch:"CENTRAL",date:"2026-10-15",amount:"0.1000",currency:"INR",source:"SRC:RED:HTTP001"}]},"http-idem-1234");
     expect(upload.status).toBe(201);
     const draft=await call("POST",A,"/reports",analyst,{dataset:"sales"});
     expect(draft.status).toBe(201);
     expect(draft.body.payload.lines).toEqual([{branch:"CENTRAL",currency:"INR",amount:"10.3000"}]);
     expect((await call("GET",A,"/reports/"+draft.body.id,auditor)).status).toBe(404);
     expect((await call("POST",A,"/reports/"+draft.body.id+"/approve",analyst)).status).toBe(404);
     expect((await call("POST",A,"/reports/"+draft.body.id+"/approve",reviewer)).status).toBe(200);
     const released=await call("GET",A,"/reports/"+draft.body.id,auditor);
     expect(released.status).toBe(200);expect(released.body.payload.lines).toEqual(draft.body.payload.lines);
     expect((await call("GET",B,"/reports/"+draft.body.id,auditor)).status).toBe(401);
     expect((await call("GET",B,"/reports/"+draft.body.id,makeJwt(B,"aud"))).status).toBe(404);
     expect((await call("GET",A,"/reports/"+draft.body.id,makeJwt(A,"revoked"))).status).toBe(404);
     expect((await call("GET",A,"/reports/"+draft.body.id)).status).toBe(401);
     expect((await call("GET",A,"/reports/"+draft.body.id,makeJwt(A,"aud",{exp:1}))).status).toBe(401);
     expect((await call("GET",A,"/reports/"+draft.body.id,makeJwt(A,"aud",{nbf:Math.floor(Date.now()/1000)+1000}))).status).toBe(401);
     expect((await call("GET",A,"/reports/"+draft.body.id,makeJwt(A,"aud",{kid:"unknown"}))).status).toBe(401);
     const tampered=auditor.slice(0,-1)+(auditor.endsWith("A")?"B":"A");
     expect((await call("GET",A,"/reports/"+draft.body.id,tampered)).status).toBe(401);
   } finally {
     await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
   }
 });

});