import { LucideIcon, TrendingDown, TrendingUp } from "lucide-react";

export function KpiCard({ label, value, detail, icon: Icon, tone = "blue", trend }: { label: string; value: string; detail: string; icon: LucideIcon; tone?: "blue" | "red" | "amber" | "green"; trend?: "up" | "down" }) {
  const colors = { blue: "bg-blue-50 text-blue-600", red: "bg-red-50 text-red-600", amber: "bg-amber-50 text-amber-600", green: "bg-emerald-50 text-emerald-600" };
  return <div className="panel p-5"><div className="flex items-start justify-between"><div><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p></div><span className={`rounded-xl p-2.5 ${colors[tone]}`}><Icon size={20} /></span></div><div className="mt-4 flex items-center gap-1.5 text-xs text-slate-500">{trend === "up" && <TrendingUp size={14} className="text-emerald-600" />}{trend === "down" && <TrendingDown size={14} className="text-red-600" />}{detail}</div></div>;
}
