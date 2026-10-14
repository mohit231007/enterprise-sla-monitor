export type InterventionCandidate = {
  id: number;
  name: string;
  breachPercentage: number;
  openComplaints: number;
  avgTatHours: number;
};

/** Applies the approved Branch360 intervention policy without database coupling. */
export function deriveIntervention(metric: InterventionCandidate) {
  const highBreaches = metric.breachPercentage > 10;
  const highComplaints = metric.openComplaints > 15;
  if (!highBreaches && !highComplaints) return null;

  const criticalMetric = highBreaches && highComplaints
    ? "SLA breach rate and open complaints"
    : highComplaints ? "Open complaints" : "SLA breach rate";
  const suggestedAction = highBreaches && highComplaints
    ? "Run an operations audit and allocate overflow complaint-resolution staff."
    : highComplaints
      ? "Allocate overflow staff and run a daily complaint backlog review."
      : "Audit the operations team and review workflow bottlenecks.";

  return {
    branchId: metric.id,
    branchName: metric.name,
    criticalMetric,
    suggestedAction,
    status: highBreaches && highComplaints ? "Critical" as const : "Warning" as const,
    breachPercentage: metric.breachPercentage,
    openComplaints: metric.openComplaints,
    avgTatHours: metric.avgTatHours
  };
}

export function branchHealth(metric: InterventionCandidate & { revenueAchievement: number }) {
  if (metric.breachPercentage > 10 || metric.openComplaints > 15) return "At risk" as const;
  if (metric.avgTatHours > 36 || metric.revenueAchievement < 90) return "Watch" as const;
  return "Healthy" as const;
}
