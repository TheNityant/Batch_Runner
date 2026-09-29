#!/bin/sh
set -eu

# A mounted data volume may be owned by root. Prepare it before dropping
# privileges so run files stay writable by the server.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$BATCHRUNNER_DATA_DIR"
  chown -R node:node "$BATCHRUNNER_DATA_DIR"
  exec su node -s /bin/sh -c 'exec node /app/server.js'
fi

exec node /app/server.js
