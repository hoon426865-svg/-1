import { openDatabase } from './lib/db.mjs';
import { config } from './lib/security.mjs';
import { createApplication } from './lib/application.mjs';
import { createHttpServer } from './lib/http.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT는 1~65535 사이의 정수여야 합니다.');
const settings = config({ ...process.env, APP_ORIGIN: process.env.APP_ORIGIN || (process.env.NODE_ENV === 'production' ? undefined : `http://localhost:${port}`) });
const db = openDatabase(settings.databasePath);
const server = createHttpServer(createApplication(db, settings), settings.origin);
server.on('error', error => {
  console.error('서버 실행 실패:', error.code);
  db.close();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`온워크 실행: ${settings.origin} (수신 ${host}:${port})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => { db.close(); process.exitCode = 0; });
  server.closeIdleConnections();
});
