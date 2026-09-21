# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
# better-sqlite3 is a native addon. The slim image ships no toolchain, so the
# build stage installs one; the runtime stage never carries it.
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies. The compiled better-sqlite3 binding survives into the
# runtime stage because both stages are the same base image and architecture.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/chat.sqlite

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

EXPOSE 3000

# Runs as root so it can write to the Fly volume, which mounts root-owned.
CMD ["node", "dist/index.js"]
