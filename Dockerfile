# syntax=docker/dockerfile:1

# CI Deck has no runtime dependencies — Bun's own HTTP server, SQLite and bundler
# do all of it — so nothing is installed here. This stage exists to turn `web/`
# into `public/`, and to lay out the data directory with the ownership the
# runtime stage needs.
#
# It is pinned to the *build* platform deliberately: what it produces is
# JavaScript and an empty directory, identical on every architecture, so none of
# the work here is ever emulated when building for the other one.
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build

WORKDIR /app
COPY package.json ./
COPY scripts/ scripts/
COPY src/ src/
COPY web/ web/

RUN bun run build:web && mkdir -p /prepared/data

FROM oven/bun:1.3-alpine

LABEL org.opencontainers.image.source="https://github.com/ivanbaha/ci-deck"
LABEL org.opencontainers.image.description="Watch and control GitLab pipelines for many repos on one page"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# The watch list has to outlive the container. Docker's named volumes inherit the
# ownership baked in here; the entrypoint covers the runtimes and mount types that
# do not.
ENV CI_DECK_DB=/data/ci-deck.db
COPY --from=build --chown=bun:bun /prepared/data /data
VOLUME /data

WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY web/ web/
COPY --from=build /app/public/ public/
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The one command run in this stage, and the only reason building for a foreign
# architecture needs emulation at all. BusyBox has no way to run a program as
# another user without forking, and the server has to be PID 1 to be told to stop.
RUN apk add --no-cache su-exec

# No USER: the entrypoint starts as root only long enough to hand the data
# directory over, then drops to `bun` for good.
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD bun -e "process.exit((await fetch('http://127.0.0.1:8787/api/state')).ok ? 0 : 1)"

# A container's loopback belongs to the container, so a published port would
# reach nothing without this. Publish it on the host's loopback:
#
#   docker run -p 127.0.0.1:8787:8787 -v ci-deck:/data ivbaha/ci-deck
#
# Arguments after the image name are appended to this, and the last --bind wins,
# so it stays overridable without anyone dropping it by accident.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh", "bun", "run", "/app/src/cli.ts", "--bind", "0.0.0.0"]
