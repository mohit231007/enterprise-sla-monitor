import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

// Deliberately refuse non-CI, non-localhost, and non-disposable database targets.
const dsn = process.env.DATABASE_URL ?? "";
let enabled = false;
try {
  const url = new URL(dsn);
  enabled = process.env.CI === "true"
    && ["localhost", "127.0.0.1"].includes(url.hostname)
    && url.port === "5432" && url.pathname === "/branch360";
} catch {}
const RED = "11111111-1111-4111-8111-111111111111";
const BLUE = "22222222-2222-4222-8222-222222222222";
const admin = new PrismaClient();
let runtime: PrismaClient;
let madeRole = false;
let madeSchema = false;

describe.runIf(enabled)("Axiomera PostgreSQL 16 RLS negative tests (disposable CI database only)", () => {
  beforeAll(async () => {
    const pw = randomBytes(24).toString("hex");
    await admin.$executeRawUnsafe("CREATE ROLE axiomera_ci_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '" + pw + "'");
    madeRole = true;
    await admin.$executeRawUnsafe("CREATE SCHEMA axiomera_ci");
    madeSchema = true;
    await admin.$executeRawUnsafe("CREATE TABLE axiomera_ci.branches (tenant_id uuid NOT NULL, branch_id uuid NOT NULL, external_code text NOT NULL, name text NOT NULL, PRIMARY KEY(tenant_id, branch_id), UNIQUE(tenant_id,external_code))");
    await admin.$executeRawUnsafe("ALTER TABLE axiomera_ci.branches ENABLE ROW LEVEL SECURITY");
    await admin.$executeRawUnsafe("ALTER TABLE axiomera_ci.branches FORCE ROW LEVEL SECURITY");
    await admin.$executeRawUnsafe("CREATE POLICY tenant_isolation ON axiomera_ci.branches USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)");
    await admin.$executeRawUnsafe("GRANT USAGE ON SCHEMA axiomera_ci TO axiomera_ci_runtime");
    await admin.$executeRawUnsafe("GRANT SELECT,INSERT,UPDATE,DELETE ON axiomera_ci.branches TO axiomera_ci_runtime");
    await admin.$executeRawUnsafe("INSERT INTO axiomera_ci.branches VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','CENTRAL','Red tenant central'),('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','CENTRAL','Blue tenant central')");
    const url = new URL(dsn);
    url.username = "axiomera_ci_runtime";
    url.password = pw;
    runtime = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await runtime.$queryRawUnsafe("SELECT current_user AS who, rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user");
    expect(identity).toEqual([{ who: "axiomera_ci_runtime", super: false, bypass: false }]);
  },30000);

  afterAll(async () => {
    if (runtime) await runtime.$disconnect();
    if (madeSchema) await admin.$executeRawUnsafe("DROP SCHEMA axiomera_ci CASCADE");
    if (madeRole) await admin.$executeRawUnsafe("DROP ROLE axiomera_ci_runtime");
    await admin.$disconnect();
  });

  async function scoped(tenant: string, query: (tx: PrismaClient) => Promise<unknown>) {
    return runtime.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)",tenant);
      return query(tx as unknown as PrismaClient);
    });
  }

  it.each([[RED,"Red tenant central"],[BLUE,"Blue tenant central"]])("reads only the current tenant %s",async (tenant,expected) => {
    const rows = await scoped(tenant,tx=>tx.$queryRawUnsafe("SELECT name FROM axiomera_ci.branches ORDER BY name"));
    expect(rows).toEqual([{name:expected}]);
  });

  it("does not leak scope across transactions",async () => {
    await scoped(RED,tx=>tx.$queryRawUnsafe("SELECT name FROM axiomera_ci.branches"));
    const rows = await runtime.$transaction(tx=>tx.$queryRawUnsafe("SELECT name FROM axiomera_ci.branches"));
    expect(rows).toEqual([]);
  });

  it("blocks cross-tenant UPDATE",async () => {
    expect(await scoped(RED,tx=>tx.$executeRawUnsafe("UPDATE axiomera_ci.branches SET name='corrupt' WHERE tenant_id='22222222-2222-4222-8222-222222222222'"))).toBe(0);
  });

  it("blocks cross-tenant DELETE",async () => {
    expect(await scoped(BLUE,tx=>tx.$executeRawUnsafe("DELETE FROM axiomera_ci.branches WHERE tenant_id='11111111-1111-4111-8111-111111111111'"))).toBe(0);
  });

  it("blocks cross-tenant INSERT",async () => {
    await expect(scoped(RED,tx=>tx.$executeRawUnsafe("INSERT INTO axiomera_ci.branches VALUES ('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','FAKE','forbidden')"))).rejects.toThrow();
    expect(await scoped(BLUE,tx=>tx.$queryRawUnsafe("SELECT name FROM axiomera_ci.branches")))
      .toEqual([{name:"Blue tenant central"}]);
  });
});
