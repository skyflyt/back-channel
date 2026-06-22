// Backfill: every account with a legacy apiKey gets an "Original" AgentToken
// (keyHash = hash(apiKey)) so its existing key keeps working AND shows up in the
// new "Registered agents" list. Idempotent: re-running creates nothing new.
// Usage: node migrate-agent-tokens.mjs [--dry-run]
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
const prisma = new PrismaClient();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const DRY = process.argv.includes("--dry-run");

async function main() {
  const accounts = await prisma.account.findMany({ where: { apiKey: { not: null } }, select: { id: true, handle: true, apiKey: true, createdAt: true } });
  console.log(`${accounts.length} accounts with a legacy apiKey`);
  let created = 0, skipped = 0;
  for (const a of accounts) {
    const keyHash = hash(a.apiKey);
    const existing = await prisma.agentToken.findUnique({ where: { keyHash } });
    if (existing) { skipped++; continue; }
    if (DRY) { console.log(`WOULD create "Original" for ${a.handle}`); created++; continue; }
    await prisma.agentToken.create({
      data: { accountId: a.id, keyHash, name: "Original", runtimeType: "other", createdAt: a.createdAt },
    });
    created++;
  }
  console.log(`${DRY ? "[DRY-RUN] " : ""}created=${created} skipped(already had token)=${skipped}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
