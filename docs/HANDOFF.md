# 작업 인계 — 2026-10-07 UTC

오늘 작업을 종료합니다. 사용자가 실제 Windows PIN으로 패스키 로그인 후 관리자 화면 진입을 확인했습니다. 무료 테스트 환경만 배포했고 main 병합, 유료 전환, 운영 데이터 변경은 하지 않았습니다. 내일은 2026-10-08에 아래 절차로 재개합니다.

## 브랜치와 최신 커밋

- 현재 브랜치: `feat/workers-passkey-free-preview`
- 오늘 최종 코드 커밋: `6a5a24258836d0cb80d8eccba9e996b0d22ba47d` — `fix: preserve passkey identity and complete free preview login`
- 저장소: https://github.com/hoon426865-svg/-1
- 이 인계 문서는 위 코드 커밋 다음에 별도 커밋합니다. 문서 자체의 커밋 ID는 자기 참조할 수 없으므로 최신 인계 커밋과 원격 일치는 아래 명령으로 확인합니다. 두 커밋은 같은 브랜치에 함께 push합니다.

```bash
cd /workspaces/-1
git status --short --branch
git log -2 --oneline
git rev-parse HEAD origin/feat/workers-passkey-free-preview
```

## 오늘 완료한 작업

- Cloudflare 연결 및 Billing Read 토큰 유효성과 구독 조회 권한을 확인했습니다. 확인 시 유료 Workers/D1 구독이 없었으며 결제·유료 전환은 하지 않았습니다. 입력 스크립트는 일반 터미널의 숨김 입력만 허용하고 토큰을 `private/`의 600 파일로 저장합니다.
- 기존 SQLite와 분리한 가상 계정 테스트 D1에 배포했습니다. 테스트 주소: https://onwork-preview-20261007-01.hoon426865.workers.dev
- 테스트 Worker/D1 이름: `onwork-preview-20261007-01`; D1 ID: `6cf3c747-3708-4f6a-8961-ab4ad9c41686`.
- 최신 Worker 버전: `7172d631-8576-49c4-896b-b88b792062e0`. production 설정은 점검 모드이며 운영 배포·자동 배포는 활성화하지 않았습니다.
- PIN 이후 화면 정지에 대해 요청 시간 제한, 실패 단계 안내, 세션·상태 조회와 화면 전환을 수정했습니다. 등록 후 다시 로그인할 수 있도록 성공 안내와 계정 입력을 정리했습니다.
- 등록·로그인의 credential ID를 동일한 바이트 기준 base64url로 정규화하고 id/rawId 일치를 검사합니다. 로그인 계정별 allowCredentials와 challenge 계정 결합으로 다른 resident credential 선택을 방지했습니다. 서명·UV·Origin·RP·카운터 검증은 유지합니다.
- 요청 확인 번호, 단계·오류 코드와 credential ID 해시·일치 여부만 기록하는 제한된 진단을 추가했습니다. 토큰·등록권·원시 ID·개인정보·쿠키 값·본문은 기록하지 않습니다. 이전 사용자 확인 번호의 과거 로그는 관측 권한 부족으로 확보하지 못했으므로 실제 이전 요청 ID 비교를 완료했다고 주장하지 않습니다.
- 기존 등록 패스키를 임의 삭제하지 않았습니다. 기존 키를 사용한 최신 배포 Chromium 로그인·세션·새로고침 검사와 사용자의 실제 Windows PIN 관리자 로그인이 성공했습니다.

## 검증 결과와 제한

- 전체 로컬 검증: Node 54개 + Workers 19개 = 73개 성공. 최종 진단 해시 최적화 후 관련 회귀 검사와 Workers 번들 빌드도 성공했습니다.
- 실제 HTTPS 기능 검사: 129개 요청, 14회 패스키 로그인; 출퇴근·생산·신청 승인·월간/연간 보고·직원 발급·복구·권한·로그아웃 확인. 이 초기 보고서는 최신 인증 코드의 CPU 판정에 재사용할 수 없습니다.
- 실제 Chromium 회귀 검사 9개 성공. 물리 인증기는 사용자가 Windows PIN으로 관리자 화면 진입을 확인했습니다.
- 오늘 push의 GitHub CI 결과는 재개 시 확인합니다. 로컬 통과와 GitHub 저장 성공은 CI 성공을 의미하지 않습니다.

## 안전 백업

