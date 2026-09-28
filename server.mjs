import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/domain.js': ['domain.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = createServer(async (req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(500); res.end('파일을 읽을 수 없습니다.'); }
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT는 1~65535 사이의 정수여야 합니다. 기본 포트는 3000입니다.');
  process.exit(1);
}
server.on('error', error => {
  console.error(error);
  if (error.code === 'EPERM' || error.code === 'EACCES') {
    console.error('실행 환경이 포트 열기를 차단했습니다. 포트 사용이 허용된 터미널에서 npm run dev를 실행하세요.');
  } else if (error.code === 'EADDRINUSE') {
    console.error(`${port} 포트가 사용 중입니다. 기존 서버를 종료하거나 PORT=3001 npm run dev로 실행하세요.`);
  }
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`온워크 시제품 실행: http://localhost:${server.address().port} (수신 주소 ${host})`));
