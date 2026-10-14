import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { getBranchMetrics, getDateRange, interventionFor, prisma } from "./dashboard.js";
import { appendDemoEvent } from "./demo-stream.js";
import { ingestCsv, uploadSchema, ValidationError } from "./csv-ingest.js";
import { createReport, executeCatalogQuery, sqlCatalog } from "./reporting.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadAttempts = new Map<string,{count:number;reset:number}>();
function allowUpload(ip:string):boolean{
 const now=Date.now();const old=uploadAttempts.get(ip);
 const next=!old||old.reset<now?{count:1,reset:now+60_000}:{count:old.count+1,reset:old.reset};
 uploadAttempts.set(ip,next);
 if(uploadAttempts.size>5000)for(const [key,value] of uploadAttempts)if(value.reset<now)uploadAttempts.delete(key);
 return next.count<=10;
}

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:3000" }));
app.use(express.json({limit:"600kb"}));

const querySchema = z.object({ from: z.string().optional(), to: z.string().optional() });
const formatRange = (from: Date, to: Date) => ({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });

app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.get("/api/dashboard/data-status", async (_request, response, next) => {
  try {
    const [latestRun, totalRuns] = await Promise.all([
      prisma.ingestionRun.findFirst({ orderBy: { startedAt: "desc" } }),
      prisma.ingestionRun.count()
    ]);
    response.json({
      mode: process.env.DATA_MODE ?? "SIMULATED_LIVE",
      database: "PostgreSQL",
      totalRuns,
      latestRun: latestRun && {
        source: latestRun.source,
        status: latestRun.status,
        completedAt: latestRun.completedAt,
        recordsAccepted: latestRun.recordsAccepted,
        recordsRejected: latestRun.recordsRejected,
        latestEventAt: latestRun.latestEventAt,
        notes: latestRun.notes
      }
    });
  } catch (error) { next(error); }
});

app.post("/api/dashboard/demo/tick", async (_request, response, next) => {
  try {
    const event = await appendDemoEvent(prisma);
    response.status(201).json({ message: "Simulated operational event ingested.", event });
  } catch (error) { next(error); }
});

app.post("/api/dashboard/upload", async (request,response,next) => {
  try {
    if(!allowUpload(request.ip??"unknown")){response.status(429).json({error:"Upload rate limit exceeded."});return;}
    // This key is provisioned server-side. Never expose it as NEXT_PUBLIC_*.
    const expected=process.env.BANKER_UPLOAD_KEY;
    const supplied=request.header("x-banker-upload-key") ?? "";
    const { timingSafeEqual }=await import("node:crypto");
    if(!expected || !supplied || Buffer.byteLength(expected)!==Buffer.byteLength(supplied) ||
       !timingSafeEqual(Buffer.from(expected),Buffer.from(supplied))) {
       response.status(401).json({error:"Banker upload authorization required."});return;
    }
    const input=uploadSchema.parse(request.body);
    if(!input.filename.toLowerCase().endsWith(".csv")){response.status(422).json({error:"Only CSV files are allowed."});return;}
    const result=await ingestCsv(prisma,input);
    response.status(201).json(result);
  }catch(error){
    if(error instanceof ValidationError){response.status(422).json({error:error.message,details:error.details});return;}
    if(error instanceof z.ZodError){response.status(422).json({error:"Invalid upload payload",details:error.issues.map(i=>i.path.join(".")+": "+i.message)});return;}
    next(error);
  }
});

