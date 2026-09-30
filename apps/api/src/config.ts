import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('PAGECAST_PORT', '8787')),
  host: env('PAGECAST_HOST', '0.0.0.0'),
  /** Root of all persisted state. Everything under here is disposable. */
  dataDir: path.resolve(env('PAGECAST_DATA_DIR', path.join(here, '..', '..', '..', 'data'))),
  /** Built web client, served at / when present. */
  webDir: path.resolve(env('PAGECAST_WEB_DIR', path.join(here, '..', '..', 'web', 'dist'))),
  /** Largest upload accepted, in bytes. */
  maxUploadBytes: Number(env('PAGECAST_MAX_UPLOAD_BYTES', String(64 * 1024 * 1024))),
  /** Largest page fetched by the URL scraper. */
  maxFetchBytes: Number(env('PAGECAST_MAX_FETCH_BYTES', String(8 * 1024 * 1024))),
  tts: {
    /** 'local' needs no credentials and is the default; 'openai' calls the real API. */
    provider: env('PAGECAST_TTS_PROVIDER', 'local'),
    openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',
    openaiModel: env('PAGECAST_OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    /**
     * Google Cloud Text-to-Speech. The only provider here that reports real
     * word boundaries, so its timelines are measured rather than estimated.
     */
    googleApiKey: process.env['GOOGLE_TTS_API_KEY'] ?? '',
  },
  /** How many chunks are synthesised at once. */
  synthesisConcurrency: Number(env('PAGECAST_SYNTHESIS_CONCURRENCY', '2')),
  auth: {
    /**
     * Whether new accounts can be created. Left on by default because this is
     * a self-hosted reading app and the first thing anyone does is sign up;
     * turn it off once your household has accounts.
     */
    allowRegistration: env('PAGECAST_ALLOW_REGISTRATION', 'true') !== 'false',
    /**
     * When set, registration also requires this code. Useful for a server on a
     * public address that should not be open to the world.
     */
    invitationCode: env('PAGECAST_INVITE_CODE', ''),
    /**
     * Add `Secure` to the session cookie. Must be on behind HTTPS; must be off
     * for a plain-http development server or the browser silently drops the
     * cookie and every request looks signed out.
     */
    secureCookies: env('PAGECAST_SECURE_COOKIES', 'false') === 'true',
  },
} as const;

export const paths = {
  documents: () => path.join(config.dataDir, 'documents'),
  document: (id: string) => path.join(config.dataDir, 'documents', `${id}.json`),
  audioDir: (id: string, voiceId: string) => path.join(config.dataDir, 'audio', id, voiceId),
  audioChunk: (id: string, voiceId: string, index: number, ext: string) =>
    path.join(config.dataDir, 'audio', id, voiceId, `${String(index).padStart(4, '0')}.${ext}`),
  timeline: (id: string, voiceId: string) => path.join(config.dataDir, 'timelines', id, `${voiceId}.json`),
  stateDir: (userId: string) => path.join(config.dataDir, 'state', userId),
  state: (userId: string, documentId: string) =>
    path.join(config.dataDir, 'state', userId, `${documentId}.json`),
  highlights: (userId: string, documentId: string) =>
    path.join(config.dataDir, 'highlights', userId, `${documentId}.json`),
  users: () => path.join(config.dataDir, 'users.json'),
  sessions: () => path.join(config.dataDir, 'sessions.json'),
  folders: (userId: string) => path.join(config.dataDir, 'folders', `${userId}.json`),
};
