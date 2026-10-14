"use client";
import { useState } from "react";
import { Braces, ChevronDown } from "lucide-react";

const sql = `WITH performance_rollup AS (
  SELECT branch_id, SUM(revenue) AS revenue
  FROM daily_performance
  WHERE date BETWEEN :from AND :to
  GROUP BY branch_id
), ticket_rollup AS (
  SELECT branch_id, COUNT(*) AS ticket_count,
    AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0) AS avg_tat_hours
  FROM operations_tickets
  WHERE created_at BETWEEN :from AND :to
  GROUP BY branch_id
)
SELECT ... FROM branches b
LEFT JOIN performance_rollup p ON p.branch_id = b.id
LEFT JOIN ticket_rollup t ON t.branch_id = b.id;`;

export function SqlExplorer() {
  const [open, setOpen] = useState(false);
  return <section className="panel mb-6 overflow-hidden"><button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-5 py-4 text-left"><span className="flex items-center gap-3"><span className="rounded-lg bg-slate-900 p-2 text-white"><Braces size={17} /></span><span><span className="block font-semibold text-slate-900">SQL analytics layer</span><span className="mt-0.5 block text-sm text-slate-500">Inspect the CTE pattern that derives the dashboard metrics.</span></span></span><ChevronDown className={`text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} size={19} /></button>{open && <div className="border-t border-slate-200 bg-slate-950 p-5"><p className="mb-3 text-xs leading-5 text-slate-300">Performance and ticket facts are rolled up independently before joining—preventing duplicated revenue when a branch has many tickets.</p><pre className="overflow-x-auto text-xs leading-5 text-emerald-300"><code>{sql}</code></pre></div>}</section>;
}
