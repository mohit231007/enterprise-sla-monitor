import { Prisma, PrismaClient, IngestionSource, IngestionStatus, TicketType, TicketStatus } from "@prisma/client";
import { z } from "zod";

export const DATASETS = {
  performance: ["branch_name","date","revenue","revenue_target","accounts_opened","loans_processed"],
  tickets: ["external_ticket_id","branch_name","type","status","created_at","resolved_at","sla_breached"]
} as const;
export type Dataset = keyof typeof DATASETS;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonnegative = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().nonnegative());
const nonnegativeInt = z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().nonnegative());
const performance = z.object({
  branch_name: z.string().trim().min(1), date: isoDay,
  revenue: nonnegative, revenue_target: nonnegative,
  accounts_opened: nonnegativeInt, loans_processed: nonnegativeInt
}).strict();
const ticket = z.object({
  external_ticket_id: z.string().trim().min(1).max(128),
  branch_name: z.string().trim().min(1),
  type: z.nativeEnum(TicketType), status: z.nativeEnum(TicketStatus),
  created_at: z.string().datetime({ offset: true }),
  resolved_at: z.union([z.string().datetime({ offset: true }), z.literal("")]),
  sla_breached: z.enum(["true","false"])
}).strict();

export const uploadSchema = z.object({
  dataset: z.enum(["performance","tickets"]),
  filename: z.string().min(1).max(160),
  columns: z.array(z.string()).max(20),
  rows: z.array(z.record(z.string())).min(1).max(1000)
}).strict();

