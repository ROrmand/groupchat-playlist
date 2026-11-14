import { createServer, type Server } from 'node:http';

export function createApi(checkDatabase: () => Promise<void>): Server {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      await checkDatabase();
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ status: 'unavailable' }));
    }
  });
}
