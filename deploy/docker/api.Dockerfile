FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN npm ci

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run build -w @screengoblin/contracts \
 && npm run prisma:generate -w @screengoblin/api \
 && npm run build -w @screengoblin/api

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
RUN apt-get update \
 && apt-get upgrade --yes \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd --system --gid 10001 screengoblin \
 && useradd --system --uid 10001 --gid screengoblin --home-dir /app --shell /usr/sbin/nologin screengoblin
COPY --from=build --chown=screengoblin:screengoblin /app/package.json ./package.json
COPY --from=production-deps --chown=screengoblin:screengoblin /app/node_modules ./node_modules
COPY --from=build --chown=screengoblin:screengoblin /app/packages/contracts ./packages/contracts
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/prisma ./apps/api/prisma
USER screengoblin
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