function dateOnly(text: string) {
  const parsed = new Date(text + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==text) throw new Error("Invalid calendar date");
  return parsed;
}
export class ValidationError extends Error {
  constructor(public details: string[]) { super("CSV validation failed"); }
}
export async function ingestCsv(prisma: PrismaClient, input: z.infer<typeof uploadSchema>) {
  const expected = DATASETS[input.dataset];
  if (new Set(input.columns).size !== input.columns.length ||
      input.columns.length !== expected.length ||
      expected.some((column) => !input.columns.includes(column))) {
    throw new ValidationError(["Required columns: " + expected.join(", ")]);
  }
  const branches = await prisma.branch.findMany({select: {id:true,name:true}});
  const branchIds = new Map(branches.map((b)=>[b.name,b.id]));
  const errors: string[] = [];
  const keys = new Set<string>();
  const prepared: any[] = [];
  for (const [index, row] of input.rows.entries()) {
    const line = index+2;
    const result = (input.dataset === "performance" ? performance : ticket).safeParse(row);
    if (!result.success) {
      errors.push("Row "+line+": "+result.error.issues.map(x=>x.path.join(".")+" "+x.message).join("; "));
      continue;
    }
    const data = result.data;
    const branchId = branchIds.get(data.branch_name);
    if (!branchId) { errors.push("Row "+line+": unknown branch "+data.branch_name); continue; }
    try {
      if (input.dataset==="performance") {
        const p = data as z.infer<typeof performance>;
        const date = dateOnly(p.date);
        const key = branchId+":"+p.date;
        if (keys.has(key)) throw new Error("Duplicate branch/date in file");
        keys.add(key);
        prepared.push({branchId,date,revenue:p.revenue,revenueTarget:p.revenue_target,
          accountsOpened:p.accounts_opened,loansProcessed:p.loans_processed});
      } else {
        const t = data as z.infer<typeof ticket>;
        const createdAt=new Date(t.created_at);
        const resolvedAt=t.resolved_at ? new Date(t.resolved_at) : null;
        if (t.status==="Closed" && !resolvedAt) throw new Error("Closed ticket needs resolved_at");
        if (t.status==="Open" && resolvedAt) throw new Error("Open ticket cannot have resolved_at");
        if (resolvedAt && resolvedAt<createdAt) throw new Error("Resolved before created");
        if(keys.has(t.external_ticket_id)) throw new Error("Duplicate external_ticket_id in file");
        keys.add(t.external_ticket_id);
        prepared.push({externalTicketId:t.external_ticket_id,branchId,type:t.type,
          status:t.status,createdAt,resolvedAt,slaBreached:t.sla_breached==="true"});
      }
    } catch(err) { errors.push("Row "+line+": "+(err instanceof Error?err.message:"Invalid row")); }
    if (errors.length>=25) break;
  }
  if(errors.length) {
    await prisma.ingestionRun.create({data:{
      source:IngestionSource.CSV_UPLOAD,status:IngestionStatus.FAILED,
      recordsReceived:input.rows.length,recordsRejected:input.rows.length,
      completedAt:new Date(),notes:"Rejected "+input.dataset+" upload ("+input.filename+"): "+errors.slice(0,3).join(" | ")
    }});
    throw new ValidationError(errors);
  }
  // One set-based statement replaces N per-row UPSERTs. This avoids long-running
  // interactive transactions on hosted PostgreSQL poolers (Render + Supabase).
  // The write and its success audit share one short atomic database transaction.
  const latestEventAt = new Date(Math.max(...prepared.map(r=>(r.date??r.createdAt).getTime())));
  const dateFrom = new Date(Math.min(...prepared.map(r=>(r.date??r.createdAt).getTime()))).toISOString().slice(0,10);
  const dateTo = latestEventAt.toISOString().slice(0,10);
  const statement = input.dataset === "performance"
    ? Prisma.sql`
      INSERT INTO daily_performance
        (branch_id, date, revenue, revenue_target, accounts_opened, loans_processed)
      SELECT x.branch_id, x.date::timestamp, x.revenue, x.revenue_target,
             x.accounts_opened, x.loans_processed
      FROM jsonb_to_recordset(${JSON.stringify(prepared.map(r=>({
        branch_id:r.branchId,date:r.date.toISOString(),revenue:r.revenue,
        revenue_target:r.revenueTarget,accounts_opened:r.accountsOpened,
        loans_processed:r.loansProcessed
      })))}::jsonb) AS x(
        branch_id integer, date text, revenue double precision,
        revenue_target double precision, accounts_opened integer, loans_processed integer
      )
      ON CONFLICT (branch_id,date) DO UPDATE SET
        revenue=EXCLUDED.revenue,revenue_target=EXCLUDED.revenue_target,
        accounts_opened=EXCLUDED.accounts_opened,loans_processed=EXCLUDED.loans_processed
    `
    : Prisma.sql`
      INSERT INTO operations_tickets
        (external_ticket_id, branch_id, type, status, created_at, resolved_at, sla_breached)
      SELECT x.external_ticket_id, x.branch_id, x.type::"TicketType",
             x.status::"TicketStatus", x.created_at::timestamp,
             x.resolved_at::timestamp, x.sla_breached
      FROM jsonb_to_recordset(${JSON.stringify(prepared.map(r=>({
        external_ticket_id:r.externalTicketId,branch_id:r.branchId,
        type:r.type,status:r.status,created_at:r.createdAt.toISOString(),
        resolved_at:r.resolvedAt?.toISOString()??null,sla_breached:r.slaBreached
      })))}::jsonb) AS x(
        external_ticket_id text, branch_id integer, type text, status text,
        created_at text, resolved_at text, sla_breached boolean
      )
      ON CONFLICT (external_ticket_id) DO UPDATE SET
        branch_id=EXCLUDED.branch_id,type=EXCLUDED.type,
        status=EXCLUDED.status,created_at=EXCLUDED.created_at,
        resolved_at=EXCLUDED.resolved_at,sla_breached=EXCLUDED.sla_breached
    `;
  const [written,run] = await prisma.$transaction([
    prisma.$executeRaw(statement),
    prisma.ingestionRun.create({data:{
      source:IngestionSource.CSV_UPLOAD,status:IngestionStatus.SUCCESS,
      recordsReceived:prepared.length,recordsAccepted:prepared.length,
      recordsRejected:0,completedAt:new Date(),latestEventAt,
      notes:"Upload: "+input.filename+" ("+input.dataset+")"
    }})
  ]);
  if(written!==prepared.length) throw new Error("Database row count mismatch");
  return {runId:run.id,dataset:input.dataset,accepted:run.recordsAccepted,dateFrom,dateTo};
}
