import http from 'node:http';
import { config } from './config.js';
import { applyCors, HttpError, Router, sendError, sendJson } from './http.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerSyncRoutes } from './routes/sync.js';
import { serveStatic } from './static.js';
import { store } from './store.js';
import { getProvider, listVoices } from './tts/index.js';
import { hub } from './ws.js';

export function buildRouter(): Router {
  const router = new Router();

  router.get('/api/health', (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      documents: store.listDocuments().length,
      voices: listVoices().length,
      ttsProvider: getProvider().id,
      connections: hub.connectionCount,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  registerIngestRoutes(router);
  registerDocumentRoutes(router);
  registerAudioRoutes(router);
  registerSyncRoutes(router);
  return router;
}

export function createServer(): http.Server {
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (await router.handle(req, res)) return;

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname.startsWith('/api/')) {
        throw new HttpError(404, `no route for ${req.method} ${pathname}`);
      }
      if (req.method === 'GET' && (await serveStatic(pathname, res))) return;

      throw new HttpError(404, `not found: ${pathname}`);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, err);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/sync/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });

  return server;
}

async function main(): Promise<void> {
  await store.init();
  getProvider();

  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`[api] listening on http://${config.host}:${config.port}`);
    console.log(`[api] data directory: ${config.dataDir}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[api] ${signal} received, shutting down`);
    hub.close();
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only start a server when run directly, so tests can import buildRouter.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('[api] failed to start:', err);
    process.exit(1);
  });
}
