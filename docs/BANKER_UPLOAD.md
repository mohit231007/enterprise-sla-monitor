# Banker CSV upload and SQL report workflow

The feature branch adds a banker-facing **Data Upload** panel and explicit **GENERATE REPORT** refresh.

## Setup
- Apply the included Prisma migration using `npm run db:migrate` (Render's configured build/start process already includes migrations).
- Configure `BANKER_UPLOAD_KEY` **only on the API server** using a long, randomly generated secret. Never set a `NEXT_PUBLIC_` upload secret.
- Refresh the deployed web build after merging. Existing `CORS_ORIGIN` must match the web origin.
- Start with synthetic, non-personal data. The shared banker secret is only a demo gate, not production-grade multi-user authentication.

## Banker walkthrough
1. Select *Daily performance* or *Operational tickets* in **Banker data upload**.
2. Download the matching CSV template.
3. Use branch names already stored in the database; file headers must exactly match the template (any order).
4. Choose the CSV file (max 500 KB and 1,000 rows), enter the secret, press **VALIDATE & UPLOAD**.
5. Server validates the entire batch before writing; invalid batches return row numbers and commit nothing.
6. Valid batches are written using transactional UPSERT, and a successful `CSV_UPLOAD` ingestion run is saved.
7. Press **GENERATE REPORT** to set the uploaded period and fetch fresh SQL analytics.

## Templates
Daily performance:
```csv
branch_name,date,revenue,revenue_target,accounts_opened,loans_processed
Connaught Place,2026-10-14,950000,900000,35,14
```
Operational tickets:
```csv
external_ticket_id,branch_name,type,status,created_at,resolved_at,sla_breached
TKT-001,Connaught Place,Complaint,Open,2026-10-14T09:00:00Z,,false
```
`external_ticket_id` is stable across uploads, preventing repeated ticket creation.

## Security and known limits
- Uploads require the header `x-banker-upload-key`; the server compares it with `BANKER_UPLOAD_KEY`.
- A single shared credential is **not sufficient for real banking production**. Replace with SSO/OIDC, role-based authorization, per-user audit metadata, rate limiting, and anti-malware controls before handling real bank data.
- Report endpoints and legacy demo event remain publicly accessible in the original application; secure them before handling sensitive data.
- This release writes valid uploads atomically. It records successful ingestion runs, but does not yet persist failed validation attempts. A full ingestion-attempt audit ledger is a follow-up requirement.
- The dashboard reports current SQL metrics for the selected date range; it does not produce a signed regulatory report, PDF, or versioned snapshot.
- Row numbers in validation errors reference the CSV data header as line 1 (embedded newlines inside quoted cells may change physical line numbers).
