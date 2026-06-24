// One-off: reserve handles for Skylar pre-launch. Idempotent — skips any handle that
// already exists (real or reserved). Run from apps/broker with DATABASE_URL -> proxy.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const HANDLES = [
  // personal
  "skylar", "skyflyt", "spearce", "pearce", "sky", "s",
  // family
  "beka", "brekan", "aspyn",
  // brand / system / functional
  "admin", "support", "help", "info", "hello", "team", "staff", "backchannel", "bc", "noreply", "mod", "system",
  // publisher
  "loby", "vulnops",
  // short / high-value
  "1", "2", "3", "me", "you",
];

async function main() {
  const owner = await prisma.account.findFirst({ where: { handle: { startsWith: "skyflyt86" } } });
  if (!owner) { console.error("admin account skyflyt86@bc not found"); process.exit(1); }
  console.log(`Owner (reservedBy): ${owner.handle} ${owner.id}\nReserving ${HANDLES.length} handles…\n`);

  const reserved = [], existed = [];
  for (const local of HANDLES) {
    const handle = `${local}@bc`;
    const cur = await prisma.account.findUnique({ where: { handle } });
    if (cur) {
      existed.push({ handle, kind: cur.reserved ? "already reserved" : cur.emailVerifiedAt ? "real (verified) account" : "real (pending) account" });
      continue;
    }
    await prisma.account.create({
      data: {
        handle,
        email: `${local}+reserved@back-channel.app`,
        displayName: "Reserved",
        reserved: true,
        reservedBy: owner.id,
        // apiKey null, emailVerifiedAt null → cannot authenticate; only holds the handle
      },
    });
    reserved.push(handle);
  }

  console.log(`✅ Reserved (${reserved.length}): ${reserved.join(", ") || "(none)"}\n`);
  console.log(`↩️  Already existed (${existed.length}):`);
  for (const e of existed) console.log(`   ${e.handle} — ${e.kind}`);
  console.log(`\nTotal processed: ${HANDLES.length} · reserved ${reserved.length} · skipped ${existed.length}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
