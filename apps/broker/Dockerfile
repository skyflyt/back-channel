# syntax=docker/dockerfile:1.7

# ─── Stage 1: build ────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY apps/broker/package.json apps/broker/package-lock.json* ./
RUN npm ci

COPY apps/broker/ ./
COPY skill/ /skill/

# Generate Prisma client + Next.js build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npm run build

# Prune dev deps before copying to runtime
RUN npm prune --omit=dev

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Copy the built app + production deps
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/src ./src
COPY --from=build /app/next.config.mjs ./next.config.mjs

# The skill content (served by /skill route at runtime)
COPY --from=build /skill /skill

EXPOSE 8080
CMD ["node", "server.mjs"]

