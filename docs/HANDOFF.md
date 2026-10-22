# 작업 인계 — 2026-10-22 UTC

CPU 최적화 코드는 수정 후 전용 Worker에 배포됐고 실제 HTTPS 기능 검사가 성공했습니다. **무료 CPU 전체 통과는 아직 아닙니다.** 기존 SQLite·원래 테스트 D1·Windows 패스키를 보존했습니다. 유료 전환, main 병합, 운영 배포는 하지 않았습니다.

## 현재 저장 상태와 실행 제약

- 브랜치: `feat/workers-passkey-free-preview`. 마지막 저장 커밋은 `09a4b25b7c96833645afef28aecc23b633864cd0`입니다. 직전 연결 확인 때 GitHub와 일치했고 해당 CI가 성공했습니다.
- 이번 CPU 최적화·계측 도구·문서 변경은 **작업 트리에만 있고 커밋·push되지 않았습니다.** 사용자는 현재 브랜치 커밋·push 및 무료 테스트 배포를 이미 승인했습니다. 추가 사용자 확인은 필요하지 않습니다.
- 재연결된 실행 환경은 네트워크 제한으로 GitHub/Cloudflare DNS 조회가 실패하고, `.git`은 읽기 전용이라 `git add`도 index.lock 생성 오류로 실패했습니다. 현재 승인 정책은 권한 상승을 허용하지 않습니다. 이 환경 제약 때문에 원격 재검증과 커밋·push를 마무리하지 못했습니다.
- 다음 세션은 먼저 네트워크·Git 쓰기 가능 여부를 확인하고 아래 미완료 단계부터 이어갑니다. 이미 완료한 배포·가상 데이터 import·검사를 무조건 반복하지 않습니다.

## 현재 변경 보존과 일반 터미널 저장

- 추가 최적화보다 현재 변경 보존을 우선합니다. 코드·테스트·문서 12개를 검토해 패치에 포함했습니다. 토큰·등록권·DB·백업·개인정보와 비공개 실행 보고서는 제외합니다.
- 보존 패치: `/workspaces/-1/private/preserve-cpu-20261022-01/cpu-code-and-docs.patch`. 기준 커밋: `09a4b25b7c96833645afef28aecc23b633864cd0`. 새 파일인 실시간 CPU 수집기와 등록권 캐시 테스트도 포함합니다. 파일 목록·SHA-256·복원 검증 결과는 같은 디렉터리의 `manifest.json`에 기록합니다.
- 실행할 저장 명령은 `/workspaces/-1/private/preserve-cpu-20261022-01/save-current-branch.sh`에 있습니다. Codespaces 일반 bash 터미널에서 `bash /workspaces/-1/private/preserve-cpu-20261022-01/save-current-branch.sh`를 실행합니다. 현재 브랜치를 확인하고 검토한 12개 파일만 명시적으로 add/commit한 뒤 동일 브랜치에 push합니다. main 병합이나 배포 명령은 없습니다.
- 저장 성공 후 커밋 ID와 GitHub 브랜치의 ID가 일치하는지 스크립트가 확인합니다. 아직 실행하지 않았으므로 현 인계 문서는 커밋·push 완료를 뜻하지 않습니다. 패치 자체는 `private/`에서 Git 제외되며 현재 작업 트리에 다시 적용할 필요가 없습니다.
- 남은 문제: **CPU 10ms 초과 1건(로그인 옵션 16ms), 측정 누락 29건(129개 중 100개 확보)**. 무료 CPU 전체 통과는 미완료이며, 보존 커밋에 이 한계를 그대로 기록합니다.

## 배포와 데이터 격리

- 사용자가 Windows PIN으로 관리자 화면 진입을 확인한 기존 앱: https://onwork-preview-20261007-01.hoon426865.workers.dev
- 기존 D1: `6cf3c747-3708-4f6a-8961-ab4ad9c41686`. 기존 앱 버전: `7172d631-8576-49c4-896b-b88b792062e0`. 이번 CPU 작업에서 해당 Worker/DB/패스키를 변경하지 않았습니다.
- 최초 CPU 기준 환경: https://onwork-preview-cpu-20261021.hoon426865.workers.dev ; D1 `3f3a375a-7391-4220-8198-f24478908b47`, 버전 `d65648eb-0533-45c4-a168-f4bd9870dc10`.
- 수정 후 환경: https://onwork-preview-cpu-after-20261022.hoon426865.workers.dev ; D1 `33288e1b-a8b4-445f-9f2a-b1c262acd49c`, 버전 `9498fabc-2700-4d0a-bbb0-ee5c953737bd`. 새 가상 DB에만 migration/import를 적용했으며 실제 업무 자료는 보내지 않았습니다.
- 수정 전 동일 방식 재비교용 D1 `385b3f2c-0c61-483e-85b3-9f21f6d1464e`와 로컬 fixture `private/cpu-before-20261022-01/`도 생성됐습니다. 스키마 적용은 마지막 확인에서 Cloudflare 7403 인증 오류로 실패했습니다. Worker 배포는 중단 당시 결과 미확인입니다. 재개 시 원격 상태부터 읽고 기존 리소스를 초기화하지 않습니다.
- Billing Read 및 Observability 쿼리 권한은 직전 실제 연결 때 정상 확인됐고 유료 Workers/D1 구독이 없었습니다. 토큰은 `private/`의 600 파일에서만 읽습니다. 일반 터미널의 숨김 저장 스크립트는 `scripts/save-cloudflare-billing-token.py`입니다.

