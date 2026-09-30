import http from 'node:http';
import { sessionTokenFrom, toPublicUser } from './auth.js';
import { config } from './config.js';
import { applyCors, HttpError, Router, sendError, sendJson } from './http.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerSyncRoutes } from './routes/sync.js';
import { serveStatic } from './static.js';
import { store } from './store.js';
import { getProvider, listVoices } from './tts/index.js';
import { hub } from './ws.js';

export function buildRouter(): Router {
  const router = new Router();

  // Resolve the session once per request; the router refuses anything that
  // is not a registered public route without one.
  router.setAuthenticator(async (req) => {
    const token = sessionTokenFrom(req);
    if (!token) return null;
    const resolved = await store.resolveSession(token);
    if (!resolved) return null;
    return { user: toPublicUser(resolved.user), session: resolved.session };
  });

  // Public: a monitoring probe should not need credentials, and it reports
  // nothing about anybody's library.
  router.public_('GET', '/api/health', (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      voices: listVoices().length,
      ttsProvider: getProvider().id,
      connections: hub.connectionCount,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  registerAuthRoutes(router);
  registerIngestRoutes(router);
  registerDocumentRoutes(router);
  registerFolderRoutes(router);
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
    // Before anything else, and before the first await below.
    //
    // An upgrade hands over a raw socket with no error handling of its own --
    // unlike a normal request, where the http server keeps one. An unhandled
    // 'error' event on a stream throws, so a client that connects and then
    // resets during the handshake took the whole process down with it. That is
    // a crash anyone on the network can trigger at will.
    socket.on('error', () => socket.destroy());

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/sync/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    // The socket carries another reader's positions, so it is authenticated
    // from the session exactly like an HTTP route -- not from a user id in the
    // query string, which anyone could type.
    void (async () => {
      try {
        const token = sessionTokenFrom(req);
        const resolved = token ? await store.resolveSession(token) : null;
        // The client may well have gone away during that lookup.
        if (socket.destroyed || !socket.writable) {
          socket.destroy();
          return;
        }
        if (!resolved) {
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return;
        }
        hub.handleUpgrade(req, socket, head, resolved.user.id);
      } catch (err) {
        console.warn('[ws] upgrade failed:', err instanceof Error ? err.message : err);
        socket.destroy();
      }
    })();
  });

  // A malformed request line or header. Node hands it over rather than
  // answering, and destroying the socket without a reply would be a silent
  // hang for anything that was merely confused rather than hostile.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
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
