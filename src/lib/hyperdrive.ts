/**
 * Cloudflare Hyperdrive PostgreSQL integration for MBG Supply Chain Ledger.
 * Reference: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-js/
 *
 * Connects to Supabase PostgreSQL via Cloudflare Hyperdrive (`env.HYPERDRIVE.connectionString`)
 * using `postgres` (postgres.js) with `max: 5` and `fetch_types: false` as recommended by
 * Cloudflare Hyperdrive documentation to minimize connection setup latency in Workers/Edge.
 */
import postgres, { type Sql } from 'postgres';
import type { BeneficiaryType, Item, Kitchen } from '../types/mbg';
import { roundKg } from './financial-engine';
import type { CreateOrderInput, MbgData, UpdateOrderInput } from './order-engine';
import {
  type AppSettingsRow,
  fromSupabaseRows,
  type KitchenInvoiceRow,
  type KitchenOrderItemRow,
  type KitchenOrderRow,
  type KitchenRow,
  type ProductRow,
  type ProfitLedgerRow,
  type ProfitPayoutBatchRow,
} from './supabase-sync';

export interface HyperdriveBinding {
  connectionString: string;
}

export interface HyperdriveEnv {
  HYPERDRIVE?: HyperdriveBinding;
  HYPERDRIVE_CONNECTION_STRING?: string;
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE?: string;
  DATABASE_URL?: string;
}

