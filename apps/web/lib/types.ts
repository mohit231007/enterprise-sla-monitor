export type Summary = { dateRange: { from: string; to: string }; totalRevenue: number; avgTatHours: number; activeSlaBreaches: number; openComplaints: number; totalPendingCases: number; slaBreachRate: number };
export type Branch = { id: number; name: string; region: string; managerName: string; revenue: number; revenueTarget: number; revenueAchievement: number; avgTatHours: number; pendingCases: number; openComplaints: number; slaBreaches: number; activeSlaBreaches: number; breachPercentage: number; ticketCount: number; health: "Healthy" | "Watch" | "At risk" };
export type Intervention = { branchId: number; branchName: string; criticalMetric: string; suggestedAction: string; status: "Critical" | "Warning"; breachPercentage: number; openComplaints: number; avgTatHours: number };
export type Trend = { date: string; complaints: number; exceptions: number };
export type DashboardData = { summary: Summary; branches: Branch[]; interventions: Intervention[]; trends: Trend[] };
