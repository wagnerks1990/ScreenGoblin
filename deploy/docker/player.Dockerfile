FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
ARG VITE_API_URL=https://signage.example.org
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/player/package.json apps/player/tsconfig*.json ./apps/player/
RUN npm ci
COPY packages/contracts ./packages/contracts
COPY apps/player ./apps/player
RUN npm run build -w @screengoblin/contracts && npm run build -w @screengoblin/player

FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce
COPY deploy/nginx/spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/player/dist /usr/share/nginx/html
USER nginx
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
EXPOSE 8080