const PLACEHOLDER_LOCAL_CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * Resolves the active Cloudflare Hyperdrive connection string from:
 * 1. Explicit Cloudflare Worker `env.HYPERDRIVE.connectionString` binding
 * 2. Global Cloudflare context (`globalThis.__env__.HYPERDRIVE.connectionString`)
 * 3. Server environment variables (`HYPERDRIVE_CONNECTION_STRING`,
 *    `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, or `DATABASE_URL`)
 */
export function resolveHyperdriveConnectionString(env?: HyperdriveEnv): string | null {
  const globalEnv = (globalThis as unknown as { __env__?: HyperdriveEnv }).__env__;
  const candidates = [
    env?.HYPERDRIVE?.connectionString,
    globalEnv?.HYPERDRIVE?.connectionString,
    env?.HYPERDRIVE_CONNECTION_STRING,
    env?.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    env?.DATABASE_URL,
    typeof process !== 'undefined' ? process.env.HYPERDRIVE_CONNECTION_STRING : undefined,
    typeof process !== 'undefined'
      ? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
      : undefined,
    typeof process !== 'undefined' ? process.env.DATABASE_URL : undefined,
  ];

  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (
      trimmed &&
      (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) &&
      !trimmed.includes('[YOUR-DB-PASSWORD]') &&
      trimmed !== PLACEHOLDER_LOCAL_CONN
    ) {
      return trimmed;
    }
  }
  return null;
}

export function isHyperdriveConfigured(env?: HyperdriveEnv): boolean {
  return resolveHyperdriveConnectionString(env) !== null;
}

/**
 * Creates a request-scoped `postgres.js` client configured for Cloudflare Hyperdrive:
 * - `max: 1` (single socket per request to stay well within Cloudflare Workers connection limits)
 * - `fetch_types: false` (avoids an extra round-trip on connection initialization)
 * - `prepare: true` (enables Hyperdrive prepared statement caching)
 */
export function createHyperdriveSql(connectionString: string): Sql {
  return postgres(connectionString, {
    max: 1,
    fetch_types: false,
    prepare: true,
    idle_timeout: 5,
    connect_timeout: 10,
  });
}

export async function withHyperdriveSql<T>(
  fn: (sql: Sql) => Promise<T>,
  env?: HyperdriveEnv,
  sqlFactory: (connStr: string) => Sql = createHyperdriveSql
): Promise<T> {
  const connStr = resolveHyperdriveConnectionString(env);
  if (!connStr) {
    throw new Error('HYPERDRIVE_NOT_CONFIGURED');
  }
  const sql = sqlFactory(connStr);
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/**
 * Queries all relational tables in a single SQL round-trip over an existing Hyperdrive `sql` socket
 * and maps them to `MbgData`. Never selects `admin_pin` or `coop_pin` from `public.app_settings`.
 */
export async function fetchMbgSnapshotFromSql(sql: Sql): Promise<MbgData> {
  const rows = await sql<
    Array<{
      kitchens: KitchenRow[];
      products: ProductRow[];
      orders: KitchenOrderRow[];
      orderItems: KitchenOrderItemRow[];
      invoices: KitchenInvoiceRow[];
      ledgerEntries: ProfitLedgerRow[];
      appSettings: AppSettingsRow[];
      payoutBatches: ProfitPayoutBatchRow[];
    }>
  >`
    WITH recent_orders AS (
      SELECT * FROM public.kitchen_orders ORDER BY created_at DESC LIMIT 2000
    )
    SELECT
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.kitchens ORDER BY code ASC) t), '[]'::json) AS kitchens,
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.products ORDER BY code ASC) t), '[]'::json) AS products,
      COALESCE((SELECT json_agg(t) FROM recent_orders t), '[]'::json) AS orders,
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.kitchen_order_items WHERE order_id IN (SELECT id FROM recent_orders) ORDER BY created_at DESC) t), '[]'::json) AS "orderItems",
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.kitchen_invoices WHERE order_id IN (SELECT id FROM recent_orders) ORDER BY created_at DESC) t), '[]'::json) AS invoices,
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.profit_ledger_entries WHERE order_id IN (SELECT id FROM recent_orders) ORDER BY created_at DESC) t), '[]'::json) AS "ledgerEntries",
      COALESCE((SELECT json_agg(to_jsonb(s) - 'admin_pin' - 'coop_pin') FROM public.app_settings s WHERE s.id = 'default'), '[]'::json) AS "appSettings",
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.profit_payout_batches ORDER BY disbursed_at DESC LIMIT 1000) t), '[]'::json) AS "payoutBatches"
  `;
  const row = rows[0];
  return fromSupabaseRows({
    kitchens: row?.kitchens ?? [],
    products: row?.products ?? [],
    orders: row?.orders ?? [],
    orderItems: row?.orderItems ?? [],
    invoices: row?.invoices ?? [],
    ledgerEntries: row?.ledgerEntries ?? [],
    splitConfigs: [],
    appSettings: row?.appSettings ?? [],
    payoutBatches: row?.payoutBatches ?? [],
  });
}

export async function queryMbgDataViaHyperdrive(
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<MbgData> {
  return withHyperdriveSql((sql) => fetchMbgSnapshotFromSql(sql), env, sqlFactory);
}

export type HyperdriveActionCore =
  | { action: 'upsert_order'; input: CreateOrderInput & { notes?: string | null }; orderDate: string }
  | { action: 'update_order'; input: UpdateOrderInput }
  | { action: 'mark_invoice_paid'; invoiceId: string }
  | { action: 'execute_payout'; target: BeneficiaryType | 'BOTH'; entryIds?: string[] | null }
  | {
      action: 'update_app_settings';
      params: {
        teamSharePct: number;
        coopSharePct: number;
        supplierName?: string | null;
        bankName?: string | null;
        accountNumber?: string | null;
        accountHolder?: string | null;
      };
    }
  | { action: 'delete_order_item'; itemId: string }
  | { action: 'delete_order'; orderId: string }
  | { action: 'upsert_kitchen'; kitchen: Kitchen }
  | { action: 'upsert_product'; item: Item }
  | { action: 'delete_kitchen'; kitchenId: string }
  | { action: 'delete_product'; productId: string }
  | { action: 'verify_role_pin'; role: string; pin: string };

export type HyperdriveActionPayload = HyperdriveActionCore & {
  adminPin?: string;
  includeSnapshot?: boolean;
  clientIp?: string;
};

const ADMIN_PIN_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedAdminPin: { pin: string; expiresAt: number } | null = null;

const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MS = 10 * 60 * 1000;
const MAX_TRACKED_PIN_CLIENTS = 256;
const PIN_LOCKOUT_ERROR = 'Terlalu banyak percobaan PIN salah. Coba lagi dalam 10 menit.';

interface PinFailureEntry {
  count: number;
  resetAt: number;
}

const pinFailuresByClient = new Map<string, PinFailureEntry>();

export function resetHyperdrivePinGuardForTest(): void {
  cachedAdminPin = null;
  pinFailuresByClient.clear();
}

function isAdminPinCached(pin: string): boolean {
  if (!cachedAdminPin || cachedAdminPin.pin !== pin) return false;
  if (Date.now() > cachedAdminPin.expiresAt) {
    cachedAdminPin = null;
    return false;
  }
  return true;
}

function cacheVerifiedAdminPin(pin: string): void {
  cachedAdminPin = { pin, expiresAt: Date.now() + ADMIN_PIN_CACHE_TTL_MS };
}

function isClientPinLocked(clientKey: string): boolean {
  const entry = pinFailuresByClient.get(clientKey);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    pinFailuresByClient.delete(clientKey);
    return false;
  }
  return entry.count >= MAX_PIN_FAILURES;
}

function recordPinFailure(clientKey: string): void {
  const now = Date.now();
  const existing = pinFailuresByClient.get(clientKey);
  const count = existing && now <= existing.resetAt ? existing.count + 1 : 1;
  if (!pinFailuresByClient.has(clientKey) && pinFailuresByClient.size >= MAX_TRACKED_PIN_CLIENTS) {
    const oldestKey = pinFailuresByClient.keys().next().value;
    if (oldestKey !== undefined) {
      pinFailuresByClient.delete(oldestKey);
    }
  }
  pinFailuresByClient.set(clientKey, { count, resetAt: now + PIN_LOCKOUT_MS });
}

/**
 * Executes an RPC or table mutation directly over Cloudflare Hyperdrive.
 * All mutating actions require a valid `adminPin` verified via `rpc_verify_role_pin('OWNER_ADMIN', pin)`.
 * When `payload.includeSnapshot` is true, returns the authoritative `MbgData` snapshot over the same socket
 * so the client never needs a second `GET /api/hyperdrive` round-trip.
 */
export async function executeHyperdriveAction(
  payload: HyperdriveActionPayload,
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<Record<string, unknown>> {
  return withHyperdriveSql(
    async (sql) => {
      const useEdgePinCache = !sqlFactory;
      const clientKey = (payload.clientIp ?? 'global').trim() || 'global';
      if (payload.action !== 'verify_role_pin') {
        const pin = String(payload.adminPin ?? '').trim();
        if (!pin) {
          return { ok: false, error: 'PIN Admin wajib diisi untuk mengubah data.' };
        }
        if (isClientPinLocked(clientKey)) {
          return { ok: false, error: PIN_LOCKOUT_ERROR };
        }
        if (!useEdgePinCache || !isAdminPinCached(pin)) {
          const pinRows = await sql<Array<{ res: { ok?: boolean } }>>`
            SELECT public.rpc_verify_role_pin('OWNER_ADMIN', ${pin}::text) AS res
          `;
          if (!pinRows[0]?.res?.ok) {
            recordPinFailure(clientKey);
            return { ok: false, error: 'PIN Admin tidak valid atau sesi telah berakhir.' };
          }
          pinFailuresByClient.delete(clientKey);
          if (useEdgePinCache) cacheVerifiedAdminPin(pin);
        }
      }

      const attachSnapshot = async (res: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (!res.ok || !payload.includeSnapshot) return res;
        const snapshot = await fetchMbgSnapshotFromSql(sql);
        return { ...res, snapshot };
      };

      switch (payload.action) {
        case 'upsert_order': {
          const itemsJson = payload.input.lines.map((l) => ({
            product_id: l.item_id,
            item_id: l.item_id,
            qty_ordered_kg: roundKg(l.qty_ordered_kg),
            kitchen_unit_price_rp: l.kitchen_unit_price_rp,
            margin_per_kg_rp: l.margin_per_kg_rp,
          }));
          const rows = await sql<Array<{ res: Record<string, unknown> }>>`
            SELECT public.rpc_upsert_kitchen_order(
              ${payload.input.kitchen_id}::text,
              ${payload.orderDate}::date,
              ${sql.json(itemsJson)}::jsonb,
              ${payload.input.notes ?? null}::text
            ) AS res
          `;
          const res = rows[0]?.res ?? {};
          return attachSnapshot({
            ok: true,
            order_id: String(res.order_id ?? ''),
            order_code: String(res.order_code ?? ''),
            merged: Boolean(res.merged),
            count: Number(res.count ?? itemsJson.length),
          });
        }

        case 'update_order': {
          const itemsJson = payload.input.lines.map((l) => ({
            id: l.id ?? null,
            product_id: l.item_id,
            item_id: l.item_id,
            qty_ordered_kg: roundKg(l.qty_ordered_kg),
            qty_accepted_kg: l.qty_accepted_kg != null ? roundKg(l.qty_accepted_kg) : null,
            kitchen_unit_price_rp: l.kitchen_unit_price_rp,
            margin_per_kg_rp: l.margin_per_kg_rp,
          }));
          const rows = await sql<Array<{ res: Record<string, unknown> }>>`
            SELECT public.rpc_update_kitchen_order(
              ${payload.input.delivery_id}::text,
              ${payload.input.kitchen_id}::text,
              ${payload.input.order_date}::date,
              ${sql.json(itemsJson)}::jsonb
            ) AS res
          `;
          const res = rows[0]?.res ?? {};
          return attachSnapshot({
            ok: true,
            order_id: String(res.order_id ?? payload.input.delivery_id),
            count: Number(res.count ?? itemsJson.length),
          });
        }

        case 'mark_invoice_paid': {
          await sql`SELECT public.rpc_mark_invoice_paid(${payload.invoiceId}::text)`;
          return attachSnapshot({ ok: true });
        }

        case 'execute_payout': {
          const entryIds = payload.entryIds && payload.entryIds.length > 0 ? payload.entryIds : null;
          const rows = await sql<Array<{ res: Record<string, unknown> }>>`
            SELECT public.rpc_execute_profit_payout(
              ${payload.target}::text,
              ${entryIds ? sql.array(entryIds) : null}::text[]
            ) AS res
          `;
          const res = rows[0]?.res ?? {};
          return attachSnapshot({
            ok: true,
            count: Number(res.count ?? 0),
            total_payout_rp: Number(res.total_payout_rp ?? 0),
          });
        }

        case 'update_app_settings': {
          const p = payload.params;
          await sql`
            SELECT public.rpc_update_app_settings(
              ${p.teamSharePct}::numeric,
              ${p.coopSharePct}::numeric,
              ${p.bankName ?? null}::text,
              ${p.accountNumber ?? null}::text,
              ${p.accountHolder ?? null}::text,
              ${p.supplierName ?? null}::text
            )
          `;
          return attachSnapshot({ ok: true });
        }

        case 'delete_order_item': {
          const deleted = await sql<Array<{ id: string }>>`
            DELETE FROM public.kitchen_order_items oi
            WHERE oi.id = ${payload.itemId}
              AND NOT EXISTS (
                SELECT 1 FROM public.kitchen_orders o
                WHERE o.id = oi.order_id AND o.status = 'BAST_LOCKED'
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.kitchen_invoices i
                WHERE i.order_id = oi.order_id AND i.status = 'PAID'
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.profit_ledger_entries p
                WHERE p.order_id = oi.order_id AND (p.team_paid_out OR p.coop_paid_out)
              )
            RETURNING oi.id
          `;
          if (deleted.length === 0) {
            return { ok: false, error: 'Baris order sudah dikunci (Invoice Lunas / Bagi Hasil Cair) dan tidak bisa dihapus.' };
          }
          return attachSnapshot({ ok: true });
        }

        case 'delete_order': {
          const deleted = await sql<Array<{ id: string }>>`
            DELETE FROM public.kitchen_orders o
            WHERE o.id = ${payload.orderId}
              AND o.status <> 'BAST_LOCKED'
              AND NOT EXISTS (
                SELECT 1 FROM public.kitchen_invoices i
                WHERE i.order_id = o.id AND i.status = 'PAID'
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.profit_ledger_entries p
                WHERE p.order_id = o.id AND (p.team_paid_out OR p.coop_paid_out)
              )
            RETURNING o.id
          `;
          if (deleted.length === 0) {
            return { ok: false, error: 'Order sudah dikunci (Invoice Lunas / Bagi Hasil Cair) dan tidak bisa dihapus.' };
          }
          return attachSnapshot({ ok: true });
        }

        case 'upsert_kitchen': {
          const k = payload.kitchen;
          await sql`
            INSERT INTO public.kitchens (
              id, code, name, address, pic_name, pic_phone, default_markup_per_kg, is_active, created_at
            ) VALUES (
              ${k.id}, ${k.kitchen_code}, ${k.name}, ${k.address}, ${k.pic_name}, ${k.pic_phone},
              ${k.default_markup_per_kg}, ${k.is_active}, ${k.created_at}::timestamptz
            )
            ON CONFLICT (id) DO UPDATE SET
              code = EXCLUDED.code,
              name = EXCLUDED.name,
              address = EXCLUDED.address,
              pic_name = EXCLUDED.pic_name,
              pic_phone = EXCLUDED.pic_phone,
              default_markup_per_kg = EXCLUDED.default_markup_per_kg,
              is_active = EXCLUDED.is_active
          `;
          return attachSnapshot({ ok: true });
        }

        case 'upsert_product': {
          const it = payload.item;
          await sql`
            INSERT INTO public.products (
              id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at
            ) VALUES (
              ${it.id}, ${it.sku}, ${it.name}, ${it.category},
              ${it.default_kitchen_price_per_kg}, ${it.default_margin_per_kg}, ${it.is_active}, ${it.created_at}::timestamptz
            )
            ON CONFLICT (id) DO UPDATE SET
              code = EXCLUDED.code,
              name = EXCLUDED.name,
              category = EXCLUDED.category,
              default_kitchen_price_rp = EXCLUDED.default_kitchen_price_rp,
              default_margin_per_kg_rp = EXCLUDED.default_margin_per_kg_rp,
              is_active = EXCLUDED.is_active
          `;
          return attachSnapshot({ ok: true });
        }

        case 'delete_kitchen': {
          await sql`DELETE FROM public.kitchens WHERE id = ${payload.kitchenId}`;
          return attachSnapshot({ ok: true });
        }

        case 'delete_product': {
          await sql`DELETE FROM public.products WHERE id = ${payload.productId}`;
          return attachSnapshot({ ok: true });
        }

        case 'verify_role_pin': {
          if (isClientPinLocked(clientKey)) {
            return { ok: false, error: PIN_LOCKOUT_ERROR };
          }
          const rows = await sql<Array<{ res: { ok?: boolean } }>>`
            SELECT public.rpc_verify_role_pin(${payload.role}::text, ${payload.pin}::text) AS res
          `;
          const ok = Boolean(rows[0]?.res?.ok);
          if (!ok) {
            recordPinFailure(clientKey);
            return { ok: false };
          }
          pinFailuresByClient.delete(clientKey);
          if (payload.role === 'OWNER_ADMIN' && useEdgePinCache) {
            cacheVerifiedAdminPin(String(payload.pin ?? '').trim());
          }
          return { ok: true };
        }
      }
    },
    env,
    sqlFactory
  );
}
