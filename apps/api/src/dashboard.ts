import { Prisma, PrismaClient } from "@prisma/client";
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
  type BranchMetricRow = {
    id: number; name: string; region: string; managerName: string;
    revenue: number | null; revenueTarget: number | null; avgTatHours: number | null;
    pendingCases: number | null; openComplaints: number | null; slaBreaches: number | null;
    activeSlaBreaches: number | null; ticketCount: number | null;
  };

  // Two independent CTEs avoid a many-to-many join between daily performance and tickets.
  // This is the source of truth for the branch portfolio, not a frontend calculation.
  const rows = await prisma.$queryRaw<BranchMetricRow[]>(Prisma.sql`
    WITH performance_rollup AS (
      SELECT branch_id, SUM(revenue) AS revenue, SUM(revenue_target) AS revenue_target
      FROM daily_performance
      WHERE date >= ${range.from} AND date <= ${range.to}
      GROUP BY branch_id
    ), ticket_rollup AS (
      SELECT branch_id,
        COUNT(*) AS ticket_count,
        SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS pending_cases,
        SUM(CASE WHEN status = 'Open' AND type = 'Complaint' THEN 1 ELSE 0 END) AS open_complaints,
        SUM(CASE WHEN sla_breached = true THEN 1 ELSE 0 END) AS sla_breaches,
        SUM(CASE WHEN status = 'Open' AND sla_breached = true THEN 1 ELSE 0 END) AS active_sla_breaches,
        AVG(CASE WHEN status = 'Closed' AND resolved_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0 END) AS avg_tat_hours
      FROM operations_tickets
      WHERE created_at >= ${range.from} AND created_at <= ${range.to}
      GROUP BY branch_id
    )
    SELECT b.id, b.name, b.region, b.manager_name AS managerName,
      p.revenue, p.revenue_target AS revenueTarget, t.avg_tat_hours AS avgTatHours,
      t.pending_cases AS pendingCases, t.open_complaints AS openComplaints,
      t.sla_breaches AS slaBreaches, t.active_sla_breaches AS activeSlaBreaches, t.ticket_count AS ticketCount
    FROM branches b
    LEFT JOIN performance_rollup p ON p.branch_id = b.id
    LEFT JOIN ticket_rollup t ON t.branch_id = b.id
    ORDER BY b.name ASC
  `);

  return rows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const revenueTarget = Number(row.revenueTarget ?? 0);
    const ticketCount = Number(row.ticketCount ?? 0);
    const slaBreaches = Number(row.slaBreaches ?? 0);
    const openComplaints = Number(row.openComplaints ?? 0);
    const avgTatHours = Number(row.avgTatHours ?? 0);
    const breachPercentage = ticketCount ? (slaBreaches / ticketCount) * 100 : 0;
    const revenueAchievement = revenueTarget ? (revenue / revenueTarget) * 100 : 0;
    return {
      id: row.id, name: row.name, region: row.region, managerName: row.managerName,
      revenue, revenueTarget, revenueAchievement, avgTatHours,
      pendingCases: Number(row.pendingCases ?? 0), openComplaints, slaBreaches,
      activeSlaBreaches: Number(row.activeSlaBreaches ?? 0), breachPercentage, ticketCount,
      health: branchHealth({ id: row.id, name: row.name, breachPercentage, openComplaints, avgTatHours, revenueAchievement })
    };
  });
}

export function interventionFor(metric: Awaited<ReturnType<typeof getBranchMetrics>>[number]) {
  return deriveIntervention(metric);
}
