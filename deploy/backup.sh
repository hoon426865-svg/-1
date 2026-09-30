#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
state=${ONWORK_DEPLOY_STATE:-/var/lib/onwork-deploy}
exec 9>"$state/deploy.lock"
flock -w 300 9
release=$(readlink -f "$state/current")
export ONWORK_IMAGE=$(cat "$release/image.txt")
name="scheduled-$(date -u +%Y%m%dT%H%M%S)-$RANDOM.sqlite"
docker compose --project-name "${ONWORK_PROJECT:-onwork}" --env-file "${ONWORK_RUNTIME_ENV:-/etc/onwork/runtime.env}" -f "$release/compose.yaml" \
  run --rm --no-deps -T -e "BACKUP_PATH=/backups/$name" app node scripts/backup.mjs
