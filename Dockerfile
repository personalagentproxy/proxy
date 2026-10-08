# One image for all of Personal Agent Proxy: the api, serving the web app's build on the same
# origin, and the database migrations it runs before starting. See
# packages/docs/content/self-hosting.

# Builds the web app, with only its own dependencies. Static files are the same on every platform,
# so this runs on the builder's own, not emulated.
FROM --platform=$BUILDPLATFORM oven/bun:1-slim AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --filter web
RUN bun run --cwd packages/web build

# Only the api's production dependencies, which include the Prisma CLI for the migrations. Every
# workspace's package.json is copied so the lockfile still matches.
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Prisma's engines need OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/docs/package.json packages/docs/
COPY packages/integrations/package.json packages/integrations/
COPY packages/ui/package.json packages/ui/
COPY packages/utils/package.json packages/utils/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile --production --filter '@proxy/api'
# The root's postinstall, which generates the Prisma client, does not run for a filtered install.
RUN bun --bun packages/db/node_modules/.bin/prisma generate --schema packages/db/prisma/schema.prisma

COPY packages/api/src packages/api/src
COPY packages/api/tsconfig.json packages/api/
COPY packages/db/src packages/db/src
COPY packages/integrations/src packages/integrations/src
COPY packages/utils/src packages/utils/src
COPY --from=build /app/packages/web/dist packages/web/dist
COPY docker-entrypoint.sh ./

ENV NODE_ENV=production
ENV PORT=4000
# The version telemetry reports, which the image workflow passes in. Last, so a new one leaves the
# layers above cached.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
EXPOSE 4000
USER bun

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
	CMD ["bun", "-e", "const r = await fetch('http://localhost:' + process.env.PORT + '/health'); process.exit(r.ok ? 0 : 1)"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "packages/api/src/index.ts"]