## 코드 변경과 보안 보존

- 등록 옵션: 서명된 등록권의 계정·복구 시각·사용 여부 조회 3회를 JOIN 1회로 합쳤습니다. 공개 verification key만 재사용하고 등록권 서명과 만료·대상·기존 해시·복구·사용 여부는 매 요청 검증합니다.
- 로그인 검증: revision/challenge/credential+account를 같은 D1 읽기 배치로 조회합니다. 읽기와 쓰기 사이 revision guard 및 원자적 쓰기 배치는 유지합니다. 기존의 D1 왕복 6회를 3회로 줄였습니다.
- 보고서/상태: 각 테이블 조회를 읽기 배치로 합쳤습니다. 페이지 크기, 직원별 권한, 기간 필터, cursor/revision 충돌 검사와 전체 내용은 유지합니다.
- SHA-256은 네이티브 구현을 사용해 비동기 호출·JavaScript 16진 문자열 변환 비용을 줄였습니다. UTF-8 결과가 기존 WebCrypto와 동일함을 검사했습니다. 기존 scrypt N/r/p/출력 길이를 바꾸지 않았습니다.
- ES256 서명, UV, Origin/RP, challenge/계정 결합, userHandle, 카운터, 재사용 방지, 퇴사 계정 차단과 시도 제한은 유지합니다. 인증 성공/실패를 캐시하지 않습니다.
- 수집 도구는 별도 config/source snapshot을 지원합니다. 실시간 tail은 임시 읽기 구독이며 유료 Tail Worker를 배포하지 않습니다. 원시 헤더·쿠키·등록권·본문·로그는 파일에 저장하지 않습니다.
- 재연결 후 추가한 수집 보완: API cursor 페이지 처리, 저장 로그와 동일 실행의 실시간 CPU를 Ray ID로 합치기, 중복 CPU 중 최대값/오류 유지, 실제 성공한 서로 다른 로그인 10회 요구. 누락은 초과와 별도 집계합니다. 이 보완의 단위 검사는 통과했지만 실제 API 재조회는 네트워크 제한으로 미실행입니다.

## 실제 수정 전후 결과

두 실행 모두 같은 기능 시나리오의 **129개 요청·14회 로그인 성공**: 출퇴근, 생산, 신청 승인, 월/연 보고, 직원 발급, 복구, 권한 차단, 로그아웃. 물리 Windows PIN을 새 CPU 환경에서 대신 검사했다고 주장하지 않습니다. 현재 자동 시나리오는 discoverable login 옵션을 사용하므로 UI의 계정 지정 로그인도 다음 CPU 검사에 포함해야 합니다.

| 경로 | 수정 전 최대 CPU | 수정 후 최대 CPU | 확보 표본 수 전/후 |
|---|---:|---:|---:|
| 등록 옵션 | 15ms | 10ms | 4 / 4 |
| 로그인 검증 | 12ms | 7ms | 12 / 13 |
| 월/연 보고 조회 | 13ms | 4ms | 18 / 9 |
| 로그인 옵션 | 5ms | **16ms** | 14 / 14 |

- 수정 전: 저장 로그 116/129개 확보, 누락 13개, 10ms 초과 5개.
- 수정 후: 실시간 로그 100/129개 확보, 누락 29개, 10ms 초과 1개(로그인 옵션 16ms). 받은 100개 프레임은 모두 파싱·필터 통과했고 서로 다른 Ray ID입니다. 스트림 중단은 없었고 임시 tail 구독 삭제도 성공했습니다.
- 개선은 확보된 표본에 대한 결과입니다. 서로 다른 Worker/D1, 계측 소스와 표본 수, 런타임 초기화 조건이므로 엄밀한 동일 조건 전체 성능 보증이 아닙니다. 로그인 옵션 초과와 계측 누락을 해결하고 다시 검증해야 합니다.
- 수정 전 인증 코드 해시: `9024ad9eb724e69a9e46554b441a82beaa1f0cfa29dccad6f5b37d68ec1343f4`.
- 수정 후 인증 코드 해시: `ea988294d0344bcd38415640d673d3ca7fe84aa0b2e3d24bdb3d75e4cab80756`. 재연결 후 현재 Worker 소스와 해당 해시가 일치함을 확인했습니다.

