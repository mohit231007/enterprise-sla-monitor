import { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

// Only runs on the repository's ephemeral GitHub Actions PostgreSQL 16 service.
// DO NOT point CI at production; safeguard intentionally includes database name.
let enabled = false;
try {
  const u = new URL(process.env.DATABASE_URL || "");
  enabled = process.env.CI === "true" && ["localhost", "127.0.0.1"].includes(u.hostname)
    && u.port === "5432" && u.pathname === "/branch360";
} catch {}
const prisma=new PrismaClient();
const schema="axiomera_contract_ci";
describe.runIf(enabled)("Axiomera finance and temporal SQL contract proof",()=>{
  beforeAll(async()=>{
    await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await prisma.$executeRawUnsafe("CREATE SCHEMA "+schema);
    await prisma.$executeRawUnsafe("CREATE TABLE "+schema+".branches (tenant_id uuid NOT NULL, branch_id uuid NOT NULL, code text NOT NULL, PRIMARY KEY(tenant_id,branch_id), UNIQUE(tenant_id,code))");
    await prisma.$executeRawUnsafe("CREATE TABLE "+schema+".performance (tenant_id uuid NOT NULL, branch_id uuid NOT NULL, business_date date NOT NULL, amount numeric(20,4) NOT NULL, currency char(3) NOT NULL, FOREIGN KEY(tenant_id,branch_id) REFERENCES "+schema+".branches(tenant_id,branch_id))");
    await prisma.$executeRawUnsafe("CREATE TABLE "+schema+".assignment (tenant_id uuid NOT NULL, branch_id uuid NOT NULL, region text NOT NULL, valid_from date NOT NULL, valid_to date, CHECK (valid_to IS NULL OR valid_to > valid_from), FOREIGN KEY(tenant_id,branch_id) REFERENCES "+schema+".branches(tenant_id,branch_id), EXCLUDE USING gist (tenant_id WITH =, branch_id WITH =, daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[)') WITH &&))");
    await prisma.$executeRawUnsafe("CREATE TABLE "+schema+".idempotency (tenant_id uuid NOT NULL, op text NOT NULL, key text NOT NULL, request_hash text NOT NULL, PRIMARY KEY (tenant_id,op,key))");
    await prisma.$executeRawUnsafe("INSERT INTO "+schema+".branches VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','SAME'),('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','SAME')");
  });
  afterAll(async()=>{
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
    await prisma.$disconnect();
  });

  it("keeps exact NUMERIC(20,4) money values across repeated fractional addition",async()=>{
    const rows=await prisma.$queryRawUnsafe<{total:unknown}[]>("SELECT (0.10::numeric(20,4)+0.20::numeric(20,4)) AS total");
    expect(new Prisma.Decimal(String(rows[0].total)).eq(new Prisma.Decimal("0.30"))).toBe(true);
  });

  it("rejects mismatched tenant and branch composite foreign keys",async()=>{
    await expect(prisma.$executeRawUnsafe("INSERT INTO "+schema+".performance VALUES ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-07-01',10,'INR')")).rejects.toThrow();
  });

  it("allows valid adjacent organization periods and disallows overlapping periods",async()=>{
    const base="INSERT INTO "+schema+".assignment VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'";
    await prisma.$executeRawUnsafe(base+",'North','2026-01-01','2026-07-01')");
    await prisma.$executeRawUnsafe(base+",'West','2026-07-01',NULL)");
    await expect(prisma.$executeRawUnsafe(base+",'Overlapping','2026-06-30','2026-07-02')")).rejects.toThrow();
    const a=await prisma.$queryRawUnsafe<{region:string}[]>("SELECT region FROM "+schema+".assignment WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND '2026-06-30'::date >= valid_from AND (valid_to IS NULL OR '2026-06-30'::date < valid_to)");
    const b=await prisma.$queryRawUnsafe<{region:string}[]>("SELECT region FROM "+schema+".assignment WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND '2026-07-01'::date >= valid_from AND (valid_to IS NULL OR '2026-07-01'::date < valid_to)");
    expect(a).toEqual([{region:"North"}]);
    expect(b).toEqual([{region:"West"}]);
  });

  it("enforces tenant-scoped idempotency key uniqueness without cross-tenant collision",async()=>{
    const insert="INSERT INTO "+schema+".idempotency VALUES ";
    await prisma.$executeRawUnsafe(insert+"('11111111-1111-4111-8111-111111111111','upload','k','same')");
    await prisma.$executeRawUnsafe(insert+"('22222222-2222-4222-8222-222222222222','upload','k','other')");
    await expect(prisma.$executeRawUnsafe(insert+"('11111111-1111-4111-8111-111111111111','upload','k','change')")).rejects.toThrow();
    const rows=await prisma.$queryRawUnsafe<{n:bigint}[]>("SELECT COUNT(*) AS n FROM "+schema+".idempotency");
    expect(rows[0].n).toBe(2n);
  });
});