app.get("/api/dashboard/sql-catalog", (_request,response)=>response.json({queries:sqlCatalog}));
app.get("/api/dashboard/sql-results",async(request,response,next)=>{
 try{
  const parsed=z.object({id:z.enum(["branch-performance","regional-ranking","daily-ticket-trend"]),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).parse(request.query);
  response.json({rows:await executeCatalogQuery(prisma,parsed.id,parsed.from,parsed.to)});
 }catch(e){next(e);}
});
app.get("/api/dashboard/ingestion-history",async(_request,response,next)=>{
 try{const runs=await prisma.ingestionRun.findMany({orderBy:{startedAt:"desc"},take:100});response.json({runs});}
 catch(e){next(e);}
});
app.post("/api/dashboard/reports",async(request,response,next)=>{
 try{
  const input=z.object({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).parse(request.body);
  response.status(201).json(await createReport(prisma,input.from,input.to));
 }catch(e){next(e);}
});
app.get("/api/dashboard/reports/:id",async(request,response,next)=>{
 try{
  const report=await prisma.reportSnapshot.findUnique({where:{id:request.params.id}});
  if(!report){response.status(404).json({error:"Report not found"});return;}
  response.json({id:report.id,createdAt:report.createdAt,contentSha256:report.contentSha256,payload:report.payload});
 }catch(e){next(e);}
});

// Backward-compatible catalog route. Use the same PostgreSQL query definitions as the SQL Explorer.
app.get("/api/dashboard/query-catalog", (_request, response) => response.json({
  queries: sqlCatalog.map(({id, name, description, sql}) => ({
    id, name, purpose: description, sql
  }))
}));

app.get("/api/dashboard/summary", async (request, response, next) => {
  try {
    const { from, to } = querySchema.parse(request.query);
    const range = await getDateRange(from, to);
    const metrics = await getBranchMetrics(range);
    const totalTickets = metrics.reduce((sum, row) => sum + row.ticketCount, 0);
    const totalBreaches = metrics.reduce((sum, row) => sum + row.slaBreaches, 0);
    const weightedTatTickets = await prisma.operationsTicket.findMany({
      where: { createdAt: { gte: range.from, lte: range.to }, status: "Closed", resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true }
    });
    const avgTatHours = weightedTatTickets.length
      ? weightedTatTickets.reduce((sum, ticket) => sum + (ticket.resolvedAt!.getTime() - ticket.createdAt.getTime()) / 3_600_000, 0) / weightedTatTickets.length
      : 0;
    response.json({
      dateRange: formatRange(range.from, range.to),
      totalRevenue: metrics.reduce((sum, row) => sum + row.revenue, 0),
      avgTatHours,
      activeSlaBreaches: metrics.reduce((sum, row) => sum + row.activeSlaBreaches, 0),
      openComplaints: metrics.reduce((sum, row) => sum + row.openComplaints, 0),
      totalPendingCases: metrics.reduce((sum, row) => sum + row.pendingCases, 0),
      slaBreachRate: totalTickets ? (totalBreaches / totalTickets) * 100 : 0
    });
  } catch (error) { next(error); }
});

app.get("/api/dashboard/branches", async (request, response, next) => {
  try {
    const { from, to } = querySchema.parse(request.query);
    const range = await getDateRange(from, to);
    response.json({ dateRange: formatRange(range.from, range.to), branches: await getBranchMetrics(range) });
  } catch (error) { next(error); }
});

app.get("/api/dashboard/interventions", async (request, response, next) => {
  try {
    const { from, to } = querySchema.parse(request.query);
    const range = await getDateRange(from, to);
    const interventions = (await getBranchMetrics(range)).map(interventionFor).filter(Boolean);
    response.json({ dateRange: formatRange(range.from, range.to), interventions });
  } catch (error) { next(error); }
});

app.get("/api/dashboard/trends", async (request, response, next) => {
  try {
    const { from, to } = querySchema.parse(request.query);
    const range = await getDateRange(from, to);
    const tickets = await prisma.operationsTicket.findMany({
      where: { createdAt: { gte: range.from, lte: range.to }, type: { in: ["Complaint", "Exception"] } },
      select: { type: true, createdAt: true }
    });
    const days = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000) + 1;
    const series = Array.from({ length: days }, (_, index) => {
      const date = new Date(range.from.getTime() + index * 86_400_000).toISOString().slice(0, 10);
      return { date, complaints: 0, exceptions: 0 };
    });
    const dayIndex = new Map(series.map((point, index) => [point.date, index]));
    tickets.forEach((ticket) => {
      const item = series[dayIndex.get(ticket.createdAt.toISOString().slice(0, 10)) ?? -1];
      if (item) ticket.type === "Complaint" ? item.complaints++ : item.exceptions++;
    });
    response.json({ dateRange: formatRange(range.from, range.to), trends: series });
  } catch (error) { next(error); }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  response.status(message.includes("valid") ? 400 : 500).json({ error: message });
});

app.listen(port, () => console.log(`Branch360 API listening on http://localhost:${port}`));
