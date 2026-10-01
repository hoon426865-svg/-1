# Cloudflare 무료 시범 운영과 D1 이전

온워크를 Workers Free와 D1 Free에 연결하고 무료 workers.dev 주소로 운영하는 절차입니다. 기존 SQLite 원본·백업·계정·업무·승인 이력을 보존하며, 테스트 DB와 운영 DB를 분리합니다. 서버 임대·도메인 구매·유료 전환·결제 명령은 포함하지 않습니다.

Workers의 정상 로그인은 **WebAuthn 패스키(ES256, 사용자 확인 UV 필수)**로 변경했습니다. 기존 비밀번호 검증은 Workers 요청에서 실행하지 않습니다. 계정 이전 때만 신뢰하는 로컬 환경에서 기존 scrypt 설정 N 16384, r 8, p 1, 64바이트로 검증하고, 오프라인 발급키로 서명한 일회용 등록권을 사용합니다. 원본 해시·계정 ID·권한·업무 기록은 그대로 보존합니다. 단순 클라이언트 해시나 약한 KDF로 대체하지 않습니다. 공개키만 Worker에 설정하고 발급용 개인키는 배포하지 않습니다.

**실제 무료 preview CPU 검증은 아직 미완료입니다.** 로컬 workerd의 기존 scrypt 검증 평균은 약 42ms였습니다. 패스키 로그인 검증 경로는 쿼리 최적화 후 10회 평균 약 9ms, 최대 20ms였지만 이 값에는 로컬 D1 프로세스 작업이 포함되고 10ms 단위로 측정되어 Cloudflare 요청별 CPU와 같지 않습니다. 패스키 등록 옵션과 등록 검증 1회는 각각 30ms와 10ms로 측정되었습니다. 이 결과로 Free 통과를 선언하지 않습니다. Cloudflare 계정 연결이 완료되지 않아 원격 preview·실물 브라우저 패스키·CPU 제한을 아직 검증하지 못했습니다. 운영 배포와 자동 배포는 계속 차단합니다.

