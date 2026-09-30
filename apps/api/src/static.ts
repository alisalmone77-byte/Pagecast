import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { config } from './config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/**
 * Serve the built web client.
 *
 * Unknown paths fall back to index.html so client-side routes survive a reload,
 * but only when they do not look like an asset request -- a missing .js should
 * be a 404, not an HTML page the browser then fails to parse as a module.
 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const root = config.webDir;

  const relative = pathname.replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(root, relative);
  // Refuse anything that escapes the web root.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;

  let file = resolved;
  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await fs.stat(file).catch(() => null);
  }

  if (!stat?.isFile()) {
    if (path.extname(relative) !== '') return false;
    file = path.join(root, 'index.html');
    stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return false;
  }

  const ext = path.extname(file).toLowerCase();
  const isHashed = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i.test(path.basename(file));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(await fs.readFile(file));
  return true;
}
