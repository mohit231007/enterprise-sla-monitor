CREATE TABLE "report_snapshots" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "date_from" DATE NOT NULL,
  "date_to" DATE NOT NULL,
  "ingestion_run_ids" JSONB NOT NULL,
  "payload" JSONB NOT NULL,
  "content_sha256" TEXT NOT NULL
);
CREATE INDEX "report_snapshots_created_at_idx" ON "report_snapshots"("created_at");