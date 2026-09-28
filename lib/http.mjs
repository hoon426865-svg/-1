import { createServer } from 'node:http';

// Adapt Node HTTP to the same Request/Response handler exercised by API tests.
export function createHttpServer(application, origin) {
  return createServer(async (req, res) => {
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: '요청이 너무 큽니다.' }));
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const request = new Request(new URL(req.url, origin), {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await application(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '요청 처리에 실패했습니다.' }));
    }
  });
}
