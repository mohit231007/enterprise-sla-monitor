import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { getBranchMetrics, getDateRange, interventionFor, prisma } from "./dashboard.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:3000" }));
app.use(express.json());

const querySchema = z.object({ from: z.string().optional(), to: z.string().optional() });
const formatRange = (from: Date, to: Date) => ({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });

app.get("/health", (_request, response) => response.json({ status: "ok" }));

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
