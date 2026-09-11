FROM node:22.19.0-bookworm-slim AS build
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

FROM nginxinc/nginx-unprivileged:1.29-alpine
USER root
RUN apk upgrade --no-cache
USER 101
COPY deploy/nginx/spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/player/dist /usr/share/nginx/html
EXPOSE 8080
