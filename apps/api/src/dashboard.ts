import { PrismaClient, TicketStatus, TicketType } from "@prisma/client";
import { branchHealth, deriveIntervention } from "./interventions.js";

export const prisma = new PrismaClient();

export type DateRange = { from: Date; to: Date };

export function toInclusiveEnd(date: Date) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

export async function getDateRange(from?: string, to?: string): Promise<DateRange> {
  const latest = await prisma.dailyPerformance.aggregate({ _max: { date: true } });
  const end = to ? toInclusiveEnd(new Date(`${to}T00:00:00`)) : toInclusiveEnd(latest._max.date ?? new Date());
  const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
    throw new Error("Use valid YYYY-MM-DD dates, with from before to.");
  }
  return { from: start, to: end };
}

export async function getBranchMetrics(range: DateRange) {
  const branches = await prisma.branch.findMany({
    include: {
      performance: { where: { date: { gte: range.from, lte: range.to } } },
      tickets: { where: { createdAt: { gte: range.from, lte: range.to } } }
    },
    orderBy: { name: "asc" }
  });

  return branches.map((branch) => {
    const revenue = branch.performance.reduce((sum, item) => sum + item.revenue, 0);
    const revenueTarget = branch.performance.reduce((sum, item) => sum + item.revenueTarget, 0);
    const closed = branch.tickets.filter((ticket) => ticket.status === TicketStatus.Closed && ticket.resolvedAt);
    const tatHours = closed.map((ticket) => (ticket.resolvedAt!.getTime() - ticket.createdAt.getTime()) / 3_600_000);
    const breached = branch.tickets.filter((ticket) => ticket.slaBreached).length;
    const openTickets = branch.tickets.filter((ticket) => ticket.status === TicketStatus.Open);
    const openComplaints = openTickets.filter((ticket) => ticket.type === TicketType.Complaint).length;
    const breachPercentage = branch.tickets.length ? (breached / branch.tickets.length) * 100 : 0;

    const avgTatHours = tatHours.length ? tatHours.reduce((sum, hours) => sum + hours, 0) / tatHours.length : 0;
    const revenueAchievement = revenueTarget ? (revenue / revenueTarget) * 100 : 0;
    return {
      id: branch.id,
      name: branch.name,
      region: branch.region,
      managerName: branch.managerName,
      revenue,
      revenueTarget,
      revenueAchievement,
      avgTatHours,
      pendingCases: openTickets.length,
      openComplaints,
      slaBreaches: breached,
      activeSlaBreaches: openTickets.filter((ticket) => ticket.slaBreached).length,
      breachPercentage,
      ticketCount: branch.tickets.length,
      health: branchHealth({ id: branch.id, name: branch.name, breachPercentage, openComplaints, avgTatHours, revenueAchievement })
    };
  });
}

export function interventionFor(metric: Awaited<ReturnType<typeof getBranchMetrics>>[number]) {
  return deriveIntervention(metric);
}
