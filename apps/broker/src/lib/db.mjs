import { PrismaClient } from "@prisma/client";

/** @type {PrismaClient} */
export const prisma = globalThis.__prismaClient ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__prismaClient = prisma;
