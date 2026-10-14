# Branch360 Reporting Workspace
This enhancement preserves the original simulated-live label and existing banker-key upload behavior.

## Features
1. **SQL Explorer:** Three *curated, read-only* PostgreSQL queries displayed as executable SQL and executed with server-bound date parameters. Freeform SQL is intentionally not accepted from the browser.
2. **Export:** CSV download, Excel-compatible SpreadsheetML XML (open in Excel), and browser Print/Save as PDF. This is not a native XLSX export or a server-rendered PDF.
3. **Ingestion history:** Recent 100 ingestion events including successes and failed validation runs.
4. **Reproducibility:** Save a report snapshot in PostgreSQL with generated BR360-* ID, creation timestamp, SHA-256 content digest, the reporting date range and ingestion run IDs. A snapshot remains retrievable at GET /api/dashboard/reports/:id even after new data uploads.

## Test and deploy
- CI runs Prisma migration deploy against its test PostgreSQL instance.
- In Render, deployment start applies the new report_snapshots migration.
- Verify latest deployment is live, then click SAVE REPORT SNAPSHOT for an August range.
- Verify snapshot stored: SELECT id, created_at, content_sha256 FROM report_snapshots ORDER BY created_at DESC LIMIT 5;
- Test SQL Explorer, ingestion history, CSV, Excel-compatible XML and Print/Save as PDF.

## Important limitations
- The curated SQL shown is logically equivalent to the executed parameterized SQL; it uses :from/:to placeholders.
- CSV and Excel-compatible downloads cover report summary plus branch target achievement, not every chart series. Print/PDF uses the browser view.
- Ingestion run IDs are provenance candidates, not exact row-level source lineage: the current schema does not preserve row-to-run associations.
- The application remains a **synthetic portfolio demo**. No banker-account or SSO changes were made.
- This version does not provide a regulated/signed banking report or unrestricted SQL execution.
