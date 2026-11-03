/**
 * Cloudflare Worker entrypoint for MBG Supply Chain Ledger.
 * - Handles `/api/hyperdrive` (GET & POST) using `env.HYPERDRIVE.connectionString`
 *   (Hyperdrive Config ID: b25c4027b55f44c8a219ac965d2f2720).
 * - Delegates all other requests to Cloudflare Workers Static Assets (`env.ASSETS`).
 */
import {
  executeHyperdriveAction,
  type HyperdriveActionPayload,
  type HyperdriveEnv,
  isHyperdriveConfigured,
  queryMbgDataViaHyperdrive,
} from './lib/hyperdrive';

export interface WorkerEnv extends HyperdriveEnv {
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/hyperdrive') {
      if (!isHyperdriveConfigured(env)) {
        return jsonResponse({ ok: false, configured: false }, 503);
      }

      if (request.method === 'GET') {
        try {
          const data = await queryMbgDataViaHyperdrive(env);
          return jsonResponse({ ok: true, source: 'hyperdrive', data }, 200);
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Gagal memuat data melalui Cloudflare Hyperdrive.';
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
          const result = await executeHyperdriveAction(payload, env);
          return jsonResponse(result, 200);
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Gagal menjalankan operasi melalui Cloudflare Hyperdrive.';
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
