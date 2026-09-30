import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { verifyDatabase } from './lib/backup.mjs';
import { dirname, isAbsolute, relative } from 'node:path';

// Validate before opening a writable connection. Production never creates a DB.
export function checkStorage(settings) {
  if (settings.production) {
    if (!settings.databasePath || !isAbsolute(settings.databasePath) || !existsSync(settings.databasePath) || !statSync(settings.databasePath).isFile()) {
      throw Error('기존 운영 DB 파일이 없습니다. 저장소와 DATABASE_PATH를 확인하세요. 빈 DB는 자동 생성하지 않습니다.');
    }
    verifyDatabase(settings.databasePath);
  }
  if (!settings.volumeMountPath) return;
  const mount = settings.volumeMountPath;
  if (!existsSync(mount) || !statSync(mount).isDirectory()) throw Error('영구 저장소 경로가 없습니다. 마운트를 확인하세요.');
  const root = realpathSync(mount);
  let parent = settings.databasePath;
  while (true) {
    try { lstatSync(parent); break; }
    catch(error) { if(error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  const path = relative(root, realpathSync(parent));
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw Error('DB 경로의 심볼릭 링크가 영구 볼륨 밖을 가리킵니다.');
  if (existsSync(settings.databasePath) && !statSync(settings.databasePath).isFile()) throw Error('DATABASE_PATH는 디렉터리가 아닌 DB 파일이어야 합니다.');
}
