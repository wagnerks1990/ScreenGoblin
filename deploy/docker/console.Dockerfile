FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
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
# Install the exact Alpine security fixes; preserve the immutable base and non-root runtime.
USER root
RUN apk add --no-cache libexpat=2.8.5-r0 pcre2=10.49-r0 tiff=4.7.2-r0 libpng=1.6.59-r0 nghttp2-libs=1.70.0-r0 zlib=1.3.2-r1
COPY deploy/nginx/spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
USER nginx
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
EXPOSE 8080
