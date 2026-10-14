import "dotenv/config";
import { PrismaClient, TicketStatus, TicketType } from "@prisma/client";

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const today = new Date();
today.setHours(0, 0, 0, 0);

const branches = [
  { name: "Connaught Place", region: "North", managerName: "Riya Mehta", baseRevenue: 720000, target: 760000, ticketVolume: 66, breachRate: 0.07, openComplaints: 6 },
  { name: "Banjara Hills", region: "South", managerName: "Arjun Rao", baseRevenue: 610000, target: 650000, ticketVolume: 75, breachRate: 0.16, openComplaints: 9 },
  { name: "Bandra West", region: "West", managerName: "Neha Kapoor", baseRevenue: 810000, target: 790000, ticketVolume: 88, breachRate: 0.13, openComplaints: 18 },
  { name: "Salt Lake", region: "East", managerName: "Sourav Das", baseRevenue: 540000, target: 590000, ticketVolume: 58, breachRate: 0.05, openComplaints: 4 },
  { name: "Indiranagar", region: "South", managerName: "Kavya Iyer", baseRevenue: 680000, target: 700000, ticketVolume: 80, breachRate: 0.09, openComplaints: 17 }
];

function offsetDate(daysAgo: number, hour = 9): Date {
  return new Date(today.getTime() - daysAgo * DAY_MS + hour * 60 * 60 * 1000);
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 9301 + 49297) * 233280;
  return value - Math.floor(value);
}

async function main() {
  await prisma.operationsTicket.deleteMany();
  await prisma.dailyPerformance.deleteMany();
  await prisma.branch.deleteMany();

  for (const [branchIndex, branchData] of branches.entries()) {
    const branch = await prisma.branch.create({ data: branchData });

    const performance = Array.from({ length: 30 }, (_, index) => {
      const daysAgo = 29 - index;
      const weekdayMultiplier = [0.84, 1.03, 1.05, 1.04, 1.08, 0.98, 0.72][offsetDate(daysAgo).getDay()];
      const variation = 0.90 + pseudoRandom(branchIndex * 100 + index) * 0.20;
      const revenue = Math.round(branchData.baseRevenue * weekdayMultiplier * variation);
      return {
        branchId: branch.id,
        date: offsetDate(daysAgo),
        revenue,
        revenueTarget: Math.round(branchData.target * weekdayMultiplier),
        accountsOpened: Math.round(12 + pseudoRandom(index + branchIndex * 31) * 24),
        loansProcessed: Math.round(4 + pseudoRandom(index + branchIndex * 17) * 11)
      };
    });
    await prisma.dailyPerformance.createMany({ data: performance });

    const tickets = Array.from({ length: branchData.ticketVolume }, (_, index) => {
      const createdDaysAgo = Math.floor(pseudoRandom(branchIndex * 1000 + index) * 30);
      const createdAt = new Date(offsetDate(createdDaysAgo, 8 + (index % 9)));
      const complaint = index < branchData.openComplaints || index % 3 === 0;
      const type = complaint ? TicketType.Complaint : index % 2 === 0 ? TicketType.Exception : TicketType.Case;
      const isForcedOpenComplaint = index < branchData.openComplaints;
      const open = isForcedOpenComplaint || (index % 11 === 0 && createdDaysAgo < 9);
      const slaBreached = index % 100 < Math.round(branchData.breachRate * 100);
      const turnaroundHours = slaBreached ? 50 + (index % 50) : 5 + (index % 28);
      return {
        branchId: branch.id,
        type,
        status: open ? TicketStatus.Open : TicketStatus.Closed,
        createdAt,
        resolvedAt: open ? null : new Date(createdAt.getTime() + turnaroundHours * 60 * 60 * 1000),
        slaBreached
      };
    });
    await prisma.operationsTicket.createMany({ data: tickets });
  }

  console.log("Seeded 5 branches, 150 daily performance records, and operational tickets.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
