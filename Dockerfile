# syntax = docker/dockerfile:1

FROM oven/bun:1.2.20-slim AS base

LABEL fly_launch_runtime="Bun"

# NodeJS app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV=production


# Dependencies stage for production install
FROM base AS deps
WORKDIR /app
COPY --link package.json bun.lock* ./
ENV NODE_ENV=production
RUN bun install --frozen-lockfile

# Final stage for app image
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy only production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --link . .

EXPOSE 1331
# Start the server by default, this can be overwritten at runtime
CMD [ "bun", "src/index.ts" ]
