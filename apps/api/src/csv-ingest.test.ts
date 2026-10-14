import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ingestCsv, uploadSchema, ValidationError } from "./csv-ingest.js";

const db = new PrismaClient();
const columns=["branch_name","date","revenue","revenue_target","accounts_opened","loans_processed"];
const data=(date:string,revenue:string)=>({dataset:"performance" as const,filename:"performance.csv",columns,
 rows:[{branch_name:"Connaught Place",date,revenue,revenue_target:"900000",accounts_opened:"35",loans_processed:"14"}]});
describe("PostgreSQL upload-to-report integration",()=>{
 it("commits a validated row and permits idempotent repeat upload",async()=>{
   const record=data("2026-10-14","950000");
   const first=await ingestCsv(db,uploadSchema.parse(record));
   const second=await ingestCsv(db,uploadSchema.parse(record));
   expect(first.accepted).toBe(1);expect(second.accepted).toBe(1);
   const branch=await db.branch.findUniqueOrThrow({where:{name:"Connaught Place"}});
   const date=new Date("2026-10-14T00:00:00Z");
   const rows=await db.dailyPerformance.findMany({where:{branchId:branch.id,date}});
   expect(rows).toHaveLength(1);
   expect(rows[0].revenue).toBe(950000);
   expect(await db.ingestionRun.count({where:{source:"CSV_UPLOAD",status:"SUCCESS",id:{in:[first.runId,second.runId]}}})).toBe(2);
 });
 it("imports all 150 performance records in one atomic batch",async()=>{
   const names=["Connaught Place","Banjara Hills","Bandra West","Salt Lake","Indiranagar"];
   const rows=names.flatMap(branch_name=>Array.from({length:30},(_,i)=>({
     branch_name,date:"2026-08-"+String(i+1).padStart(2,"0"),
     revenue:"950000",revenue_target:"900000",accounts_opened:"35",loans_processed:"14"
   })));
   const result=await ingestCsv(db,uploadSchema.parse({dataset:"performance",filename:"bulk.csv",columns,rows}));
   expect(result.accepted).toBe(150);
   expect(result.dateFrom).toBe("2026-08-01");
   expect(result.dateTo).toBe("2026-08-30");
   const stored=await db.dailyPerformance.count({where:{date:{gte:new Date("2026-08-01T00:00:00Z"),lte:new Date("2026-08-30T00:00:00Z")}}});
   expect(stored).toBe(150);
 });
 it("rejects bad numeric values, writes no performance, and audits the failure",async()=>{
   const record=data("2026-10-15","");
   const before=await db.ingestionRun.count({where:{source:"CSV_UPLOAD",status:"FAILED"}});
   await expect(ingestCsv(db,uploadSchema.parse(record))).rejects.toBeInstanceOf(ValidationError);
   expect(await db.ingestionRun.count({where:{source:"CSV_UPLOAD",status:"FAILED"}})).toBe(before+1);
   const branch=await db.branch.findUniqueOrThrow({where:{name:"Connaught Place"}});
   expect(await db.dailyPerformance.count({where:{branchId:branch.id,date:new Date("2026-10-15T00:00:00Z")}})).toBe(0);
 });
});