## 계측 누락 조사

- 최초 누락 13건을 넓힌 시간 범위와 개별 Ray ID로 재조회했습니다. 11건은 이벤트가 없고, 로그인 검증 2건은 CPU 없는 앱 로그만 존재했습니다. 응답 count와 반환 이벤트 모두 184로 이 조회에서 페이지 잘림은 확인되지 않았습니다. query ABR 값은 1입니다.
- 따라서 초기 스크립트의 누락/초과 중복 집계와 실제 invocation 부재를 구분했습니다. 저장 로그에서 CPU가 없어지는 Cloudflare 내부 원인은 아직 확정하지 못했습니다. 단순히 권한 부족 또는 인코딩 오류라고 결론 내리지 않습니다.
- 별도 실시간 스트림에서도 129개 중 100개만 도착했습니다. 파서가 29개를 버린 것은 아닙니다. 샘플링/전달 문제는 조사 대상이며 원인이 확인됐다고 단정하지 않습니다. [공식 실시간 로그 제한](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/), [관측 쿼리 API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/).
- 다음에는 새 실행에서 실시간+저장 로그를 함께 확보해 합치고, 남은 Ray별 누락·응답 count·페이지·샘플링 통계를 확인합니다. 누락이 남으면 통과하지 않습니다.

## 검증과 증거 파일

- 중단 전 최적화 코드 전체 회귀 검사: Node 54개 + Workers 20개 = 74개 성공. 이후 공개키 캐시의 잘못된 설정 처리 순서를 보완했고 실제 수정 후 배포에서 HTTPS 기능 검사가 성공했습니다.
- 재연결 후: Workers dry-run 빌드 성공. 새 보안·SHA-256·계측·설정 검사 10개 성공.
- 재연결 후 전체 검사 재시도: Node 54개 중 49개 성공, HTTP listen이 필요한 5개는 sandbox `EPERM 127.0.0.1`로 실패했습니다. 그 뒤 Workers 통합 검사는 실행되지 않았습니다. 최신 전체 검사가 성공했다고 기록하지 않습니다.
- `private/cpu-run-20261021-01/https-results.json`, `cpu-verified-results.json`: 최초 수정 전 기준.
- `private/cpu-after-20261022-01/https-results.json`, `live-cpu-results.json`, `live-cpu-events.json`, `tail-cleanup.json`: 수정 후 실제 실행. 이미 사용된 fixture/DB이므로 동일 업무 검사를 그대로 재실행하지 않습니다.
- `private/cpu-optimization-20261022/missing-investigation.json`, `sampling-investigation.json`: 최초 13건 누락 조사.
- `private/cpu-optimization-20261022/final-verify.log`: 재연결 후 전체 검사 제약 기록. `baseline-code/`에는 수정 전 소스 사본이 있습니다.
- 비공개 증거·토큰·발급키·DB·백업은 Git 제외합니다. 보고서 본문에 개인정보와 등록권 값을 넣지 않습니다.

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


## 재개 순서

1. Git 상태와 네트워크/쓰기 권한을 확인합니다. 현재 변경을 보존하고 전체 회귀 검사를 허용된 일반 개발 환경에서 마무리합니다. 기존 DB 초기화/삭제나 Windows 키 재등록은 필요하지 않습니다.
2. 기존 비교 Worker/D1의 상태를 읽어 미완료 기준 환경 준비를 마칩니다. 성공한 import를 반복하지 않습니다. 기존 앱이 아닌 가상 CPU 환경만 사용합니다.
3. 현재 수정 후 실행의 저장 로그부터 조회합니다: `node scripts/preview-cpu.mjs private/cpu-after-20261022-01 private/cpu-after-20261022-01/wrangler.json`. 새 `cpu-results.json`을 만들고 동일 실행의 실시간 표본과 합칩니다. 이미 결과 파일이 있으면 덮어쓰지 않습니다.
4. 로그인 옵션 16ms 경로의 초기화/DB/난수·옵션 생성 비용을 분석하고, 계정 지정 UI 로그인과 초기 요청을 포함해 최적화합니다. 인증 강도를 낮추거나 다른 Worker로 작업을 쪼개 CPU 제한을 우회하지 않습니다.
5. 새 가상 데이터와 새 보고서 경로에서 수정 전후를 같은 수집 방식으로 비교합니다. 최소 10회 성공 로그인·전체 기능 성공·모든 요청 계측·각 CPU 10ms 이하·정상 outcome일 때만 통과로 기록합니다. 지속 운영 규모와 사용자 장치 범위도 별도로 확인합니다.
6. 결과/한계를 이 문서에 갱신하고 비밀정보 검사를 한 뒤 현재 브랜치에 커밋·push합니다. 사용자가 이미 승인했습니다. main 병합·운영 데이터 변경·유료 전환은 하지 않습니다.
