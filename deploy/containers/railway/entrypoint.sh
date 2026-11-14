#!/bin/sh
# Railway mounts volumes owned by root, and the server runs as the
# unprivileged node user. Starting as root, give /data to node (once, when it
# is not already node's), then drop root for good before starting the server.
set -eu
if [ "$(id -u)" = 0 ]; then
  if [ "$(stat -c %u /data)" != "$(id -u node)" ]; then
    chown -R node:node /data
  fi
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- "$@"
fi
exec "$@"
