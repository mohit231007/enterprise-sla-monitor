import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createReport, executeCatalogQuery, sqlCatalog } from "./reporting.js";

const db=new PrismaClient();
afterAll(async()=>{await db.$disconnect();});
describe("reporting workspace with PostgreSQL",()=>{
 it("offers exactly curated read-only queries",()=>{
  expect(sqlCatalog).toHaveLength(3);
  expect(sqlCatalog.every(q=>q.sql.trim().toUpperCase().startsWith("WITH")||q.sql.trim().toUpperCase().startsWith("SELECT"))).toBe(true);
 });
 it("runs the parameterized branch query on seeded data",async()=>{
  const rows=await executeCatalogQuery(db,"branch-performance","2026-10-01","2026-10-31");
  expect(rows).toHaveLength(5);
  expect(rows.every(r=>typeof r.name==="string")).toBe(true);
 });
 it("stores an immutable report record with retrieval hash",async()=>{
  const report=await createReport(db,"2026-10-01","2026-10-31");
  expect(report.id).toMatch(/^BR360-/);
  expect(report.contentSha256).toHaveLength(64);
  const saved=await db.reportSnapshot.findUniqueOrThrow({where:{id:report.id}});
  expect(saved.contentSha256).toBe(report.contentSha256);
  expect(saved.payload).toBeDefined();
 });
});
