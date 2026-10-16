import {createHash} from "node:crypto";
import {Prisma,PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,expect,it} from "vitest";

// Hash-locked, verbatim source blocks from the V22 authoritative manuscript.
// Input placeholder conversion is logged as an adapter, NEVER a manuscript rewrite.
const blocks={
 "CODE-004":{sha:"4e5a1b58321c909c1260950fef405953a76ce79761ab6e68e9d129f6f27250d3",sql:`-- PEDAGOGICAL ADAPTATION; timestamps supplied through approved bound params.
WITH totals AS (
 SELECT b.id, b.name, b.region,
        SUM(p.revenue) AS actual,
        SUM(p.revenue_target) AS target
 FROM branches b JOIN daily_performance p ON p.branch_id=b.id
 WHERE p.date >= :from AND p.date < :to_exclusive
 GROUP BY b.id,b.name,b.region
), achieved AS (
 SELECT *, actual / NULLIF(target,0) AS ratio FROM totals
)
SELECT name, region, ROUND((100*ratio)::numeric,2) AS achievement_pct,
       DENSE_RANK() OVER (
         PARTITION BY region ORDER BY ratio DESC NULLS LAST
       ) AS regional_rank
FROM achieved
ORDER BY region,regional_rank,name;`},
 "CODE-006":{sha:"c5c7ccf5263b7c6d6a52e92347703c9c3335d58c1a3b9b3d00954d5615666c7b",sql:`-- PROPOSED: PostgreSQL TIMESTAMPTZ canonical event-time table.
CREATE TABLE demo_event_time (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  source_id text NOT NULL UNIQUE
);
CREATE INDEX demo_event_time_occurred_at_idx ON demo_event_time (occurred_at);
-- Parameters are instants calculated from a named business timezone.
SELECT COUNT(*) FROM demo_event_time
WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz;`},
 "CODE-007":{sha:"f8812f0f44f3b21d1c77240a5c13835d398e48e941fa589c22e028c44bb1eb99",sql:`-- PROPOSED tenant-scoped request-idempotency table; not present in Branch360.
CREATE TABLE request_idempotency (
  tenant_id uuid NOT NULL,
  endpoint_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 char(64) NOT NULL,
  response_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, endpoint_key, idempotency_key)
);
-- A second request with the same key and DIFFERENT request hash is a conflict,
-- not a silent replay and not a new write.`},
 "CODE-008":{sha:"f378028c2cfb8594dc33b249cb5a097c0a5ff22d67e0fbf1d95f3ceb46c4a0d9",sql:`-- PROPOSED performance lab, execute ONLY on a disposable PostgreSQL database.
EXPLAIN (ANALYZE, BUFFERS)
SELECT branch_id, COUNT(*)
FROM operations_tickets
WHERE created_at >= TIMESTAMP '2026-09-01 00:00:00'
  AND created_at < TIMESTAMP '2026-10-01 00:00:00'
GROUP BY branch_id;

-- On larger synthetic workloads, compare after creating an appropriate
-- index. Record both plans and the hardware, PostgreSQL version, and row count.
CREATE INDEX demo_operations_tickets_created_at_branch_id
ON operations_tickets (created_at, branch_id);`},
 "CODE-020":{sha:"9d6edb0dbd24f014bcf635315a709d4a411099144d3e1134467793e61b584138",sql:`-- PROPOSED: historical snapshot model; not a current Branch360 table.
SELECT b.branch_id, r.release_id, r.released_at
FROM branches AS b
LEFT JOIN LATERAL (
    SELECT release_id, released_at
    FROM report_releases AS r
    WHERE r.tenant_id = b.tenant_id
      AND r.branch_id = b.branch_id
      AND r.status = 'RELEASED'
    ORDER BY r.released_at DESC, r.release_id DESC
    LIMIT 1
) AS r ON true
WHERE b.tenant_id = $1;
-- Candidate supporting index:
-- (tenant_id, branch_id, released_at DESC, release_id DESC)`},
 "CODE-021":{sha:"6755990ec335f6758dff681a7eda0cb60fa7d5c7fb24ff3b050b7644c4c5a33d",sql:`-- PROPOSED educational hierarchy; PostgreSQL supports arrays in path tracking.
WITH RECURSIVE descendants(node_id, parent_id, depth, path) AS (
    SELECT node_id, parent_id, 0, ARRAY[node_id]
    FROM org_nodes
    WHERE tenant_id = $1 AND node_id = $2
  UNION ALL
    SELECT child.node_id, child.parent_id, d.depth + 1,
           d.path || child.node_id
    FROM org_nodes AS child
    JOIN descendants AS d ON child.parent_id = d.node_id
    WHERE child.tenant_id = $1
      AND d.depth < 20
      AND NOT child.node_id = ANY(d.path)
)
SELECT node_id, parent_id, depth FROM descendants;`},
 "CODE-043":{sha:"40494c61ce13a0ba6a7b9c7875ee283cfcf2ce9305ad67051ea60799b1f6e057",sql:`WITH completed AS (
  SELECT branch_id, case_class,
         EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0 AS hours
  FROM operations_tickets
  WHERE resolved_at IS NOT NULL
    AND resolved_at >= created_at
), by_class AS (
  SELECT branch_id, case_class, COUNT(*) AS cases, AVG(hours) AS mean_hours
  FROM completed GROUP BY branch_id, case_class
)
SELECT branch_id,
       SUM(cases * mean_hours) / NULLIF(SUM(cases), 0) AS case_weighted_mean
FROM by_class GROUP BY branch_id;`},
 "CODE-045":{sha:"1dd8a9a5693ca68da29eed66df81a6abd488d9c98c90736274bc5d4790d98e8b",sql:`-- Educational expand step only; not safe to run blindly in production.
ALTER TABLE daily_performance
    ADD COLUMN revenue_exact NUMERIC(20,4),
    ADD COLUMN currency_code CHAR(3);

-- Backfill through an approved source-of-truth mapping, not this cast alone.
SELECT COUNT(*) AS unbackfilled
FROM daily_performance
WHERE revenue_exact IS NULL OR currency_code IS NULL;`}
} as const;
const dsn=process.env.DATABASE_URL||"";
let active=false;
try{const u=new URL(dsn);active=process.env.CI==="true"&&["localhost","127.0.0.1"].includes(u.hostname)&&u.port==="5432"&&u.pathname==="/branch360";}catch{}
const db=new PrismaClient(),A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
async function scoped<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>){
 return db.$transaction(async tx=>{await tx.$queryRawUnsafe("SELECT set_config('search_path','textbook_v23_ci,public',true)");return fn(tx);});
}
describe.runIf(active)("verbatim manuscript PostgreSQL blocks: scope, time, indexes, recursive and numeric examples",()=>{
 beforeAll(async()=>{
  for(const [id,v] of Object.entries(blocks))expect(createHash("sha256").update(v.sql).digest("hex"),id+" source drift").toBe(v.sha);
  await db.$executeRawUnsafe("CREATE SCHEMA textbook_v23_ci");
  await scoped(async tx=>{
    await tx.$executeRawUnsafe("CREATE TABLE branches(id int PRIMARY KEY,branch_id int,tenant_id text,name text,region text)");
    await tx.$executeRawUnsafe("CREATE TABLE daily_performance(branch_id int,date timestamp,revenue numeric,revenue_target numeric)");
    await tx.$executeRawUnsafe("CREATE TABLE operations_tickets(branch_id int,created_at timestamp,resolved_at timestamp,case_class text)");
    await tx.$executeRawUnsafe("CREATE TABLE report_releases(tenant_id text,branch_id int,release_id int,released_at timestamp,status text)");
    await tx.$executeRawUnsafe("CREATE TABLE org_nodes(tenant_id text,node_id text,parent_id text)");
    await tx.$executeRawUnsafe("INSERT INTO branches VALUES (1,1,$1,'Alpha','N'),(2,2,$1,'Beta','N'),(3,3,$2,'Other','S')",A,B);
    await tx.$executeRawUnsafe("INSERT INTO daily_performance VALUES (1,'2026-10-01',100,200),(1,'2026-10-02',150,200),(2,'2026-10-01',90,100),(3,'2026-10-01',900,100)");
    await tx.$executeRawUnsafe("INSERT INTO operations_tickets VALUES (1,'2026-09-10','2026-09-10 03:00:00','A'),(1,'2026-09-11','2026-09-11 05:00:00','A'),(2,'2026-09-10','2026-09-10 02:00:00','B')");
    await tx.$executeRawUnsafe("INSERT INTO report_releases VALUES ($1,1,1,'2026-10-01','RELEASED'),($1,1,2,'2026-10-03','RELEASED'),($1,2,3,'2026-10-01','DRAFT'),($2,1,4,'2026-10-04','RELEASED')",A,B);
    await tx.$executeRawUnsafe("INSERT INTO org_nodes VALUES ($1,'root',NULL),($1,'child','root'),($1,'grandchild','child'),($2,'foreign','root')",A,B);
  });
 },30000);
 afterAll(async()=>{await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS textbook_v23_ci CASCADE");await db.$disconnect();},30000);
 it("CODE-004: region-scoped DENSE_RANK and financial denominator",async()=>{
  // Only named placeholders are adapted to typed driver binds. Original block is hash-checked.
  const sql=blocks["CODE-004"].sql.replace(":from","$1::timestamp").replace(":to_exclusive","$2::timestamp");
  const r=await scoped(tx=>tx.$queryRawUnsafe<{name:string;achievement_pct:Prisma.Decimal;regional_rank:bigint}[]>(sql,"2026-10-01","2026-11-01"));
  expect(r.map(x=>[x.name,String(x.achievement_pct),Number(x.regional_rank)])).toEqual([["Beta","90",1],["Alpha","62.5",2],["Other","900",1]]);
 });
 it("CODE-006: timestamp-with-timezone DDL, index and half-open UTC count",async()=>{
  const s=blocks["CODE-006"].sql.split(";");
  await scoped(async tx=>{await tx.$executeRawUnsafe(s[0]);await tx.$executeRawUnsafe(s[1]);});
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO demo_event_time(occurred_at,source_id) VALUES ('2026-10-01T00:00:00Z','first'),('2026-10-02T00:00:00Z','second')"));
  const rows=await scoped(tx=>tx.$queryRawUnsafe<{count:bigint}[]>(s[2],"2026-10-01T00:00:00Z","2026-10-02T00:00:00Z"));
  expect(Number(rows[0].count)).toBe(1);
 });
 it("CODE-007: exact DDL enforces tenant-and-endpoint idempotency uniqueness",async()=>{
  await scoped(tx=>tx.$executeRawUnsafe(blocks["CODE-007"].sql.slice(blocks["CODE-007"].sql.indexOf("CREATE TABLE"),blocks["CODE-007"].sql.indexOf(");")+2)));
  const exists=await scoped(tx=>tx.$queryRawUnsafe<{present:string|null}[]>("SELECT to_regclass('textbook_v23_ci.request_idempotency')::text AS present"));
  expect(exists[0].present).toContain("request_idempotency");
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO textbook_v23_ci.request_idempotency(tenant_id,endpoint_key,idempotency_key,request_sha256) VALUES ($1::uuid,'upload','key','a')",A));
  await expect(scoped(tx=>tx.$executeRawUnsafe("INSERT INTO textbook_v23_ci.request_idempotency(tenant_id,endpoint_key,idempotency_key,request_sha256) VALUES ($1::uuid,'upload','key','b')",A))).rejects.toThrow();
  await scoped(tx=>tx.$executeRawUnsafe("INSERT INTO textbook_v23_ci.request_idempotency(tenant_id,endpoint_key,idempotency_key,request_sha256) VALUES ($1::uuid,'upload','key','a')",B));
 });
 it("CODE-008: exact EXPLAIN ANALYZE BUFFERS and btree index creation",async()=>{
  const [plan,index]=blocks["CODE-008"].sql.split(";\n");
  expect((await scoped(tx=>tx.$queryRawUnsafe<{ "QUERY PLAN":string }[]>(plan))).length).toBeGreaterThan(0);
  await scoped(tx=>tx.$executeRawUnsafe(index));
  const rows=await scoped(tx=>tx.$queryRawUnsafe<{indexname:string}[]>("SELECT indexname FROM pg_indexes WHERE schemaname='textbook_v23_ci' AND indexname='demo_operations_tickets_created_at_branch_id'"));
  expect(rows).toHaveLength(1);
 });
 it("CODE-020: LATERAL finds most recent released report per tenant/branch",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<{branch_id:number;release_id:number|null}[]>(blocks["CODE-020"].sql,A));
  expect(rows.map(x=>[x.branch_id,x.release_id])).toEqual([[1,2],[2,null]]);
 });
 it("CODE-021: recursive hierarchy reaches children without foreign-tenant nodes",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<{node_id:string;depth:number}[]>(blocks["CODE-021"].sql,A,"root"));
  expect(rows.map(x=>[x.node_id,x.depth])).toEqual([["root",0],["child",1],["grandchild",2]]);
 });
 it("CODE-043: correct weighted mean of per-case duration in hours",async()=>{
  const rows=await scoped(tx=>tx.$queryRawUnsafe<{branch_id:number;case_weighted_mean:Prisma.Decimal}[]>(blocks["CODE-043"].sql));
  expect(rows.map(x=>[x.branch_id,Number(x.case_weighted_mean)])).toEqual([[1,4],[2,2]]);
 });
 it("CODE-045: schema expansion without pretending backfill succeeded",async()=>{
  const [ddl,select]=blocks["CODE-045"].sql.split(";\n");
  await scoped(tx=>tx.$executeRawUnsafe(ddl));
  const out=await scoped(tx=>tx.$queryRawUnsafe<{unbackfilled:bigint}[]>(select));
  expect(Number(out[0].unbackfilled)).toBe(4);
 });
});