백업 디렉터리: `/workspaces/-1/backups/handoff-20261007T092442Z` (700). 모든 백업과 manifest 파일은 600이며 Git 제외를 확인했습니다. 이전 백업도 보존했습니다. 이 백업은 현재 작업공간의 로컬 파일이므로 작업공간 삭제에 대비한 별도 보관은 아직 하지 않았습니다.

| 대상 | 파일 | SHA-256 |
|---|---|---|
| 기존 SQLite | `onwork-original.sqlite` | `26f603ae2440d8d2a2de249283ba2d4a672a311cae84ce85b2e7a6650ec8c6e1` |
| 테스트 D1 원격 export | `onwork-preview.sql` | `dfd70a1771bfc0cedfd0a8e8ff66ef2cfabbf82ab5ba38b9c4412c11140df87a` |
| D1 export의 별도 로컬 복원 | `onwork-preview-offline.sqlite` | `30ef796fa867987b63e1f7790238157cc418ddf5333e5fddff31e9df3e54b69f` |

- 원본: `/workspaces/-1/data/onwork.sqlite`. 읽기 전용 온라인 백업으로 WAL의 커밋을 포함했으며 전체 스키마·모든 테이블 내용이 일치합니다. 백업 전후 원본 DB/WAL 해시도 동일합니다.
- 테스트 D1은 원격 export만 실행했습니다. export 중 D1 조회가 일시 제한될 수 있으며 운영 DB에는 접근하지 않았습니다. export를 새 로컬 DB에만 복원해 `integrity_check=ok`와 외래키 위반 없음 확인. 등록 패스키 6개와 업무·인증 기록을 포함합니다.
- 상세 manifest: `/workspaces/-1/backups/handoff-20261007T092442Z/manifest.json`. SHA-256, 경로, 검증 결과와 D1 테이블 개수를 보관합니다. SQL에는 인증 자료가 포함되므로 채팅·Git·공개 저장소에 복사하지 않습니다.
- 복원 명령은 실행하지 않습니다. 원본 또는 테스트 D1을 덮어쓰지 않습니다. 토큰·등록권·발급키·DB·보고서는 `private/`, `data/`, `backups/`에서 Git 제외됩니다.

## 미완료 CPU 검증과 내일 할 일

1. 현재 브랜치와 원격 HEAD, GitHub CI, 위 백업 파일·해시를 확인합니다. 기존 작업 트리 변경과 백업을 보존합니다. 테스트 주소에서 ADMIN 계정으로 기존 패스키를 사용합니다. 이미 성공한 Windows 키를 재등록하거나 삭제하지 않습니다.
2. Wrangler 연결이 만료됐을 때만 재인증합니다. 토큰 값은 출력하지 않습니다. Billing Read 권한과 무료 구독은 다시 읽기 전용으로 확인합니다.
3. 전체 과거 invocation 조회는 현재 403입니다. 계정에 한정한 **Workers Observability Write/Edit** 토큰이 필요합니다. 조회 API가 POST이므로 Read만으로 부족하며 Billing Write·유료 전환은 필요하지 않습니다. 일반 터미널에서 `python3 scripts/save-cloudflare-billing-token.py --purpose observability`로 숨겨 저장합니다. `private/cloudflare-observability-token.txt`가 이미 있으면 덮어쓰지 않습니다.
4. 최신 인증 코드 해시와 새 보고서 경로로 HTTPS 기능 검사를 수행하고 CF Ray ID별 invocation CPU를 수집합니다. `scripts/preview-cpu.mjs`의 실제 성공 응답 형식도 확인합니다. 기존 보고서를 덮어쓰거나 초기 코드 보고서를 최신 코드 검증으로 사용하지 않습니다.
5. 로그인 최소 10회와 등록·직원 발급·복구·조회·업무 요청의 모든 표본에 대해 CPU 10ms 이하, 정상 outcome, 누락 없음, 기능 성공을 요구합니다. 일부 실시간 표본(로그인 7ms, 등록 10ms, me 2ms, state 6ms)은 전체 무료 통과 근거가 아닙니다. 최신 코드의 전체 CPU 검증은 **미완료**입니다.
6. 안전한 결과만 문서에 갱신합니다. CPU 미통과·누락 시 원인을 수정하고 재검증하며 보안 강도를 낮추지 않습니다. 별도 사용자 지시 없이 main 병합·운영 이전·운영 배포·자동 배포 변수 활성화·요금제 변경은 하지 않습니다.
