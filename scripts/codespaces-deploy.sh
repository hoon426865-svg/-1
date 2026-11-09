#!/usr/bin/env bash
# Run from the existing OnWork Codespace. Never check out/reset its working tree.
set -Eeuo pipefail
umask 077
phase='실행 준비'
run=''
trap 'printf "\n중단: %s (줄 %s). 이후 단계는 실행하지 않았습니다.\n" "$phase" "$LINENO" >&2; if [[ -n "$run" ]]; then printf "검사 자료: %s\n백업과 로그 전체를 채팅이나 Git에 올리지 마세요.\n" "$run" >&2; fi' ERR
if [[ ${CODESPACES:-} != true ]]; then
  printf '기존 온워크 GitHub Codespaces의 터미널에서 실행하세요.\n' >&2
  exit 1
fi
root=$(git rev-parse --show-toplevel)
commit=${1:?검증한 소스의 전체 커밋 ID가 필요합니다.}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
[[ $(git -C "$root" rev-parse "$commit^{commit}") == "$commit" ]]
mkdir -p "$root/private"
exec 9>"$root/private/operations-deploy.lock"
flock -n 9 || { printf '다른 온워크 배포가 진행 중입니다.\n' >&2; exit 1; }
run=$(mktemp -d "$root/private/operations-deploy-XXXXXXXX")
mkdir "$run/source" "$run/logs"
git -C "$root" archive "$commit" | tar -x -C "$run/source"
printf '%s\n' "$commit" > "$run/source-commit.txt"
cd "$run/source"
printf '소스: %s\n검사·백업 폴더: %s\n' "$commit" "$run"

phase='Node.js 24 준비'
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
  nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ ! -f "$nvm_script" && -f /usr/local/share/nvm/nvm.sh ]]; then nvm_script=/usr/local/share/nvm/nvm.sh; fi
  if [[ ! -f "$nvm_script" ]]; then
    printf 'Node.js 24 이상이 필요합니다. Codespaces에서 Node.js 24를 설치한 뒤 다시 실행하세요.\n' >&2
    exit 1
  fi
  # NVM is the existing Codespaces Node version manager.
  source "$nvm_script"
  nvm install 24 > "$run/logs/node-install.log" 2>&1
  nvm use 24 > "$run/logs/node-use.log" 2>&1
fi
command -v python3 >/dev/null
export WRANGLER_SEND_METRICS=false
export ONWORK_DEPLOY_COMMIT="$commit"
export ONWORK_DEPLOY_DIR="$run"
if [[ -z ${CLOUDFLARE_BILLING_TOKEN_FILE:-} && -f "$root/private/cloudflare-billing-token.txt" ]]; then
  export CLOUDFLARE_BILLING_TOKEN_FILE="$root/private/cloudflare-billing-token.txt"
elif [[ -n ${CLOUDFLARE_BILLING_TOKEN_FILE:-} && "$CLOUDFLARE_BILLING_TOKEN_FILE" != /* ]]; then
  export CLOUDFLARE_BILLING_TOKEN_FILE="$root/$CLOUDFLARE_BILLING_TOKEN_FILE"
fi
phase='의존성 설치'
printf '\n1/6 의존성을 설치합니다.\n'
npm ci > "$run/logs/npm-ci.log" 2>&1
phase='회귀 검사 및 빌드'
printf '2/6 기존 기능과 새 기능을 검사합니다. 몇 분 걸릴 수 있습니다.\n'
npm run verify > "$run/logs/verify.log" 2>&1
python3 -m unittest discover -s tests -p 'test_operations_upgrade.py' > "$run/logs/upgrade-tests.log" 2>&1

phase='Cloudflare 인증'
printf '3/6 Cloudflare 연결을 확인합니다.\n'
if ! ./node_modules/.bin/wrangler whoami > "$run/logs/whoami.log" 2>&1 || ! rg -q 'e4ff9b8a159d8def553c7eda4c09cdb3' "$run/logs/whoami.log"; then
  printf '아래 공식 인증 주소를 열고 표시된 코드를 승인해 주세요.\n'
  ./node_modules/.bin/wrangler login --device --browser=false --scopes account:read user:read workers:write workers_scripts:write d1:write
fi
phase='백업·DB 검사·배포'
node scripts/deploy-operations.mjs
printf '\n완료: 기존 주소에 코드 반영 및 공개 접속 검사를 마쳤습니다.\n'
printf '관리자 로그인 후 설정 → 준비된 품목 목록 가져오기에서 비공개 품목 JSON을 선택하세요.\n'
printf '실제 관리자 로그인·담당자 권한·무료 CPU 한도 확인은 별도로 남아 있습니다.\n'
