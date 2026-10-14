import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { disconnectSeedDatabase, seedDatabase } from "./seed.js";

const prisma = new PrismaClient();

async function main() {
  const branchCount = await prisma.branch.count();
  await prisma.$disconnect();
  if (branchCount === 0) {
    await seedDatabase();
    await disconnectSeedDatabase();
    console.log("Branch360 database bootstrapped with demo data.");
  } else {
    console.log("Branch360 database already contains data; bootstrap skipped.");
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
