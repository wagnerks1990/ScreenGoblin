FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/console/package.json apps/console/tsconfig*.json ./apps/console/
RUN npm ci
COPY packages/contracts ./packages/contracts
COPY apps/console ./apps/console
RUN npm run build -w @screengoblin/contracts && npm run build -w @screengoblin/console

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY deploy/nginx/spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
EXPOSE 8080
