FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install --yes --no-install-recommends openssl=3.0.20-1~deb12u2 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN npm ci

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run build -w @screengoblin/contracts \
 && npm run prisma:generate -w @screengoblin/api \
 && npm run build -w @screengoblin/api

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS production-deps
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN npm ci --omit=dev --ignore-scripts \
 && test -f apps/api/node_modules/@prisma/client/package.json
WORKDIR /app/apps/api
RUN node --input-type=module -e "await import('fastify')"

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      libpcre2-8-0=10.42-1+deb12u1 \
      openssl=3.0.20-1~deb12u2 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd --system --gid 10001 screengoblin \
 && useradd --system --uid 10001 --gid screengoblin --home-dir /app --shell /usr/sbin/nologin screengoblin
COPY --from=build --chown=screengoblin:screengoblin /app/package.json ./package.json
COPY --from=production-deps --chown=screengoblin:screengoblin /app/node_modules ./node_modules
COPY --from=production-deps --chown=screengoblin:screengoblin /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/node_modules/.prisma ./apps/api/node_modules/.prisma
COPY --from=build --chown=screengoblin:screengoblin /app/packages/contracts ./packages/contracts
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=screengoblin:screengoblin /app/apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
RUN node --input-type=module -e "await Promise.all([import('@prisma/client'), import('fastify'), import('@screengoblin/contracts')])" \
 && test -f node_modules/.prisma/client/schema.prisma
WORKDIR /app
USER screengoblin
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
