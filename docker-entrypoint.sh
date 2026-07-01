#!/bin/sh
set -e

COMMAND="${1:-app}"

case "$COMMAND" in
  app)
    echo "[entrypoint] Running database migrations..."
    node node_modules/prisma/build/index.js db push --skip-generate
    echo "[entrypoint] Starting Next.js app..."
    exec node server.js
    ;;
  ws)
    echo "[entrypoint] Starting SSH WebSocket server..."
    exec node ws-server.js
    ;;
  migrate)
    echo "[entrypoint] Running database migrations only..."
    exec node node_modules/prisma/build/index.js db push --skip-generate
    ;;
  *)
    exec "$@"
    ;;
esac
