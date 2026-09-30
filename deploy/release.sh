#!/usr/bin/env bash
# Run on the server with the directory containing the CI-verified image bundle.
set -Eeuo pipefail
umask 077
bundle=$(realpath "${1:?Usage: release.sh BUNDLE_DIRECTORY}")
state=${ONWORK_DEPLOY_STATE:-/var/lib/onwork-deploy}
runtime=${ONWORK_RUNTIME_ENV:-/etc/onwork/runtime.env}
mkdir -p "$state/releases"
exec 9>"$state/deploy.lock"
flock -n 9 || { echo 'Another deployment or backup is running.' >&2; exit 1; }
cd "$bundle"
sha=$(cat commit.txt)
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
sha256sum --check checksums.txt
# Config is validated without displaying values or environment contents.
export ONWORK_IMAGE="onwork:$sha"
compose() { docker compose --project-name "${ONWORK_PROJECT:-onwork}" --env-file "$runtime" -f "$1/compose.yaml" "${@:2}"; }
compose "$bundle" config --quiet
docker load --input image.tar > /dev/null
docker image inspect "$ONWORK_IMAGE" > /dev/null
release=$(mktemp -d "$state/releases/$sha.XXXXXXXX")
cp compose.yaml "$release/compose.yaml"
printf '%s\n' "$ONWORK_IMAGE" > "$release/image.txt"
previous=''
if [[ -L "$state/current" ]]; then previous=$(readlink -f "$state/current"); fi
# After stopping writes, any error restarts the old CODE with the SAME database.
# Never restore an old backup automatically: new writes must not be lost.
rollback() {
  rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    compose "$release" stop app || true
    if [[ -n "$previous" ]]; then
      export ONWORK_IMAGE=$(cat "$previous/image.txt")
      if compose "$previous" up -d --wait --wait-timeout 90; then
        echo 'Deployment failed; previous image restarted. Database was not restored.' >&2
      else
        compose "$previous" stop app || true
        echo 'Rollback failed; app stopped. Keep DB and backups; follow recovery instructions.' >&2
      fi
    else
      echo 'First deployment failed; app stopped. Existing DB and backup retained.' >&2
    fi
  fi
  exit "$rc"
}
trap rollback EXIT
if [[ -n "$previous" ]]; then compose "$previous" stop app; fi
# Run backup using the old application when available, before new schema code runs.
backup_release="$release"
new_image="$ONWORK_IMAGE"
if [[ -n "$previous" ]]; then
  backup_release="$previous"
  export ONWORK_IMAGE=$(cat "$previous/image.txt")
fi
backup_name="before-$sha-$(date -u +%Y%m%dT%H%M%S)-$RANDOM.sqlite"
compose "$backup_release" run --rm --no-deps -T -e "BACKUP_PATH=/backups/$backup_name" app node scripts/backup.mjs
export ONWORK_IMAGE="$new_image"
compose "$release" up -d --wait --wait-timeout 90
if [[ -n "$previous" ]]; then
  ln -s "$previous" "$state/previous.next"
  mv -Tf "$state/previous.next" "$state/previous"
fi
ln -s "$release" "$state/current.next"
mv -Tf "$state/current.next" "$state/current"
trap - EXIT
echo "Verified release active: $sha"
