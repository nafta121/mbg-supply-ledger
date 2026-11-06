/**
 * Cloudflare Worker entrypoint & Durable Object (`MbgSyncHub`) for MBG Supply Chain Ledger.
 *
 * Pillars implemented:
 * 1. Database Latency & Edge Cache:
 *    - Hyperdrive connection pooling (`env.HYPERDRIVE.connectionString`)
 *    - Edge Snapshot Micro-Cache (`caches.default`, 5s TTL) + `ETag` (`If-None-Match` -> `304 Not Modified`)
 *    - Instant cache update/invalidation on `POST /api/hyperdrive`
 * 2. Real-Time Multi-Device Connectivity (`MbgSyncHub` Durable Object):
 *    - WebSocket Hibernation API (`GET /api/ws`) for `< 20ms` edge push notifications
 *    - Durable Object SQLite storage (`sync_state`, `apk_releases`, `documents`)
 * 3. Static Asset Edge Routing:
 *    - Configured with `run_worker_first = ["/api/*"]` in `wrangler.toml` + `env.ASSETS` fallback
 * 4. APK Distribution, Document Storage & Structured Observability:
 *    - `GET/POST /api/apk/version` for internal Android Kotlin APK auto-update checks
 *    - `GET/POST /api/documents` for BAST & transfer proof storage (Durable Object SQLite + optional R2 `MBG_STORAGE`)
 *    - Structured JSON telemetry logged asynchronously via `ctx.waitUntil(...)`
 */
import {
  computeSnapshotEtag,
  executeHyperdriveAction,
  type HyperdriveActionPayload,
  type HyperdriveEnv,
  isHyperdriveConfigured,
  queryMbgDataViaHyperdrive,
} from './lib/hyperdrive';

export interface DurableObjectSqlCursor<T = Record<string, unknown>> extends Iterable<T> {
  toArray(): T[];
}

export interface DurableObjectSqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): DurableObjectSqlCursor<T>;
}

export interface DurableObjectStateLike {
  storage: {
    sql: DurableObjectSqlStorage;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
  getByName?(name: string): DurableObjectStubLike;
}

export interface R2ObjectBodyLike {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface WorkerEnv extends HyperdriveEnv {
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
  MBG_SYNC_HUB?: DurableObjectNamespaceLike;
  MBG_STORAGE?: R2BucketLike;
}

declare const WebSocketPair:
  | {
      new (): { 0: WebSocket; 1: WebSocket };
    }
  | undefined;

const SNAPSHOT_CACHE_PATH = '/api/hyperdrive/__snapshot_v1';
const SNAPSHOT_CACHE_TTL_SECONDS = 5;

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getEdgeCache(): Cache | null {
  const cacheStorage = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return cacheStorage?.default ?? null;
}

function buildSnapshotCacheKey(requestUrl: string): Request {
  const u = new URL(requestUrl);
  u.pathname = SNAPSHOT_CACHE_PATH;
  u.search = '';
  return new Request(u.toString(), { method: 'GET' });
}

function getSyncHubStub(env: WorkerEnv): DurableObjectStubLike | null {
  const ns = env.MBG_SYNC_HUB;
  if (!ns) return null;
  if (typeof ns.getByName === 'function') {
    return ns.getByName('global');
  }
  const id = ns.idFromName('global');
  return ns.get(id);
}

function extractClientIp(request: Request): string {
  return (
    (request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'global')
      .split(',')[0]
      ?.trim() || 'global'
  );
}

function logStructuredEvent(
  ctx: WorkerExecutionContext | undefined,
  event: Record<string, unknown>
): void {
  const writeLog = async () => {
    const payload = {
      service: 'mbg-supply-ledger',
      ts: new Date().toISOString(),
      ...event,
    };
    if (event.level === 'error') {
      console.error(JSON.stringify(payload));
    } else {
      console.log(JSON.stringify(payload));
    }
  };
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(writeLog());
  } else {
    void writeLog();
  }
}

async function broadcastMutationToSyncHub(
  env: WorkerEnv,
  action: string,
  etag: string,
  snapshot?: unknown
): Promise<void> {
  const stub = getSyncHubStub(env);
  if (!stub) return;
  try {
    await stub.fetch('https://mbg-sync-hub.internal/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        etag,
        ...(snapshot && typeof snapshot === 'object' ? { snapshot } : {}),
        updatedAt: new Date().toISOString(),
      }),
    });
  } catch {
    // Non-blocking broadcast best-effort
  }
}

