import test from 'node:test';
import {fixture} from './helpers.mjs';
import {runResetScenario,runResetConflictScenario} from './test-data-reset-scenarios.mjs';
test('Node 선택 초기화: 권한·연결 자료·복구 사본·계정 보존',async()=>{const f=fixture();try{await runResetScenario(f);}finally{f.db.close();}});
test('Node 초기화 충돌·만료·원자적 실패·재시도',async()=>{const f=fixture();try{await runResetConflictScenario(f);}finally{f.db.close();}});
