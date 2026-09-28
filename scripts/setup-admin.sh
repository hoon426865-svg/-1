#!/usr/bin/env bash
# Run in a separate process so credentials never remain in the parent shell.
set +x
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export DATABASE_PATH="${DATABASE_PATH:-$PWD/data/onwork.sqlite}"
if [[ ! -t 0 ]]; then
  echo 'Codespaces 터미널에서 bash scripts/setup-admin.sh를 직접 실행하세요.' >&2
  exit 1
fi
trap 'unset ADMIN_LOGIN ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM' EXIT
read -r -p '관리자 계정 (영문·숫자·하이픈): ' ADMIN_LOGIN
read -r -s -p '관리자 비밀번호 (12~128자): ' ADMIN_PASSWORD
printf '\n'
read -r -s -p '관리자 비밀번호 확인: ' ADMIN_PASSWORD_CONFIRM
printf '\n'
if [[ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]]; then
  echo '비밀번호가 일치하지 않습니다. 변경 없이 종료합니다.' >&2
  exit 1
fi
export ADMIN_LOGIN ADMIN_PASSWORD
node scripts/bootstrap.mjs
