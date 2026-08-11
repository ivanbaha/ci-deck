#!/bin/sh
set -e

# A mounted volume arrives owned by whoever the runtime decided it should be, and
# CI Deck runs unprivileged. Docker hands over a named volume already owned by
# `bun`, because it copies the ownership baked into the image; Apple's `container`
# and a bind-mounted host directory hand over one owned by root, and the board
# then has nowhere to put its database.
#
# So the container starts as root, gives the data directory away, and immediately
# stops being root. `exec` twice over means the server itself is PID 1, running as
# `bun`, and still receives the signal `docker stop` sends.
#
# Only the database and its own directory are touched. `chown -R` here would be a
# loaded gun pointed at whatever someone happened to mount.
if [ "$(id -u)" = '0' ]; then
    dir="$(dirname "${CI_DECK_DB:-/data/ci-deck.db}")"

    chown bun:bun "$dir" 2>/dev/null || true
    for file in "$dir"/ci-deck.db "$dir"/ci-deck.db-wal "$dir"/ci-deck.db-shm; do
        [ -e "$file" ] && chown bun:bun "$file" 2>/dev/null || true
    done

    # `su-exec` execs rather than forking, so the server ends up as PID 1 itself
    # and still gets the signal `docker stop` sends. BusyBox's own `su` would do
    # neither: it cannot pass through an argument that starts with a dash, and
    # `--bind` is one.
    exec su-exec bun "$@"
fi

# Already unprivileged, because someone passed --user: nothing to give away, and
# no way to do it either.
exec "$@"
