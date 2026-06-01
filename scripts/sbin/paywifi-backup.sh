#!/bin/bash
# PAYWIFI — Off-host database backup script
# Configured: 2026-05-24
# Runs nightly at 02:15 via /etc/cron.d/paywifi-backup
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DB="/var/lib/paywifi/paywifi.db"
LOCAL_DIR="/var/backups/paywifi"
DATE=$(date +%F)
BACKUP_FILE="${LOCAL_DIR}/paywifi-${DATE}.db"
LOG="/var/log/paywifi/backup.log"
KEEP_DAYS=30

# ── 1. Local SQLite backup ─────────────────────────────────────────────────
mkdir -p "${LOCAL_DIR}"
sqlite3 "${DB}" ".backup '${BACKUP_FILE}'"
chmod 600 "${BACKUP_FILE}"
echo "[$(date -Iseconds)] Local backup: ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))" >> "${LOG}"

# ── 2. Verify backup integrity ─────────────────────────────────────────────
if sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;" 2>&1 | grep -q "^ok$"; then
    echo "[$(date -Iseconds)] Integrity check: PASSED" >> "${LOG}"
else
    echo "[$(date -Iseconds)] ERROR: Integrity check FAILED on ${BACKUP_FILE}" >> "${LOG}"
    exit 1
fi

# ── 3. Prune old local backups ─────────────────────────────────────────────
find "${LOCAL_DIR}" -name "paywifi-*.db" -mtime +${KEEP_DAYS} -delete
echo "[$(date -Iseconds)] Pruned backups older than ${KEEP_DAYS} days" >> "${LOG}"

# ── 4. Off-host backup (configure one of the options below) ───────────────
# OPTION A: rsync to NAS
# Uncomment and set NAS_HOST, NAS_PATH, and configure SSH key auth for root.
#
# NAS_HOST="192.168.1.100"
# NAS_PATH="/mnt/nas/paywifi-backups/"
# rsync -az --no-perms "${BACKUP_FILE}" "root@${NAS_HOST}:${NAS_PATH}" \
#     && echo "[$(date -Iseconds)] rsync to NAS: OK" >> "${LOG}" \
#     || echo "[$(date -Iseconds)] ERROR: rsync to NAS failed" >> "${LOG}"

# OPTION B: rclone to S3/Backblaze/R2
# Install rclone: apt install -y rclone
# Configure: rclone config (creates /root/.config/rclone/rclone.conf)
# Set RCLONE_REMOTE to your remote:bucket path.
#
# RCLONE_REMOTE="s3:paywifi-backups"
# rclone copy "${BACKUP_FILE}" "${RCLONE_REMOTE}/" --quiet \
#     && echo "[$(date -Iseconds)] rclone to ${RCLONE_REMOTE}: OK" >> "${LOG}" \
#     || echo "[$(date -Iseconds)] ERROR: rclone failed" >> "${LOG}"

# ── 5. Health check ping (optional) ───────────────────────────────────────
# Ping a healthcheck endpoint (healthchecks.io, UptimeRobot, etc.)
# HC_URL="https://hc-ping.com/YOUR-UUID-HERE"
# curl -fsS --retry 3 "${HC_URL}" >/dev/null 2>&1 || true

echo "[$(date -Iseconds)] Backup complete." >> "${LOG}"
