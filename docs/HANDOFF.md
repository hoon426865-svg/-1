# 무료 Workers 시범 운영 작업 인계

2026년 10월 1일 UTC 기준입니다. 코드 구현과 자동 테스트는 완료했으며, Cloudflare 계정 연결과 실제 무료 preview 검증은 미완료입니다. main 병합과 운영 배포, 유료 전환 및 결제는 하지 않았습니다. 내일은 2026년 10월 2일 기준으로 아래 순서에서 재개합니다.

## Git 상태

- 현재 작업 브랜치: `feat/workers-passkey-free-preview`
- 인계 작성 기준 마지막 코드 커밋: `21ba08ed39683e5ce056f4928a610ec762a639ef`
- 커밋 제목: `feat: complete passkey employee provisioning and lost-key recovery`
- 해당 코드 커밋은 origin의 동일 브랜치에 푸시되어 있습니다.
- 검토용 [초안 PR #1](https://github.com/hoon426865-svg/-1/pull/1)은 열려 있으며 main에 병합하지 않았습니다.
- 인계 작성 전 작업 트리는 깨끗했습니다. 남은 코드 변경은 없으며 이번 저장 대상은 이 인계 문서입니다.
- 이 문서를 저장한 최종 커밋과 원격 동기화 여부는 아래 명령으로 확인합니다. 문서 작성 기준 코드 커밋과 인계 문서 커밋은 다릅니다.

```bash
git branch --show-current
git log -1 --oneline
git status --short
git rev-list --count '@{upstream}..HEAD'
```

## 완료한 기능

- Workers Fetch API와 정적 Assets를 사용하도록 기존 Node 앱의 주요 기능을 D1에 연결했습니다. 기존 Node 앱과 SQLite는 보존했습니다.
- 직원/관리자 권한, Origin 및 CSRF 검사, 출퇴근, 생산량, 근무 변경 신청·승인·반려·재검토·불변 이력, 월간·연간 조회를 구현했습니다. D1 변경은 revision 검사와 원자적 batch를 사용합니다. 페이지 조회와 요청당 SQL 제한을 적용했습니다.
- 로그인은 ES256 패스키와 사용자 확인(UV) 필수 검증을 사용합니다. 기존 계정 ID·권한·scrypt 해시를 보존하며, 최초 이전 때만 신뢰하는 로컬 환경에서 기존 비밀번호를 같은 scrypt 강도로 검증해 일회용 등록권을 발급합니다.
- 신규 직원 발급과 분실 패스키 복구는 관리자 패스키 재인증을 요구합니다. 재인증은 작업 내용에 결합되고 90초 동안 한 번만 유효합니다. 등록권은 15분 동안 한 번만 유효하며 서버에는 해시만 보관합니다.
- 분실 복구는 직원 본인 확인과 사유 입력 후 수행하며 기존 패스키·세션·등록권을 원자적으로 폐기합니다. 기존 직원 ID·비밀번호 해시·업무 기록은 보존합니다. 관리자가 패스키를 전부 분실하면 기존 관리자 비밀번호를 로컬 검증해 재등록합니다.
- SQLite 읽기 전용 스냅샷, 전체 데이터 내용 비교, D1 이전 검증 도구를 준비했습니다. 신선한 이전 DB에 예기치 않은 인증 자료가 있으면 검증을 거부합니다.
- 테스트/운영 DB 분리, 가상 preview DB 생성, 실제 HTTPS 업무 검사, CF Ray ID에 대응하는 Cloudflare 요청별 CPU 수집 도구를 준비했습니다. 원격 API 형식과 권한은 실제 연결 후 확인해야 합니다.
- GitHub CI 성공 후 자동 배포할 설정을 마련했습니다. 실제 무료 CPU, 무료 구독, DB 이전, 인증 코드 해시 검증이 모두 충족되어야 운영 배포를 허용합니다. 지금은 운영 배포를 활성화하지 않았습니다.

## 테스트 결과

- `npm run verify`: Node 회귀 검사 54개, workerd/D1 검사 17개 모두 통과했습니다.
- Workers dry-run 빌드와 59개 JavaScript 파일의 구문 검사를 통과했습니다.
- 검사에는 패스키 서명·UV·Origin·계정 연결·재사용·만료·퇴사·횟수 제한, 관리자 재인증·직원 발급·분실 복구·부분 변경 방지, CSRF·권한, 업무/집계, SQLite 원본 및 WAL 보존을 포함합니다.
- 가상 preview fixture 생성 도구를 별도의 비공개 경로에서 확인했습니다. 원본 DB를 이용하지 않았습니다.
- [마지막 코드 커밋의 GitHub CI](https://github.com/hoon426865-svg/-1/actions/runs/36844227168): `Tests and Workers bundle` 성공, `deploy` 건너뜀.
- 종전 로컬 프로세스 CPU는 로그인 검증 10회 평균 약 9ms, 최대 20ms였습니다. 이 값은 로컬 D1 작업을 포함한 10ms 단위 측정이며 마지막 추가 기능의 실제 Cloudflare CPU 결과가 아닙니다. 무료 운영 통과로 해석하지 않습니다.
- 이번 인계 작업은 코드 변경이 없어 전체 기능 검사를 반복하지 않았습니다. 실제 DB 백업 검증과 문서·Git 제외 대상 검사를 수행했습니다.

## DB 백업과 보존

- 원본: `data/onwork.sqlite`. 원본과 기존 WAL/SHM 및 이전 백업은 보존합니다.
- 이번 백업: `backups/onwork-handoff-20261001T094451Z.sqlite`
- 기존 `npm run backup`과 `scripts/backup.mjs` / `lib/backup.mjs`를 사용했습니다. 새 경로를 독점 생성하는 기능을 사용했으며, 하위 프로세스 권한 오류 후 이미 생성된 백업을 검증해 재사용했습니다. 덮어쓰기나 중복 생성을 하지 않았습니다.
- 검증: SQLite `integrity_check=ok`, 외래키 위반 없음, 스키마 버전 1, 원본과 모든 테이블 스키마·내용 일치. 커밋된 WAL 기록도 포함합니다. 원본 DB/WAL은 검증 중 변경되지 않았습니다.
- 백업 파일 크기: 176128바이트. 파일 권한: `0600`.
- 백업 SHA-256: `a8cce971b17afbc0f093de10129ed8580d593b0ae54c60c07186fe810e5f30ba`
- 원본 DB, 백업, 가상 테스트 DB, 키와 등록권은 Git에서 제외합니다. 이번 백업은 이 작업 공간에만 저장했으며 GitHub나 외부 저장소에 업로드하지 않았습니다.
- 자동 복구를 실행하지 않습니다. 복구가 필요하면 기존 복구 기능의 새 대상 경로 규칙을 따르고 현재 DB를 덮어쓰지 않습니다.

## 미완료와 미확인

- Cloudflare CLI 인증이 마지막 확인에서 미완료였습니다. 기기 인증 요청이 승인 없이 만료된 적이 있으므로 재개할 때 연결 상태를 다시 확인하고 필요하면 새 인증을 시작합니다.
- 실제 계정 ID, 새 preview D1 ID, 정확한 workers.dev 주소와 preview 공개키 설정을 확정해야 합니다. production 설정은 여전히 미확정이며 점검 모드를 유지합니다.
- 실제 Free 계정의 preview 배포·HTTPS 로그인·주요 업무·신규 직원 발급·분실 복구·요청별 CPU는 아직 검증하지 못했습니다.
- 실제 브라우저/기기의 패스키 등록, 로그인, 관리자 재인증도 미확인입니다. 소프트웨어 인증기로 수행하는 HTTPS 검사는 물리 기기 확인을 대신하지 않습니다.
- 실제 D1 이전·이전 후 원격 export 비교·운영 배포는 하지 않았습니다.
- 관리자 패스키·기존 비밀번호·오프라인 발급 개인키를 모두 분실한 상황을 자동으로 우회하는 기능은 제공하지 않습니다.

## 내일 재개 순서

1. 현재 브랜치와 원격 커밋, 작업 트리를 확인합니다. 새 변경이 있다면 보존하고 먼저 검토합니다. 위 백업의 존재와 무결성을 확인하며 이미 완료된 백업을 이유 없이 다시 생성하지 않습니다.
2. `npx wrangler whoami`로 연결을 확인합니다. 미인증이면 아래 명령을 실행하고 출력된 기기 인증 링크에서 코드를 입력해 5분 안에 승인합니다. 로그인 정보는 문서·Git·채팅에 복사하지 않습니다.

   ```bash
   npx wrangler login --device --browser=false --scopes account:read user:read workers:write workers_scripts:write workers_tail:read d1:write
   ```

3. Cloudflare에서 Workers Free와 D1 Free 상태를 확인합니다. 필요한 조회 권한이 없으면 해당 계정에 한정된 읽기 권한으로 확인합니다. 유료 전환이나 결제는 진행하지 않습니다.
4. **새 테스트용 preview D1만** 준비하고 정확한 preview workers.dev 주소를 설정합니다. 기존 DB를 삭제하거나 production 리소스를 변경하지 않습니다. `wrangler.jsonc`의 preview를 채우고 production과 격리됐는지 검사합니다.
5. [무료 운영 절차](cloudflare-free.md)의 원격 검증 절차를 따릅니다. `scripts/preview-fixture.mjs`로 사용하지 않은 `private/` 경로에 가상 계정만 만들고 공개키만 preview에 설정합니다. 가상 DB의 스키마와 import 번들만 새 preview D1에 적용합니다. 원본 직원 자료는 preview에 보내지 않습니다.
6. preview만 배포합니다. `scripts/preview-check.mjs`로 실제 HTTPS 로그인과 출퇴근·생산량·신청 승인·월간/연간 조회·계정 발급·복구를 확인합니다. 실제 브라우저의 패스키 흐름도 별도로 확인합니다.
7. `scripts/preview-cpu.mjs`와 Cloudflare 계측으로 요청별 CPU를 확인합니다. 모든 요청의 실제 계측, 기능 검사 성공, 반복 로그인, 요청당 10ms 이하와 정상 invocation을 요구합니다. 로그 누락·권한 부족·CPU 초과는 미확인 또는 실패로 기록하고 보안 강도를 낮추지 않습니다.
8. 결과만 비밀정보 없이 문서에 갱신하고 현재 작업 브랜치에 저장합니다. **main 병합과 운영 배포는 별도 사용자 지시 전까지 하지 않습니다.** production 이전과 자동 배포 변수 활성화도 아직 진행하지 않습니다.
