import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

export const prisma: PrismaClient = globalThis.__prismaClient ?? new PrismaClient();
// Kept on globalThis in every environment. In development that survives hot reloads; in
// production it lets src/proxy.ts, which Next bundles apart from the app, share this client
// and its connection pool instead of opening a second one.
globalThis.__prismaClient = prisma;