/**
 * Cloudflare Durable Object with SQLite backend & WebSocket Hibernation API.
 * Coordinates sub-20ms multi-device synchronization, APK release manifest, and BAST/proof documents.
 */
export class MbgSyncHub {
  private readonly ctx: DurableObjectStateLike;
  private readonly env: WorkerEnv;

  constructor(ctx: DurableObjectStateLike, env: WorkerEnv) {
    this.ctx = ctx;
    this.env = env;
    void this.ctx.blockConcurrencyWhile(async () => {
      this.initTables();
    });
  }

  private initTables(): void {
    const sql = this.ctx.storage?.sql;
    if (!sql) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        last_action TEXT NOT NULL,
        etag TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apk_releases (
        version_code INTEGER PRIMARY KEY,
        version_name TEXT NOT NULL,
        download_url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        release_notes TEXT NOT NULL,
        mandatory INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        doc_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        data_url TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const nowIso = new Date().toISOString();
    sql.exec(
      `INSERT OR IGNORE INTO sync_state (id, version, last_action, etag, updated_at)
       VALUES ('global', 1, 'init', 'W/"init"', ?)`,
      nowIso
    );
    sql.exec(
      `INSERT OR IGNORE INTO apk_releases (version_code, version_name, download_url, sha256, release_notes, mandatory, published_at)
       VALUES (1, '1.0.0', 'https://mbg.letsgrow.web.id/apk/mbg-ledger-latest.apk', '', 'Rilis awal MBG Supply Chain Ledger (Native Kotlin + Jetpack Compose)', 0, ?)`,
      nowIso
    );
  }

  private getSyncState(): {
    version: number;
    lastAction: string;
    etag: string;
    updatedAt: string;
  } {
    const sql = this.ctx.storage?.sql;
    if (!sql) {
      return {
        version: 1,
        lastAction: 'init',
        etag: 'W/"init"',
        updatedAt: new Date().toISOString(),
      };
    }
    const rows = sql
      .exec<{
        version: number;
        last_action: string;
        etag: string;
        updated_at: string;
      }>(`SELECT version, last_action, etag, updated_at FROM sync_state WHERE id = 'global' LIMIT 1`)
      .toArray();
    const row = rows[0];
    return {
      version: Number(row?.version ?? 1),
      lastAction: String(row?.last_action ?? 'init'),
      etag: String(row?.etag ?? 'W/"init"'),
      updatedAt: String(row?.updated_at ?? new Date().toISOString()),
    };
  }

  private broadcastToSockets(payload: Record<string, unknown>): number {
    const sockets = this.ctx.getWebSockets('mbg-client');
    const serialized = JSON.stringify(payload);
    let sent = 0;
    for (const ws of sockets) {
      try {
        ws.send(serialized);
        sent++;
      } catch {
        try {
          ws.close(1011, 'Send failed');
        } catch {
          // Ignore already closed socket
        }
      }
    }
    return sent;
  }

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('upgrade');

    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      if (typeof WebSocketPair === 'undefined') {
        return jsonResponse({ ok: false, error: 'WebSocketPair runtime tidak tersedia.' }, 501);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['mbg-client']);
      const syncState = this.getSyncState();
      try {
        server.send(
          JSON.stringify({
            type: 'connected',
            ...syncState,
          })
        );
      } catch {
        // Ignore initial send failure
      }
      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit & { webSocket: WebSocket });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        action?: string;
        etag?: string;
        snapshot?: unknown;
        updatedAt?: string;
      };
      const action = String(body.action ?? 'mutation');
      const etag = String(body.etag ?? '');
      const updatedAt = String(body.updatedAt ?? new Date().toISOString());
      const sql = this.ctx.storage?.sql;
      let nextVersion = 1;
      if (sql) {
        sql.exec(
          `UPDATE sync_state
           SET version = version + 1,
               last_action = ?,
               etag = CASE WHEN ? != '' THEN ? ELSE etag END,
               updated_at = ?
           WHERE id = 'global'`,
          action,
          etag,
          etag,
          updatedAt
        );
        nextVersion = this.getSyncState().version;
      }
      const clients = this.broadcastToSockets({
        type: 'mutation',
        version: nextVersion,
        action,
        etag,
        ...(body.snapshot && typeof body.snapshot === 'object' ? { snapshot: body.snapshot } : {}),
        updatedAt,
      });
      return jsonResponse({ ok: true, version: nextVersion, clients });
    }

    if (url.pathname === '/apk' && request.method === 'GET') {
      const sql = this.ctx.storage?.sql;
      const rows = sql
        ? sql
            .exec<{
              version_code: number;
              version_name: string;
              download_url: string;
              sha256: string;
              release_notes: string;
              mandatory: number;
              published_at: string;
            }>(
              `SELECT version_code, version_name, download_url, sha256, release_notes, mandatory, published_at
               FROM apk_releases
               ORDER BY version_code DESC
               LIMIT 1`
            )
            .toArray()
        : [];
      const latest = rows[0];
      const syncState = this.getSyncState();
      return jsonResponse({
        ok: true,
        apk: {
          versionCode: Number(latest?.version_code ?? 1),
          versionName: String(latest?.version_name ?? '1.0.0'),
          downloadUrl: String(
            latest?.download_url ?? 'https://mbg.letsgrow.web.id/apk/mbg-ledger-latest.apk'
          ),
          sha256: String(latest?.sha256 ?? ''),
          releaseNotes: String(latest?.release_notes ?? ''),
          mandatory: Boolean(latest?.mandatory),
          publishedAt: String(latest?.published_at ?? syncState.updatedAt),
        },
        sync: {
          ...syncState,
          connectedClients: this.ctx.getWebSockets('mbg-client').length,
        },
      });
    }

    if (url.pathname === '/apk' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        versionCode?: number;
        versionName?: string;
        downloadUrl?: string;
        sha256?: string;
        releaseNotes?: string;
        mandatory?: boolean;
      };
      const versionCode = Math.max(1, Math.trunc(Number(body.versionCode ?? 1)));
      const versionName = String(body.versionName ?? '').trim() || `1.0.${versionCode}`;
      const downloadUrl =
        String(body.downloadUrl ?? '').trim() ||
        'https://mbg.letsgrow.web.id/apk/mbg-ledger-latest.apk';
      const sha256 = String(body.sha256 ?? '').trim();
      const releaseNotes = String(body.releaseNotes ?? '').trim();
      const mandatory = body.mandatory ? 1 : 0;
      const publishedAt = new Date().toISOString();

      this.ctx.storage?.sql.exec(
        `INSERT INTO apk_releases (version_code, version_name, download_url, sha256, release_notes, mandatory, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(version_code) DO UPDATE SET
           version_name = excluded.version_name,
           download_url = excluded.download_url,
           sha256 = excluded.sha256,
           release_notes = excluded.release_notes,
           mandatory = excluded.mandatory,
           published_at = excluded.published_at`,
        versionCode,
        versionName,
        downloadUrl,
        sha256,
        releaseNotes,
        mandatory,
        publishedAt
      );

      const notified = this.broadcastToSockets({
        type: 'apk_update',
        versionCode,
        versionName,
        downloadUrl,
        mandatory: Boolean(mandatory),
        publishedAt,
      });

      return jsonResponse({
        ok: true,
        versionCode,
        versionName,
        downloadUrl,
        mandatory: Boolean(mandatory),
        publishedAt,
        notified,
      });
    }

    if (url.pathname === '/documents' && request.method === 'GET') {
      const sql = this.ctx.storage?.sql;
      if (!sql) return jsonResponse({ ok: true, documents: [] });
      const id = url.searchParams.get('id')?.trim();
      if (id) {
        const rows = sql
          .exec<{
            id: string;
            doc_type: string;
            ref_id: string;
            file_name: string;
            content_type: string;
            data_url: string;
            size_bytes: number;
            created_at: string;
          }>(
            `SELECT id, doc_type, ref_id, file_name, content_type, data_url, size_bytes, created_at
             FROM documents WHERE id = ? LIMIT 1`,
            id
          )
          .toArray();
        const doc = rows[0];
        if (!doc) return jsonResponse({ ok: false, error: 'Dokumen tidak ditemukan.' }, 404);
        return jsonResponse({ ok: true, document: doc });
      }

      const refId = url.searchParams.get('ref_id')?.trim();
      const rows = refId
        ? sql
            .exec<{
              id: string;
              doc_type: string;
              ref_id: string;
              file_name: string;
              content_type: string;
              size_bytes: number;
              created_at: string;
            }>(
              `SELECT id, doc_type, ref_id, file_name, content_type, size_bytes, created_at
               FROM documents WHERE ref_id = ? ORDER BY created_at DESC LIMIT 100`,
              refId
            )
            .toArray()
        : sql
            .exec<{
              id: string;
              doc_type: string;
              ref_id: string;
              file_name: string;
              content_type: string;
              size_bytes: number;
              created_at: string;
            }>(
              `SELECT id, doc_type, ref_id, file_name, content_type, size_bytes, created_at
               FROM documents ORDER BY created_at DESC LIMIT 100`
            )
            .toArray();
      return jsonResponse({ ok: true, documents: rows });
    }

    if (url.pathname === '/documents' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        id?: string;
        docType?: string;
        refId?: string;
        fileName?: string;
        contentType?: string;
        dataUrl?: string;
      };
      const id = String(body.id ?? '').trim() || `doc-${Date.now()}`;
      const docType = String(body.docType ?? 'BAST').trim();
      const refId = String(body.refId ?? '').trim();
      const fileName = String(body.fileName ?? `${id}.jpg`).trim();
      const contentType = String(body.contentType ?? 'image/jpeg').trim();
      const dataUrl = String(body.dataUrl ?? '').trim();
      if (!refId || !dataUrl) {
        return jsonResponse({ ok: false, error: 'refId dan dataUrl wajib diisi.' }, 400);
      }
      const sizeBytes = dataUrl.length;
      if (sizeBytes > 2 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'Ukuran dokumen melebihi batas 2MB.' }, 413);
      }
      const createdAt = new Date().toISOString();
      this.ctx.storage?.sql.exec(
        `INSERT INTO documents (id, doc_type, ref_id, file_name, content_type, data_url, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           doc_type = excluded.doc_type,
           ref_id = excluded.ref_id,
           file_name = excluded.file_name,
           content_type = excluded.content_type,
           data_url = excluded.data_url,
           size_bytes = excluded.size_bytes,
           created_at = excluded.created_at`,
        id,
        docType,
        refId,
        fileName,
        contentType,
        dataUrl,
        sizeBytes,
        createdAt
      );

      if (this.env.MBG_STORAGE) {
        await this.env.MBG_STORAGE.put(`documents/${id}/${fileName}`, dataUrl, {
          httpMetadata: { contentType },
        }).catch(() => undefined);
      }

      this.broadcastToSockets({
        type: 'document_uploaded',
        id,
        docType,
        refId,
        createdAt,
      });

      return jsonResponse({ ok: true, id, docType, refId, sizeBytes, createdAt });
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text === 'ping' || text.includes('"ping"')) {
      try {
        ws.send(
          JSON.stringify({
            type: 'pong',
            ts: Date.now(),
            ...this.getSyncState(),
          })
        );
      } catch {
        // Ignore closed socket
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code || 1000, reason || 'Client closed');
    } catch {
      // Ignore already closed socket
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Ignore already closed socket
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(request.url);

    // 1. Real-Time Edge WebSocket Synchronization (`/api/ws`)
    if (url.pathname === '/api/ws') {
      const stub = getSyncHubStub(env);
      if (!stub) {
        return jsonResponse({ ok: false, error: 'Durable Object MbgSyncHub belum tersedia.' }, 503);
      }
      return stub.fetch(request);
    }

    // 2. Internal Android APK Auto-Update Manifest (`/api/apk/version`)
    if (url.pathname === '/api/apk/version') {
      const stub = getSyncHubStub(env);
      if (!stub) {
        return jsonResponse({
          ok: true,
          apk: {
            versionCode: 1,
            versionName: '1.0.0',
            downloadUrl: 'https://mbg.letsgrow.web.id/apk/mbg-ledger-latest.apk',
            sha256: '',
            releaseNotes: 'Rilis awal MBG Supply Chain Ledger',
            mandatory: false,
            publishedAt: '2026-10-16T06:00:00.000Z',
          },
        });
      }

      if (request.method === 'GET') {
        return stub.fetch('https://mbg-sync-hub.internal/apk', { method: 'GET' });
      }

      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const pin = String(
          request.headers.get('x-admin-pin') ?? body.adminPin ?? ''
        ).trim();
        if (!pin) {
          return jsonResponse({ ok: false, error: 'PIN Admin wajib diisi.' }, 401);
        }
        const pinCheck = await executeHyperdriveAction(
          {
            action: 'verify_role_pin',
            role: 'OWNER_ADMIN',
            pin,
            clientIp: extractClientIp(request),
          },
          env
        );
        if (!pinCheck.ok) {
          return jsonResponse(
            { ok: false, error: String(pinCheck.error ?? 'PIN Admin tidak valid.') },
            403
          );
        }
        return stub.fetch('https://mbg-sync-hub.internal/apk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    // 3. BAST & Bukti Transfer Document Storage (`/api/documents`)
    if (url.pathname === '/api/documents') {
      const stub = getSyncHubStub(env);
      if (!stub) {
        return jsonResponse({ ok: false, error: 'Storage Durable Object belum tersedia.' }, 503);
      }

      if (request.method === 'GET') {
        const target = new URL('https://mbg-sync-hub.internal/documents');
        target.search = url.search;
        return stub.fetch(target.toString(), { method: 'GET' });
      }

      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const pin = String(
          request.headers.get('x-admin-pin') ?? body.adminPin ?? ''
        ).trim();
        if (!pin) {
          return jsonResponse({ ok: false, error: 'PIN Admin wajib diisi.' }, 401);
        }
        const pinCheck = await executeHyperdriveAction(
          {
            action: 'verify_role_pin',
            role: 'OWNER_ADMIN',
            pin,
            clientIp: extractClientIp(request),
          },
          env
        );
        if (!pinCheck.ok) {
          return jsonResponse(
            { ok: false, error: String(pinCheck.error ?? 'PIN Admin tidak valid.') },
            403
          );
        }
        return stub.fetch('https://mbg-sync-hub.internal/documents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    // 4. Hyperdrive Relational Snapshot & Atomic RPC Endpoint (`/api/hyperdrive`)
    if (url.pathname === '/api/hyperdrive') {
      if (!isHyperdriveConfigured(env)) {
        return jsonResponse({ ok: false, configured: false }, 503);
      }

      const edgeCache = getEdgeCache();
      const cacheKey = buildSnapshotCacheKey(request.url);

      if (request.method === 'GET') {
        const ifNoneMatch = request.headers.get('if-none-match')?.trim();
        const expectedEtag = url.searchParams.get('etag')?.trim() ?? '';
        const bypassCache = url.searchParams.get('fresh') === '1';

        if (edgeCache && !bypassCache) {
          const cachedRes = await edgeCache.match(cacheKey).catch(() => undefined);
          if (cachedRes) {
            const cachedEtag = cachedRes.headers.get('etag') ?? '';
            const isStaleForExpected = Boolean(expectedEtag && cachedEtag !== expectedEtag);
            if (!isStaleForExpected) {
              if (ifNoneMatch && cachedEtag && ifNoneMatch === cachedEtag) {
                logStructuredEvent(ctx, {
                  route: '/api/hyperdrive',
                  method: 'GET',
                  cache: 'HIT-304',
                  durationMs: Date.now() - startMs,
                });
                return new Response(null, {
                  status: 304,
                  headers: {
                    etag: cachedEtag,
                    'cache-control': 'no-cache',
                    'x-mbg-cache': 'HIT-304',
                  },
                });
              }
              const bodyText = await cachedRes.text();
              logStructuredEvent(ctx, {
                route: '/api/hyperdrive',
                method: 'GET',
                cache: 'HIT',
                durationMs: Date.now() - startMs,
              });
              return new Response(bodyText, {
                status: 200,
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-cache',
                  ...(cachedEtag ? { etag: cachedEtag } : {}),
                  'x-mbg-cache': 'HIT',
                },
              });
            }
          }
        }

        try {
          const data = await queryMbgDataViaHyperdrive(env);
          const etag = await computeSnapshotEtag(data);
          const serialized = JSON.stringify({ ok: true, source: 'hyperdrive', etag, data });

          if (edgeCache) {
            const cacheableResponse = new Response(serialized, {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': `public, s-maxage=${SNAPSHOT_CACHE_TTL_SECONDS}`,
                etag,
              },
            });
            if (ctx && typeof ctx.waitUntil === 'function') {
              ctx.waitUntil(edgeCache.put(cacheKey, cacheableResponse).catch(() => undefined));
            } else {
              await edgeCache.put(cacheKey, cacheableResponse).catch(() => undefined);
            }
          }

          if (ifNoneMatch && ifNoneMatch === etag) {
            logStructuredEvent(ctx, {
              route: '/api/hyperdrive',
              method: 'GET',
              cache: 'MISS-304',
              durationMs: Date.now() - startMs,
            });
            return new Response(null, {
              status: 304,
              headers: {
                etag,
                'cache-control': 'no-cache',
                'x-mbg-cache': 'MISS-304',
              },
            });
          }

          logStructuredEvent(ctx, {
            route: '/api/hyperdrive',
            method: 'GET',
            cache: 'MISS',
            durationMs: Date.now() - startMs,
          });
          return new Response(serialized, {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache',
              etag,
              'x-mbg-cache': 'MISS',
            },
          });
        } catch (e) {
          const message =
            e instanceof Error ? e.message : 'Gagal memuat data melalui Cloudflare Hyperdrive.';
          logStructuredEvent(ctx, {
            level: 'error',
            route: '/api/hyperdrive',
            method: 'GET',
            error: message,
            durationMs: Date.now() - startMs,
          });
          return jsonResponse({ ok: false, configured: true, error: message }, 500);
        }
      }

      if (request.method === 'POST') {
        try {
          const payload = (await request.json()) as HyperdriveActionPayload;
          const headerPin = request.headers.get('x-admin-pin')?.trim();
          if (headerPin && !payload.adminPin) {
            payload.adminPin = headerPin;
          }
          payload.clientIp = extractClientIp(request);
          const result = await executeHyperdriveAction(payload, env);

          let nextEtag = '';
          if (result.ok && payload.action !== 'verify_role_pin') {
            if (result.snapshot && typeof result.snapshot === 'object') {
              nextEtag = await computeSnapshotEtag(result.snapshot);
              result.etag = nextEtag;
              if (edgeCache) {
                const serializedSnapshot = JSON.stringify({
                  ok: true,
                  source: 'hyperdrive',
                  etag: nextEtag,
                  data: result.snapshot,
                });
                const warmResponse = new Response(serializedSnapshot, {
                  status: 200,
                  headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': `public, s-maxage=${SNAPSHOT_CACHE_TTL_SECONDS}`,
                    etag: nextEtag,
                  },
                });
                if (ctx && typeof ctx.waitUntil === 'function') {
                  ctx.waitUntil(edgeCache.put(cacheKey, warmResponse).catch(() => undefined));
                } else {
                  await edgeCache.put(cacheKey, warmResponse).catch(() => undefined);
                }
              }
            } else if (edgeCache) {
              if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(edgeCache.delete(cacheKey).catch(() => undefined));
              } else {
                await edgeCache.delete(cacheKey).catch(() => undefined);
              }
            }

            if (ctx && typeof ctx.waitUntil === 'function') {
              ctx.waitUntil(
                broadcastMutationToSyncHub(env, payload.action, nextEtag, result.snapshot)
              );
            } else {
              void broadcastMutationToSyncHub(env, payload.action, nextEtag, result.snapshot);
            }
          }

          logStructuredEvent(ctx, {
            route: '/api/hyperdrive',
            method: 'POST',
            action: payload.action,
            ok: Boolean(result.ok),
            deduplicated: Boolean(result.deduplicated),
            durationMs: Date.now() - startMs,
          });
          return jsonResponse(result, 200, nextEtag ? { etag: nextEtag } : undefined);
        } catch (e) {
          const message =
            e instanceof Error
              ? e.message
              : 'Gagal menjalankan operasi melalui Cloudflare Hyperdrive.';
          logStructuredEvent(ctx, {
            level: 'error',
            route: '/api/hyperdrive',
            method: 'POST',
            error: message,
            durationMs: Date.now() - startMs,
          });
          return jsonResponse({ ok: false, configured: true, error: message }, 400);
        }
      }

      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
