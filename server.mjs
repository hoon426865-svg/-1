import { openDatabase } from './lib/db.mjs';
import { config } from './lib/security.mjs';
import { createApplication } from './lib/application.mjs';
import { createHttpServer } from './lib/http.mjs';
import { checkStorage } from './storage.mjs';

const settings = config();
const { port, host } = settings;
checkStorage(settings);
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
