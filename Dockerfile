# syntax = docker/dockerfile:1

FROM oven/bun:1.2.20-slim AS base

LABEL fly_launch_runtime="Bun"

# App lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV=production


# 1) Install production deps
FROM base AS deps
WORKDIR /app
COPY --link package.json bun.lock* ./
ENV NODE_ENV=production
RUN bun install --frozen-lockfile

# 2) Build the server bundle
FROM base AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --link . .
RUN bun run build

# 3) Final runtime image with only what we need
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime artifacts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --link package.json ./package.json

EXPOSE 1331
# Start the bundled server (faster cold start)
CMD [ "bun", "run", "dist/index.js" ]