[SimpleWebAuthn 서버 검증 API](https://simplewebauthn.dev/docs/packages/server), [패스키 사용자 확인 설정](https://simplewebauthn.dev/docs/advanced/passkeys).
## 무료 제한과 검증 범위

| 자원 | Free 제한 | 앱의 처리 |
| --- | --- | --- |
| Workers CPU | 요청당 10ms | 인증은 실제 무료 계정 검증 대기 |
| Workers 요청 | 하루 100,000회 | 한도 초과는 중단으로 처리하며 자동 유료 전환하지 않음 |
| Workers 메모리 | 128MB | 정상 로그인은 ES256 검증, scrypt는 로컬 이전에서만 실행 |
| D1 쿼리 | Worker 요청당 50개 | 페이지당 조회 및 원자적 변경을 제한하고 테스트에서 검사 |
| D1 읽기와 쓰기 | 하루 500만 행 읽기, 10만 행 쓰기 | 날짜·직원 인덱스와 200행 페이지 사용. 감사·revision 트리거도 쓰기량에 포함 |
| D1 저장 공간 | DB당 500MB, 계정 전체 5GB | 이전 전 파일 크기와 계정의 다른 DB 사용량 확인 |
| D1 Time Travel | 7일 | 운영 외부 백업을 대체하지 않음 |

[Workers 공식 제한](https://developers.cloudflare.com/workers/platform/limits/), [D1 공식 제한](https://developers.cloudflare.com/d1/platform/limits/), [D1 공식 가격과 무료 할당량](https://developers.cloudflare.com/d1/platform/pricing/).

Workers는 Fetch API와 정적 Assets 바인딩을 사용하며 파일 시스템과 Node HTTP 서버에 의존하지 않습니다. 토큰은 Web Crypto로 생성하고 SHA-256으로 저장합니다. 호환성 검사용 legacy 모드만 기존 scrypt를 사용하며 production에서는 차단합니다. 일반 Node 서버는 이전 확인을 위해 남겨 둡니다. [Cloudflare 암호화 지원](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).

D1 조회는 primary 세션을 사용합니다. 변경은 revision 검사·업무 데이터·감사 또는 승인 이력을 한 D1 batch에 넣습니다. 동시에 변경하면 전체 배치가 취소되어 409를 반환하며, 일부 업무 데이터나 승인 이력만 저장하지 않습니다. 조회 페이지 사이에 변경되면 전체 조회를 실패시켜 서로 다른 시점의 데이터를 합치지 않습니다. 월간·연간 집계와 상세 내역은 브라우저에서 전체 페이지를 모아 기존 계산 방식으로 표시합니다. [D1 배치와 세션](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Cloudflare 계정 연결 클릭 순서

1. [Cloudflare 대시보드](https://dash.cloudflare.com/)에서 로그인하거나 무료 계정을 만들고 이메일 인증을 완료합니다.
2. 계정을 선택하고 **Workers & Pages**로 이동합니다. Workers 요금제가 **Free**인지 확인합니다. Upgrade나 결제 정보 입력은 진행하지 않습니다.
3. Workers 설정에서 무료 **workers.dev 하위 도메인**을 지정합니다. 실제 주소는 `https://onwork-preview.선택한하위도메인.workers.dev`와 `https://onwork.선택한하위도메인.workers.dev`가 됩니다.
4. **Storage & databases → D1 → Create database**에서 테스트용 `onwork-preview`와 운영용 `onwork-production`을 각각 생성합니다. Database ID를 기록합니다. 이름이 이미 있다면 기존 DB를 삭제하거나 재사용하지 말고 새 이름을 선택합니다.
5. `wrangler.jsonc`의 preview·production Database ID와 APP_ORIGIN을 실제 값으로 바꿉니다. production SITE_ID는 기존 DB의 직원 site_id와 일치해야 합니다. 원본 값이 불명확하면 이전 도구 manifest에 기록된 값을 확인하고, 여러 사업장이 있으면 이전을 중단합니다.
6. Codespaces에서는 `npx wrangler login --device --browser=false --scopes account:read user:read workers:write workers_scripts:write workers_tail:read d1:write`를 실행하고 표시된 링크를 엽니다. 기기 코드를 입력하고 5분 안에 승인합니다. 일반 환경에서는 `npx wrangler login`도 사용할 수 있습니다. Cloudflare에 로그인한 뒤 Wrangler 권한 화면에서 **Allow**를 누릅니다. Codespaces에서는 명령이 출력한 링크를 직접 브라우저에서 엽니다. 다른 Cloudflare 계정으로 연결하지 않도록 계정을 확인합니다. `npx wrangler whoami`로 연결 결과를 확인합니다.

이 작업에서 확인한 현재 CLI 상태는 **미인증**입니다. 계정 연결·DB 생성·workers.dev 주소 확인은 아직 실행하지 않았습니다. 토큰과 비밀번호를 채팅이나 Git에 붙이지 않습니다.

## 로컬 테스트와 무료 preview 검증

로컬 DB는 `.wrangler/` 아래에 저장되고 Git에서 제외됩니다. 테스트는 Miniflare의 별도 임시 D1을 사용하며 원본 SQLite와 원격 DB에 접속하지 않습니다. Wrangler와 동일한 workerd 버전을 고정했습니다.

```bash
npm ci
npm run verify
npm run worker:passkey-benchmark
# 로컬 D1에만 스키마 적용
npx wrangler d1 migrations apply onwork-local --local
npm run worker:dev
```

로컬 미리보기의 요청 주소는 HTTP localhost이므로, 배포용 HTTPS workers.dev Origin 강제 검사를 그대로 사용하는 기본 설정에서는 403입니다. 로컬 API 기능 검증에는 `npm run test:worker`를 사용하세요. 브라우저 조작은 아래 별도 원격 preview로 확인합니다.

실제 무료 계정을 확인하고 설정 파일을 채운 뒤 **preview DB에만** 적용합니다.

```bash
node scripts/cloudflare-config.mjs preview
npx wrangler d1 migrations apply onwork-preview --env preview --remote
npm run worker:assets
npx wrangler deploy --env preview
```

preview에는 실제 직원 자료 없이 별도 가상 계정 DB를 만듭니다. 기존 Node 앱에서 가상 관리자·직원 두 명·작업 종류를 만들고 이 가상 SQLite만 이전 도구로 preview에 가져옵니다. 운영 SQLite를 preview로 복사하지 않습니다. `/setup`과 비밀번호 로그인은 패스키 모드에서 제공하지 않습니다.

### 기존 계정의 패스키 등록

신뢰하는 로컬 컴퓨터에서 발급키를 한 번 생성합니다. preview와 production은 서로 다른 키를 사용하세요. 아래 파일은 Git에서 제외되며 기존 파일을 덮어쓰지 않습니다.

```bash
node scripts/sign-enrollment.mjs --generate private/preview-issuer.pem
```

`private/preview-issuer.pem.public.json`의 공개 JWK만 preview의 `ENROLLMENT_PUBLIC_KEY` 변수에 설정합니다. 개인키는 접근 제한된 로컬 환경에 보관하고 채팅·GitHub·CI·Worker에 보내지 않습니다. 발급키를 가진 사람은 계정을 등록할 수 있으므로 관리자와 같은 권한으로 보호합니다.

각 사용자가 신뢰하는 로컬 환경에서 자신의 기존 비밀번호를 숨김 입력합니다. `SOURCE_DB`는 preview에서는 가상 DB, 실제 이전에서는 보존된 원본입니다.

```bash
python3 scripts/passkey-enrollment.py --source "$SOURCE_DB" --login "$LOGIN" \
  --origin "$PREVIEW_ORIGIN" --key private/preview-issuer.pem \
  --out private/unused-enrollment-ticket.txt
```

비밀번호를 정확히 검증해야 15분짜리 계정·기존 해시·정확한 HTTPS 주소에 결합된 등록권을 새 파일로 생성합니다. 틀린 비밀번호는 발급하지 않습니다. 파일 내용을 해당 사용자의 로그인 화면 **기존 계정 패스키 등록**에 붙여 넣고 브라우저의 지문·얼굴·기기 PIN 또는 보안키 확인을 완료합니다. 등록권은 URL·로그·localStorage에 넣지 않으며 한 번만 사용할 수 있습니다. UV를 지원하지 않는 인증기는 허용하지 않습니다. 등록 후 기존 세션은 폐기하며 패스키로 다시 로그인합니다. 기기 PIN은 서버에 보내지 않습니다.

RP ID를 정확한 Worker 호스트로 묶으므로 preview 패스키를 production에 사용할 수 없습니다. 운영 주소를 변경하면 다시 등록해야 합니다. 등록권 발급을 기존 비밀번호 입력 없이 사용자에게 맡기지 않습니다. 패스키 분실 시에도 동일한 검증 후 재등록이 필요합니다. 비밀번호까지 분실한 사용자의 본인 확인·계정 복구와 Workers의 신규 직원 발급 UI는 아직 구현하지 않았습니다. 현재 Workers에서는 직원 정보 수정·비활성화·재활성화는 유지하지만 신규 직원 생성·비밀번호 변경·비밀번호 재설정은 409로 차단합니다. 보존된 Node 앱의 해당 기능은 유지되지만, 운영 전환 전 별도 안전한 계정 발급/복구 절차를 구현하고 검증해야 합니다.

### 실제 무료 계정에서의 통과 조건

가상 관리자·직원을 패스키 등록하고 로그인 → 출근·퇴근 → 생산량 → 신청·승인·반려·재검토 → 월간·연간 조회 → 로그아웃·재로그인을 브라우저에서 확인합니다. 잘못된 서명·UV 누락·다른 Origin·등록권 재사용도 거부되어야 합니다.

Cloudflare **Workers & Pages → onwork-preview → Metrics**의 CPU 시간과 invocation 오류를 확인합니다. 요청별 계측이 제공되면 **Logs**에서도 확인합니다. 등록·로그인·권한 조회·업무 변경·월간·연간 조회 각각을 반복해 CPU 10ms 예산과 `exceededCpu` 또는 Error 1102 여부를 확인하고, 측정 시각·코드 인증 해시·샘플 수·CPU 분포·오류 수를 기록합니다. 단일 성공이나 일시적인 여유 CPU로 통과 판정을 내리지 않습니다. 테스트 비밀번호·등록권·세션·CSRF·본문을 로그에 출력하지 않습니다. [공식 CPU 계측 안내](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

무료 CPU 확인이 실패하면 production 전환을 중단합니다. UV·서명·기존 scrypt 강도를 낮추거나 유료 플랜으로 넘어가지 않습니다.

## SQLite 원본 보존과 D1 이전

무료 preview 검증 성공 후에만 이 절차를 시작합니다. 이전 도중 기존 앱의 업무 입력을 중단하고 점검 모드로 전환합니다. production Worker도 `MAINTENANCE_MODE=1`로 둡니다. 이전이 끝날 때까지 두 앱에서 동시에 입력받지 않습니다.

기존 백업을 반복 생성하거나 덮어쓰지 않습니다. 이 절차는 **현재 원본을 온라인 백업 API로 새 스냅샷에 고정**하므로 WAL의 최신 커밋도 포함합니다. 원본은 read-only로 열고 새 이름의 디렉터리를 독점 생성합니다. 실패한 디렉터리는 성공 결과로 사용하지 않으며, 재시도에는 다른 새 디렉터리를 사용합니다.

```bash
# SOURCE_DB는 확인한 기존 SQLite 파일 절대 경로로 지정
# BUNDLE은 Git에서 제외되는 exports/ 아래 사용하지 않은 새 경로
python3 scripts/export-sqlite-d1.py --source "$SOURCE_DB" --out "$BUNDLE"
```

출력은 `source-snapshot.sqlite`, `manifest.json`, `import.sql`입니다. 실제 계정 해시와 직원 기록을 포함하므로 0700 디렉터리·0600 파일로 보호하고 저장소나 CI artifact에 올리지 않습니다. snapshot·원본·기존 백업은 모두 보관합니다. 비밀번호 해시를 재작성하거나 기존 계정을 초기화하지 않습니다. 세션·QR 토큰·삭제 확인·로그인 횟수 제한 같은 임시 인증 자료만 이전에서 제외하므로 전환 후 다시 로그인합니다.

비어 있는 **새 production D1**에만 스키마와 데이터를 가져옵니다. 이 절차에서는 DB를 삭제·재생성하지 않습니다. import guard는 대상에 이미 업무 데이터가 있으면 실패하며 INSERT OR REPLACE를 사용하지 않습니다. 원격 파일 import가 중간 실패하면 해당 부분 이전 DB를 서비스하지 말고 보존한 뒤 새 대상 DB로 이전 절차를 다시 검증합니다.

```bash
npx wrangler d1 migrations apply onwork-production --env production --remote
npx wrangler d1 execute onwork-production --env production --remote --file "$BUNDLE/import.sql"
npx wrangler d1 export onwork-production --env production --remote --output "$BUNDLE/d1-before-service.sql"
python3 scripts/verify-d1-import.py \
  --manifest "$BUNDLE/manifest.json" \
  --d1-export "$BUNDLE/d1-before-service.sql" \
  --out "$BUNDLE/verified.sql"
npx wrangler d1 execute onwork-production --env production --remote --file "$BUNDLE/verified.sql"
```

검증은 행 개수뿐 아니라 모든 보존 테이블의 **열과 실제 전체 내용 SHA-256**, 무결성·외래키·schema version·기존 scrypt 해시 형식·revision 트리거·임시 인증 자료 제거를 비교합니다. 검증 실패 시 `verified.sql`을 생성하지 않으며 점검 모드를 유지합니다. 실제 D1 export 명령의 결과는 계정 연결 후 확인해야 합니다. [D1 공식 가져오기와 내보내기](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

일치 확인 후 production의 SITE_ID를 대조하고 MAINTENANCE_MODE를 0으로 변경합니다. 운영 주소에서 실제 관리자·직원 계정의 로그인과 집계, 신청 이력, 월간·연간 내역을 대조한 뒤 새 입력을 허용합니다. 현재 Worker는 이전 검증 표시가 없으면 503을 반환하고 운영 DB의 새 최초 관리자 생성을 거부합니다. 새 입력 이후에는 과거 SQLite로 자동 되돌리지 않습니다. 장애 시 점검 모드로 바꾸고 현재 D1부터 새 백업으로 내보내 데이터 차이를 확인합니다.

## GitHub 연결과 자동 배포

1. Cloudflare **My Profile → API Tokens → Create Token → Create Custom Token**에서 해당 계정에만 `Workers Scripts Edit`, `D1 Edit`, `Account Settings Read`, `Billing Read` 권한을 부여합니다. Billing Write나 계정 전체 관리자 권한은 부여하지 않습니다. 계정의 실제 권한 이름은 대시보드 표시를 따릅니다.
2. GitHub 저장소 **Settings → Environments → New environment**에서 `production`을 만들고 main 배포만 허용합니다.
3. production의 **Environment secrets**에 `CLOUDFLARE_API_TOKEN`, **Environment variables**에 `CLOUDFLARE_ACCOUNT_ID`를 등록합니다. 토큰 원문은 코드·문서·채팅에 넣지 않습니다.
4. 저장소 **Settings → Secrets and variables → Actions → Variables**에 검증 완료 후에만 `FREE_PLAN_CONFIRMED=true`, `FREE_RUNTIME_VERIFIED=true`, `D1_MIGRATION_VERIFIED=true`를 등록합니다. 현재 CPU 확인은 미완료이므로 이 값들은 활성화하지 않습니다.
5. production의 `FREE_AUTH_CODE_SHA256`에 실제 무료 검증을 마친 인증 코드와 의존성의 결합 SHA-256을 등록합니다. 인증 코드가 바뀌면 재검증 전까지 배포를 차단합니다. 해시는 `node scripts/cloudflare-config.mjs --auth-hash`로 확인합니다.
6. 준비 완료 후 저장소 변수 `CLOUDFLARE_DEPLOY_ENABLED=true`를 켭니다. 기존 SSH 배포용 `DEPLOY_ENABLED`는 현재 workflow에서 사용하지 않습니다.
7. main push 또는 **Actions → CI → Run workflow**로 실행합니다. `Tests and Workers bundle` 검사와 `deploy` 작업의 성공을 각각 확인하고, **Workers & Pages → onwork → Deployments**에서 배포 버전과 실제 HTTPS 응답을 대조합니다.

CI는 Node 회귀 검사·workerd/D1 통합 검사·이전 검사·Workers dry-run 빌드가 모두 성공해야 artifact를 만듭니다. 배포는 해당 커밋의 검증된 번들을 재빌드하지 않고 사용하며 main이 더 최신이면 중단합니다. 배포 직전 구독 API를 **GET으로만** 읽어 유료 Workers/D1 구독이 있거나 무료 상태를 확인할 수 없으면 차단합니다. 자동 배포는 D1 이전·초기화·운영 DB 복구를 실행하지 않습니다.

DB 초기 이전과 schema migration은 자동 코드 배포와 분리되어 있습니다. 이후 DB 변경도 별도 백업과 검증 후 추가 방식으로 적용해야 합니다. 기존 테이블·열 삭제 또는 데이터 교체를 자동 workflow에 넣지 않습니다. D1 원격 백업·복원과 GitHub 변수·토큰·branch rule 설정은 아직 실행하지 않았습니다.

## 현재 완료 상태

완료: Workers Fetch와 Assets 코드, UV 필수 패스키 등록·로그인, 기존 scrypt 해시 보존과 로컬 비밀번호 검증 이전 도구, 권한·CSRF 검사, D1 원자적 업무 저장, 페이지 조회, SQLite 이전·검증 도구, 별도 테스트 DB 구성, 기본 비활성 GitHub 자동 배포 설정.

미확인: 실제 Free CPU·무료 할당량·HTTPS 브라우저/기기 동작, 원격 D1 이전·실제 운영 배포, 변경 코드의 GitHub CI.

막힘: 기기 인증 코드 만료로 Cloudflare CLI 미연결, 실제 계정 ID·D1 ID·workers.dev 주소 미확정. 신규 직원 발급과 비밀번호 분실 계정 복구는 추가 구현·검증 전까지 Workers에서 차단되어 운영 전환 조건을 충족하지 못합니다.
