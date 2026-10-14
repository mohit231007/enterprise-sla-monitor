ALTER TABLE "operations_tickets" ADD COLUMN "external_ticket_id" TEXT;
CREATE UNIQUE INDEX "operations_tickets_external_ticket_id_key" ON "operations_tickets"("external_ticket_id");