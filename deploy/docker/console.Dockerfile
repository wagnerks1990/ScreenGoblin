FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
WORKDIR /app
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/brand/package.json ./packages/brand/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/console/package.json apps/console/tsconfig*.json ./apps/console/
RUN npm ci
COPY packages/brand ./packages/brand
COPY packages/contracts ./packages/contracts
COPY apps/console ./apps/console
RUN npm run build -w @screengoblin/contracts && npm run build -w @screengoblin/console

FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce
COPY deploy/nginx/spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
USER nginx
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
EXPOSE 8080
