import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs','storage.mjs'];
for (const directory of ['lib','public','scripts','tests','worker','tests/worker']) {
  for (const name of readdirSync(directory)) if (/\.(mjs|js)$/.test(name)) files.push(`${directory}/${name}`);
}
for (const file of files) {
  const result = spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if (result.error || result.status !== 0) process.exit(1);
}
console.log(`구문 검사 통과: ${files.length}개 파일`);
