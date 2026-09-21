# syntax=docker/dockerfile:1

# The output is architecture-independent, so this stage always runs natively.
FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS build

WORKDIR /app
COPY package.json ./
COPY scripts/ scripts/
COPY src/ src/
COPY web/ web/

RUN bun run build:web && mkdir -p /prepared/data

FROM oven/bun:1.4-alpine

LABEL org.opencontainers.image.source="https://github.com/ivanbaha/ci-deck"
LABEL org.opencontainers.image.description="Watch and control GitLab pipelines for many repos on one page"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Named volumes inherit this ownership; the entrypoint covers bind mounts.
ENV CI_DECK_DB=/data/ci-deck.db
COPY --from=build --chown=bun:bun /prepared/data /data
VOLUME /data

WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY web/ web/
COPY --from=build /app/public/ public/
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Patch Alpine, add su-exec (drops privileges without forking), then remove apk,
# which takes OpenSSL with it; Bun has its own TLS. The CA bundle is named so it
# survives the removal.
RUN apk upgrade --no-cache \
    && apk add --no-cache su-exec ca-certificates-bundle \
    && apk del apk-tools

# No USER: the entrypoint hands /data over as root, then drops to bun.
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD bun -e "process.exit((await fetch('http://127.0.0.1:8787/api/state')).ok ? 0 : 1)"

# 0.0.0.0 so a published port reaches the server; publish it on 127.0.0.1.
# A --bind passed after the image name overrides this one.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh", "bun", "run", "/app/src/cli.ts", "--bind", "0.0.0.0"]
