-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "TicketType" AS ENUM ('Case', 'Complaint', 'Exception');
CREATE TYPE "TicketStatus" AS ENUM ('Open', 'Closed');
CREATE TYPE "IngestionSource" AS ENUM ('SEED', 'DEMO_STREAM', 'CSV_UPLOAD');
CREATE TYPE "IngestionStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

CREATE TABLE "branches" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "manager_name" TEXT NOT NULL,
  CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "daily_performance" (
  "id" SERIAL NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "revenue" DOUBLE PRECISION NOT NULL,
  "revenue_target" DOUBLE PRECISION NOT NULL,
  "accounts_opened" INTEGER NOT NULL,
  "loans_processed" INTEGER NOT NULL,
  CONSTRAINT "daily_performance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations_tickets" (
  "id" SERIAL NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "type" "TicketType" NOT NULL,
  "status" "TicketStatus" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "sla_breached" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "operations_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingestion_runs" (
  "id" SERIAL NOT NULL,
  "source" "IngestionSource" NOT NULL,
  "status" "IngestionStatus" NOT NULL DEFAULT 'RUNNING',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "records_received" INTEGER NOT NULL DEFAULT 0,
  "records_accepted" INTEGER NOT NULL DEFAULT 0,
  "records_rejected" INTEGER NOT NULL DEFAULT 0,
  "latest_event_at" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branches_name_key" ON "branches"("name");
CREATE INDEX "daily_performance_date_idx" ON "daily_performance"("date");
CREATE UNIQUE INDEX "daily_performance_branch_id_date_key" ON "daily_performance"("branch_id", "date");
CREATE INDEX "operations_tickets_branch_id_created_at_idx" ON "operations_tickets"("branch_id", "created_at");
CREATE INDEX "operations_tickets_status_type_idx" ON "operations_tickets"("status", "type");
CREATE INDEX "ingestion_runs_started_at_idx" ON "ingestion_runs"("started_at");

ALTER TABLE "daily_performance" ADD CONSTRAINT "daily_performance_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "operations_tickets" ADD CONSTRAINT "operations_tickets_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
