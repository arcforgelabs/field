FROM node:24.22.1-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /app/shared
COPY client/ ./
RUN npm run build

FROM node:24.22.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

FROM node:24.22.1-bookworm-slim AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --no-audit --no-fund
COPY server/db ./server/db
RUN npm run db:build
RUN npm prune --omit=dev --no-audit --no-fund

FROM runtime
WORKDIR /app
ENV NODE_ENV=production
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"
ENV FIELD_REVISION="${VCS_REF}"
# The release tag a release image is (Field Release Publish sets it), or empty.
ARG FIELD_RELEASE=""
ENV FIELD_RELEASE="${FIELD_RELEASE}"
COPY --from=server-deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=server-deps /app/server/db/dist ./server/db/dist
COPY shared ./shared
COPY quote-catalogs ./quote-catalogs
COPY scripts/demo-fixtures.js ./scripts/demo-fixtures.js
COPY scripts/reset-staging-baseline.js ./scripts/reset-staging-baseline.js
COPY scripts/export-quote-proof-bundle.js ./scripts/export-quote-proof-bundle.js
COPY scripts/verification ./scripts/verification
COPY --from=client-build /app/client/dist ./client/dist
RUN groupadd --gid 10001 field-verification \
  && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin field-verification \
  && mkdir -p /app/data \
  && chown -R root:root /app \
  && find /app -type d -exec chmod 0555 {} + \
  && find /app -type f -exec chmod 0444 {} + \
  && chown 10001:10001 /app/data \
  && chmod 0750 /app/data
USER 10001:10001
EXPOSE 19200
CMD ["node", "server/index.js"]
