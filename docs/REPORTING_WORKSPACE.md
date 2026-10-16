# Branch360 Reporting Workspace
This enhancement preserves the original simulated-live label and existing banker-key upload behavior.

**Evidence scope:** Describes the repository at commit `9f272473320619f6177836de7cac3fba32d18f9c` with this documentation correction. All sample data is synthetic; snapshots are payload digests, not cryptographically signed row-level lineage.

## Features
1. **SQL Explorer:** Three *curated, read-only* PostgreSQL queries displayed as executable SQL and executed with server-bound date parameters. Freeform SQL is intentionally not accepted from the browser.
2. **Export:** CSV download, native OOXML `.xlsx` (four worksheets: Summary, Branches, Interventions, Audit metadata), and browser Print/Save as PDF. PDF is browser-generated, not server-rendered.
3. **Ingestion history:** Recent 100 ingestion events including successes and failed validation runs.
4. **Reproducibility:** Save a report snapshot in PostgreSQL with generated BR360-* ID, creation timestamp, SHA-256 content digest, the reporting date range and ingestion run IDs. A snapshot remains retrievable at GET /api/dashboard/reports/:id even after new data uploads.

## Test and deploy
- CI runs Prisma migration deploy against its test PostgreSQL instance.
- In Render, deployment start applies the new report_snapshots migration.
- Verify latest deployment is live, then click SAVE REPORT SNAPSHOT for an August range.
- Verify snapshot stored: SELECT id, created_at, content_sha256 FROM report_snapshots ORDER BY created_at DESC LIMIT 5;
- Test SQL Explorer, ingestion history, CSV, native XLSX and Print/Save as PDF. Verify the XLSX ZIP/OOXML package with an independent spreadsheet reader.

## Important limitations
- The curated SQL shown is logically equivalent to the executed parameterized SQL; it uses :from/:to placeholders.
- CSV exports a subset of metrics. Native XLSX provides summary, branch-level metrics, intervention rows and snapshot metadata, but is not a complete chart-series or row-level provenance export. Print/PDF uses the browser view.
- Ingestion run IDs are provenance candidates, not exact row-level source lineage: the current schema does not preserve row-to-run associations.
- The application remains a **synthetic portfolio demo**. No banker-account or SSO changes were made.
- This version does not provide a regulated/signed banking report or unrestricted SQL execution.
