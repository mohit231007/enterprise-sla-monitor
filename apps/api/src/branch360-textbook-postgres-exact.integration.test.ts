import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

// Each SQL string is copied from one fenced block in the current Branch360
// manuscript. The SHA-256 must match the manuscript inventory before execution.
const snippets = {
 "CODE-012": {
 sha: "772fd0091cbe2c133e162fb628ae7790ac4fe1f583462755e9fa5d267020d043",
 sql: "-- PEDAGOGICAL VERSION: UTC-convention dates matching the synthetic demo.\nSELECT branch_id, date, revenue, revenue_target\nFROM daily_performance\nWHERE date >= TIMESTAMP '2026-10-01 00:00:00'\n  AND date <  TIMESTAMP '2026-11-01 00:00:00'\nORDER BY branch_id, date;"
 },
 "CODE-015": {
 sha: "38c8b21d03cb85eb9848dbf05804f0ac8ac2dc8d850c057839be0b505596c979",
 sql: "SELECT branch_id,\n       COUNT(*) AS tickets_created_in_period,\n       COUNT(*) FILTER (WHERE status='Open') AS open_in_cohort,\n       COUNT(*) FILTER (WHERE sla_breached) AS ever_breached_in_cohort,\n       COUNT(*) FILTER (WHERE status='Open' AND sla_breached) AS active_breached_in_cohort\nFROM operations_tickets\nWHERE created_at >= TIMESTAMP '2026-10-01 00:00:00'\n  AND created_at < TIMESTAMP '2026-11-01 00:00:00'\nGROUP BY branch_id;"
 },
 "CODE-023": {
 sha: "aea5d0a2018852db17da2f98ef2b62bf057110444b31260555d4f145757cb6ba",
 sql: "SELECT region, branch_id,\n       SUM(revenue) AS revenue,\n       GROUPING(region,branch_id) AS group_mask\nFROM branch_revenue_fact\nWHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3\nGROUP BY GROUPING SETS ((region,branch_id),(region),());"
 },
 "CODE-026": {
 sha: "11688964520196c1ca7f2d229007b8fc67996b992aa499bc9674a3829292b306",
 sql: "-- PROPOSED synthetic ledger-style source fact; not in current Branch360.\nCREATE TABLE monetary_facts (\n tenant_id uuid NOT NULL,\n fact_id uuid NOT NULL,\n source_system text NOT NULL,\n external_event_id text NOT NULL,\n currency char(3) NOT NULL,\n amount numeric(20,4) NOT NULL,\n business_date date NOT NULL,\n source_version integer NOT NULL CHECK(source_version > 0),\n recorded_at timestamptz NOT NULL DEFAULT now(),\n PRIMARY KEY(tenant_id,fact_id),\n UNIQUE(tenant_id,source_system,external_event_id,source_version)\n);"
 },
 "CODE-044": {
 sha: "8ea3984080c5781424fc937806db6dec31d7b3e8b3441477388e41aa4021fcfe",
 sql: "CREATE TABLE branch_region_history (\n  tenant_id uuid NOT NULL,\n  branch_id uuid NOT NULL,\n  region_code text NOT NULL,\n  valid_from date NOT NULL,\n  valid_to date,\n  PRIMARY KEY (tenant_id, branch_id, valid_from),\n  CHECK (valid_to IS NULL OR valid_to > valid_from)\n);"
 },
 "CODE-055": {
 sha: "35dbf0efe9268f45fb2064e3fd74d3e2aa154c520512c9d9dced1d097b02c35d",
 sql: "CREATE EXTENSION IF NOT EXISTS btree_gist;\nCREATE TABLE branch_region_assignment (\n    tenant_id uuid NOT NULL,\n    branch_id uuid NOT NULL,\n    region_code text NOT NULL,\n    valid_from date NOT NULL,\n    valid_to date,\n    CHECK (valid_to IS NULL OR valid_to > valid_from),\n    EXCLUDE USING gist (\n      tenant_id WITH =,\n      branch_id WITH =,\n      daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[)') WITH &&\n    )\n);"
 }
} as const;
const dsn=process.env.DATABASE_URL||"";
let enabled=false;
try {const u=new URL(dsn); enabled=process.env.CI==="true"&&["localhost","127.0.0.1"].includes(u.hostname)&&u.port==="5432"&&u.pathname==="/branch360";}catch{}
const db=new PrismaClient();
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
async function scoped<T>(fn:(tx:any)=>Promise<T>):Promise<T>{
 return db.$transaction(async tx=>{
  await tx.$queryRawUnsafe("SELECT set_config('search_path','textbook_pg_ci,public',true)");
  return fn(tx);
 });
}
describe.runIf(enabled)("verbatim Branch360 PostgreSQL16 manuscript blocks, disposable CI only",()=>{
 beforeAll(async()=>{
  for(const [id,item] of Object.entries(snippets)){
   expect(createHash("sha256").update(item.sql,"utf8").digest("hex"),id+" manuscript hash").toBe(item.sha);
  }
  await db.$executeRawUnsafe("CREATE SCHEMA textbook_pg_ci");
  await scoped(async tx=>{
   await tx.$executeRawUnsafe("CREATE TABLE daily_performance(branch_id int,date timestamp,revenue numeric(20,4),revenue_target numeric(20,4))");
   await tx.$executeRawUnsafe("CREATE TABLE operations_tickets(branch_id int,created_at timestamp,status text,sla_breached boolean)");
   await tx.$executeRawUnsafe("CREATE TABLE branch_revenue_fact(tenant_id text,region text,branch_id int,revenue numeric(20,4),business_date date)");
   await tx.$executeRawUnsafe("INSERT INTO daily_performance VALUES (1,'2026-10-01',100,120),(1,'2026-10-02',150,160),(2,'2026-11-01',80,100)");
   await tx.$executeRawUnsafe("INSERT INTO operations_tickets VALUES (1,'2026-10-01','Open',true),(1,'2026-10-02','Closed',true),(2,'2026-10-01','Open',false),(2,'2026-09-10','Open',false)");
   await tx.$executeRawUnsafe("INSERT INTO branch_revenue_fact VALUES ($1::text,'N',1,100,'2026-10-01'),($1::text,'N',2,150,'2026-10-02'),($2::text,'S',1,9000,'2026-10-01')",A,B);
  });
 },30000);
 afterAll(async()=>{
  await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS textbook_pg_ci CASCADE");
  await db.$disconnect();
 },30000);
 it("CODE-012: half-open business month boundaries",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<any[]>(snippets["CODE-012"].sql));
  expect(rows.map(r=>r.branch_id)).toEqual([1,1]);
  expect(rows.map(r=>String(r.revenue))).toEqual(["100","150"]);
 });
 it("CODE-015: FILTER ticket lifecycle and breaches",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<any[]>(snippets["CODE-015"].sql));
  const m=new Map(rows.map(r=>[r.branch_id,r]));
  expect(Number(m.get(1).tickets_created_in_period)).toBe(2);
  expect(Number(m.get(1).active_breached_in_cohort)).toBe(1);
  expect(Number(m.get(1).ever_breached_in_cohort)).toBe(2);
  expect(Number(m.get(2).open_in_cohort)).toBe(1);
 });
 it("CODE-023: grouping sets preserves tenant and returns grand total",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<any[]>(snippets["CODE-023"].sql,A,"2026-10-01","2026-11-01"));
  expect(rows).toHaveLength(4);
  expect(rows.filter(r=>Number(r.group_mask)===0)).toHaveLength(2);
  expect(rows.find(r=>Number(r.group_mask)===3).revenue.toString()).toBe("250");
 });
 it("CODE-026: exact NUMERIC and source version uniqueness",async()=>{
  await scoped(tx=>tx.$executeRawUnsafe(snippets["CODE-026"].sql));
  await scoped(async tx=>{
   await tx.$executeRawUnsafe("INSERT INTO monetary_facts VALUES($1::uuid,$2::uuid,'core','E1','INR','0.1000','2026-10-01',1,now())",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
   await tx.$executeRawUnsafe("INSERT INTO monetary_facts VALUES($1::uuid,$2::uuid,'core','E2','INR','0.2000','2026-10-01',1,now())",A,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
   expect(await tx.$queryRawUnsafe<any[]>("SELECT sum(amount)::text total FROM monetary_facts")).toEqual([{total:"0.3000"}]);
  });
  await expect(scoped(tx=>tx.$executeRawUnsafe("INSERT INTO monetary_facts VALUES($1::uuid,$2::uuid,'core','E1','INR',1,'2026-10-01',1,now())",A,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"))).rejects.toThrow();
 });
 it("CODE-044: impossible reversed region validity is rejected",async()=>{
  await scoped(tx=>tx.$executeRawUnsafe(snippets["CODE-044"].sql));
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO branch_region_history VALUES($1::uuid,$2::uuid,'North','2026-01-01','2026-06-01')",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await expect(scoped(tx=>tx.$executeRawUnsafe("INSERT INTO branch_region_history VALUES($1::uuid,$2::uuid,'Bad','2026-12-01','2026-06-01')",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).rejects.toThrow();
 });
 it("CODE-055: GiST exclusion prevents overlapping assignments",async()=>{
  const [extension,table]=snippets["CODE-055"].sql.split(";\n");
  await scoped(async tx=>{await tx.$executeRawUnsafe(extension);await tx.$executeRawUnsafe(table);});
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO branch_region_assignment VALUES($1::uuid,$2::uuid,'N','2026-01-01','2026-07-01')",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO branch_region_assignment VALUES($1::uuid,$2::uuid,'W','2026-07-01',NULL)",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await expect(scoped(tx=>tx.$executeRawUnsafe("INSERT INTO branch_region_assignment VALUES($1::uuid,$2::uuid,'Invalid','2026-06-01','2026-08-01')",A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).rejects.toThrow();
 });
});