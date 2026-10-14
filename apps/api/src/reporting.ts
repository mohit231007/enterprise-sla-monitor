import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { getBranchMetrics, getDateRange, interventionFor } from "./dashboard.js";

export const sqlCatalog = [
 {id:"branch-performance",name:"Branch performance and SLA rollup",description:"Independent fact CTEs avoid revenue multiplication when branches have multiple tickets.",
 sql:`WITH performance_rollup AS (
  SELECT branch_id, SUM(revenue) AS revenue, SUM(revenue_target) AS revenue_target
  FROM daily_performance
  WHERE date >= :from AND date <= :to GROUP BY branch_id
), ticket_rollup AS (
  SELECT branch_id, COUNT(*) AS ticket_count,
   COUNT(*) FILTER (WHERE status='Open' AND type='Complaint') AS open_complaints,
   COUNT(*) FILTER (WHERE sla_breached) AS sla_breaches,
   AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600.0)
     FILTER (WHERE status='Closed' AND resolved_at IS NOT NULL) AS avg_tat_hours
  FROM operations_tickets WHERE created_at >= :from AND created_at <= :to GROUP BY branch_id
)
SELECT b.name, b.region, p.revenue, p.revenue_target,
 t.ticket_count, t.open_complaints, t.sla_breaches, t.avg_tat_hours
FROM branches b
LEFT JOIN performance_rollup p ON p.branch_id=b.id
LEFT JOIN ticket_rollup t ON t.branch_id=b.id
ORDER BY b.name`},
 {id:"regional-ranking",name:"Regional performance ranking",description:"Window function ranks branches within each region by target achievement.",
 sql:`WITH totals AS (
 SELECT b.name,b.region,SUM(p.revenue) AS revenue,SUM(p.revenue_target) AS target
 FROM branches b JOIN daily_performance p ON p.branch_id=b.id
 WHERE p.date>=:from AND p.date<=:to GROUP BY b.id,b.name,b.region
)
SELECT name,region,ROUND((100.0*revenue/NULLIF(target,0))::numeric,2) AS achievement_pct,
 DENSE_RANK() OVER (PARTITION BY region ORDER BY revenue/NULLIF(target,0) DESC NULLS LAST) AS regional_rank
FROM totals ORDER BY region,regional_rank`},
 {id:"daily-ticket-trend",name:"Daily ticket trend",description:"Time series of complaint and exception inflow.",
 sql:`SELECT DATE(created_at) AS day,
 COUNT(*) FILTER (WHERE type='Complaint') AS complaints,
 COUNT(*) FILTER (WHERE type='Exception') AS exceptions
 FROM operations_tickets WHERE created_at>=:from AND created_at<=:to
 GROUP BY DATE(created_at) ORDER BY day`}
] as const;
export type QueryId = typeof sqlCatalog[number]["id"];
export async function executeCatalogQuery(db:PrismaClient,id:QueryId,from:string,to:string){
 const range=await getDateRange(from,to);
 let rows:Record<string,unknown>[];
 if(id==="branch-performance"){
  rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`
   WITH p AS (SELECT branch_id,SUM(revenue) AS revenue,SUM(revenue_target) AS revenue_target
     FROM daily_performance WHERE date>=${range.from} AND date<=${range.to} GROUP BY branch_id),
   t AS (SELECT branch_id,COUNT(*) AS ticket_count,
     COUNT(*) FILTER(WHERE status='Open' AND type='Complaint') AS open_complaints,
     COUNT(*) FILTER(WHERE sla_breached) AS sla_breaches,
     AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600.0)
      FILTER(WHERE status='Closed' AND resolved_at IS NOT NULL) AS avg_tat_hours
     FROM operations_tickets WHERE created_at>=${range.from} AND created_at<=${range.to} GROUP BY branch_id)
   SELECT b.name,b.region,p.revenue,p.revenue_target,t.ticket_count,t.open_complaints,t.sla_breaches,t.avg_tat_hours
   FROM branches b LEFT JOIN p ON p.branch_id=b.id LEFT JOIN t ON t.branch_id=b.id ORDER BY b.name`);
 }else if(id==="regional-ranking"){
  rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`
   WITH totals AS (
     SELECT b.name,b.region,SUM(p.revenue) AS revenue,SUM(p.revenue_target) AS target
     FROM branches b JOIN daily_performance p ON p.branch_id=b.id
     WHERE p.date>=${range.from} AND p.date<=${range.to}
     GROUP BY b.id,b.name,b.region)
   SELECT name,region,ROUND((100.0*revenue/NULLIF(target,0))::numeric,2) AS achievement_pct,
     DENSE_RANK() OVER(PARTITION BY region ORDER BY revenue/NULLIF(target,0) DESC NULLS LAST) AS regional_rank
   FROM totals ORDER BY region,regional_rank`);
 }else{
  rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`
   SELECT DATE(created_at) AS day,
     COUNT(*) FILTER(WHERE type='Complaint') AS complaints,
     COUNT(*) FILTER(WHERE type='Exception') AS exceptions
   FROM operations_tickets WHERE created_at>=${range.from} AND created_at<=${range.to}
   GROUP BY DATE(created_at) ORDER BY day`);
 }
 return JSON.parse(JSON.stringify(rows,(_key,v)=>typeof v==="bigint"?Number(v):v)) as Record<string,unknown>[];
}
export async function createReport(db:PrismaClient,from:string,to:string){
 const range=await getDateRange(from,to);
 const metrics=await getBranchMetrics(range);
 const tickets=await db.operationsTicket.findMany({where:{
  createdAt:{gte:range.from,lte:range.to},status:"Closed",resolvedAt:{not:null}
 },select:{createdAt:true,resolvedAt:true}});
 const counts=metrics.reduce((a,b)=>({tickets:a.tickets+b.ticketCount,breaches:a.breaches+b.slaBreaches}),{tickets:0,breaches:0});
 const runs=await db.ingestionRun.findMany({where:{status:"SUCCESS",completedAt:{lte:new Date()}},select:{id:true},orderBy:{id:"asc"}});
 const payload={
   period:{from:from,to:to},
   summary:{
     totalRevenue:metrics.reduce((s,r)=>s+r.revenue,0),
     avgTatHours:tickets.length?tickets.reduce((s,t)=>s+(t.resolvedAt!.getTime()-t.createdAt.getTime())/3600000,0)/tickets.length:0,
     activeSlaBreaches:metrics.reduce((s,r)=>s+r.activeSlaBreaches,0),
     openComplaints:metrics.reduce((s,r)=>s+r.openComplaints,0),
     totalPendingCases:metrics.reduce((s,r)=>s+r.pendingCases,0),
     slaBreachRate:counts.tickets?100*counts.breaches/counts.tickets:0
   },
   branches:metrics,
   interventions:metrics.map(interventionFor).filter(Boolean),
   ingestionRunIds:runs.map(r=>r.id)
 };
 const serialized=JSON.stringify(payload);
 const hash=createHash("sha256").update(serialized).digest("hex");
 const id="BR360-"+randomUUID().slice(0,12).toUpperCase();
 const snapshot=await db.reportSnapshot.create({data:{
   id,dateFrom:new Date(from+"T00:00:00.000Z"),dateTo:new Date(to+"T00:00:00.000Z"),
   ingestionRunIds:payload.ingestionRunIds,payload:payload as unknown as Prisma.InputJsonValue,contentSha256:hash
 }});
 return {id:snapshot.id,createdAt:snapshot.createdAt,contentSha256:hash,...payload};
}
