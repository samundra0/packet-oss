#!/bin/bash
# Database backup & restore for Packet.ai
#
# Backup:  sudo bash scripts/backup-db.sh backup [staging|prod]
# Restore: sudo bash scripts/backup-db.sh restore <file>
#          sudo bash scripts/backup-db.sh restore latest [staging|prod]
# List:    sudo bash scripts/backup-db.sh list [staging|prod]

set -euo pipefail

CMD="${1:-backup}"
DB="packetdb"
BACKUP_DIR="/opt/backups"

mkdir -p "$BACKUP_DIR"

case "$CMD" in

  backup)
    ENV="${2:-staging}"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    BACKUP_FILE="${BACKUP_DIR}/${DB}-${ENV}-${TIMESTAMP}.sql.gz"

    echo "[Backup] ${ENV} → ${BACKUP_FILE}"
    mysqldump --single-transaction --routines --triggers --quick "$DB" | gzip > "$BACKUP_FILE"

    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "[Backup] Done (${SIZE})"

    # Keep last 10
    KEPT=0
    for f in $(ls -t "${BACKUP_DIR}/${DB}-${ENV}-"*.sql.gz 2>/dev/null); do
      KEPT=$((KEPT + 1))
      [ "$KEPT" -gt 10 ] && echo "[Backup] Cleaning: $(basename "$f")" && rm -f "$f"
    done
    ;;

  restore)
    # Resolve file
    if [ "${2:-}" = "latest" ]; then
      ENV="${3:-staging}"
      FILE=$(ls -t "${BACKUP_DIR}/${DB}-${ENV}-"*.sql.gz 2>/dev/null | head -1)
      [ -z "$FILE" ] && echo "[Restore] No backups for ${ENV}" && exit 1
    else
      FILE="${2:-}"
    fi

    [ -z "$FILE" ] || [ ! -f "$FILE" ] && echo "Usage: $0 restore <file|latest> [env]" && exit 1

    echo "[Restore] ${FILE} ($(du -h "$FILE" | cut -f1))"
    echo ""
    echo "  WARNING: This will replace ALL data in ${DB}."
    read -p "  Type 'yes' to proceed: " CONFIRM
    [ "$CONFIRM" != "yes" ] && echo "Aborted." && exit 0

    command -v pm2 &>/dev/null && pm2 stop all 2>/dev/null || true
    echo "[Restore] Restoring..."
    gunzip -c "$FILE" | mysql "$DB"
    command -v pm2 &>/dev/null && pm2 restart all 2>/dev/null || true
    echo "[Restore] Done."
    ;;

  list)
    ENV="${2:-}"
    if [ -n "$ENV" ]; then
      ls -lht "${BACKUP_DIR}/${DB}-${ENV}-"*.sql.gz 2>/dev/null || echo "No backups for ${ENV}"
    else
      ls -lht "${BACKUP_DIR}/${DB}-"*.sql.gz 2>/dev/null || echo "No backups found"
    fi
    ;;

  *)
    echo "Usage: $0 {backup|restore|list} [args]"
    exit 1
    ;;
esac
