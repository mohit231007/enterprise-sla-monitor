import { IngestionSource, IngestionStatus, PrismaClient, TicketType } from "@prisma/client";

const businessDay = () => { const value = new Date(); value.setHours(9, 0, 0, 0); return value; };

/** Inserts one clearly labelled synthetic operational event for a live demo. */
export async function appendDemoEvent(prisma: PrismaClient) {
  const branches = await prisma.branch.findMany({ orderBy: { id: "asc" } });
  if (!branches.length) throw new Error("No branches are available. Run npm run db:seed first.");
  const now = new Date();
  const branch = branches[(now.getMinutes() + now.getSeconds()) % branches.length];
  const type = [TicketType.Case, TicketType.Complaint, TicketType.Exception][now.getSeconds() % 3];
  const slaBreached = type === TicketType.Complaint && now.getSeconds() % 2 === 0;
  const run = await prisma.ingestionRun.create({ data: { source: IngestionSource.DEMO_STREAM, recordsReceived: 2 } });

  await prisma.$transaction(async (tx) => {
    const date = businessDay();
    await tx.dailyPerformance.upsert({
      where: { branchId_date: { branchId: branch.id, date } },
      update: { revenue: { increment: 15000 + (now.getSeconds() % 10) * 1000 }, accountsOpened: { increment: 1 } },
      create: { branchId: branch.id, date, revenue: 15000, revenueTarget: 25000, accountsOpened: 1, loansProcessed: 0 }
    });
    await tx.operationsTicket.create({
      data: { branchId: branch.id, type, status: "Open", createdAt: now, resolvedAt: null, slaBreached }
    });
    await tx.ingestionRun.update({
      where: { id: run.id },
      data: { status: IngestionStatus.SUCCESS, completedAt: new Date(), recordsAccepted: 2, latestEventAt: now, notes: `Demo event: ${type} at ${branch.name}.` }
    });
  });

  return { branchName: branch.name, type, slaBreached, ingestedAt: now.toISOString() };
}
