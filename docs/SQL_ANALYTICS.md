# Branch360 SQL Analytics Layer

Branch360 intentionally performs its core portfolio calculation in parameterised SQL rather than calculating metrics in React.

## Data contracts

| Layer | Table | Grain | Purpose |
| --- | --- | --- | --- |
| Master | `branches` | Branch | Organisational ownership and region |
| Fact | `daily_performance` | Branch × business day | Revenue, target, accounts, loans |
| Fact | `operations_tickets` | Ticket | Case lifecycle, TAT, breach state |
| Audit | `ingestion_runs` | Ingestion execution | Source, accepted/rejected records, freshness |

## SQL design decision

`daily_performance` and `operations_tickets` have different grains. Joining both tables directly on branch would multiply revenue by the ticket count. The API therefore first aggregates each fact independently using CTEs and only then joins the two branch-level rollups.

```sql
WITH performance_rollup AS (
  SELECT branch_id, SUM(revenue) AS revenue, SUM(revenue_target) AS revenue_target
  FROM daily_performance
  WHERE date BETWEEN :from AND :to
  GROUP BY branch_id
), ticket_rollup AS (
  SELECT branch_id,
    COUNT(*) AS ticket_count,
    SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS pending_cases,
    SUM(CASE WHEN status = 'Open' AND type = 'Complaint' THEN 1 ELSE 0 END) AS open_complaints,
    SUM(CASE WHEN sla_breached = 1 THEN 1 ELSE 0 END) AS sla_breaches,
    AVG(CASE WHEN status = 'Closed' AND resolved_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0 END) AS avg_tat_hours
  FROM operations_tickets
  WHERE created_at BETWEEN :from AND :to
  GROUP BY branch_id
)
SELECT *
FROM branches b
LEFT JOIN performance_rollup p ON p.branch_id = b.id
LEFT JOIN ticket_rollup t ON t.branch_id = b.id;
```

## Live-simulated demo mode

`POST /api/dashboard/demo/tick` writes a new ticket and updates the current business-day fact in a transaction. The dashboard then re-queries the database. Every operation creates an `ingestion_runs` audit record and the UI labels the data source as `SIMULATED LIVE`; it never represents the demo as real bank data.

## Production swap

Replace SQLite with PostgreSQL and replace the demo tick endpoint with an authenticated CSV/SFTP/API/Kafka ingestion worker. The SQL pattern and dashboard contract remain unchanged.
