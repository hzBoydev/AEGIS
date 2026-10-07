#!/bin/sh
set -e

# Railway mounts the volume root-owned over /app/data; the app runs as `node`.
mkdir -p /app/data
chown node:node /app/data

exec su-exec node "$@"
