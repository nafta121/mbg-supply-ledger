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

export const HYPERDRIVE_CONFIG_ID = 'b25c4027b55f44c8a219ac965d2f2720';

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
 * - `max: 5` (Cloudflare Workers concurrent subrequest limit)
 * - `fetch_types: false` (avoids an extra round-trip on connection initialization)
 * - `prepare: true` (enables Hyperdrive prepared statement caching)
 */
export function createHyperdriveSql(connectionString: string): Sql {
  return postgres(connectionString, {
    max: 5,
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
 * Queries all relational tables over Cloudflare Hyperdrive and maps them to `MbgData`.
 * Never selects `admin_pin` or `coop_pin` from `public.app_settings`.
 */
export async function queryMbgDataViaHyperdrive(
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<MbgData> {
  return withHyperdriveSql(
    async (sql) => {
      const [
        kitchens,
        products,
        orders,
        orderItems,
        invoices,
        ledgerEntries,
        appSettings,
        payoutBatches,
      ] = await Promise.all([
        sql<KitchenRow[]>`SELECT * FROM public.kitchens ORDER BY code ASC`,
        sql<ProductRow[]>`SELECT * FROM public.products ORDER BY code ASC`,
        sql<KitchenOrderRow[]>`SELECT * FROM public.kitchen_orders ORDER BY created_at DESC LIMIT 2000`,
        sql<KitchenOrderItemRow[]>`SELECT * FROM public.kitchen_order_items ORDER BY created_at DESC LIMIT 5000`,
        sql<KitchenInvoiceRow[]>`SELECT * FROM public.kitchen_invoices ORDER BY created_at DESC LIMIT 2000`,
        sql<ProfitLedgerRow[]>`SELECT * FROM public.profit_ledger_entries ORDER BY created_at DESC LIMIT 5000`,
        sql<AppSettingsRow[]>`
          SELECT id, team_share_pct, coop_share_pct, supplier_name,
                 payment_bank_name, payment_account_number, payment_account_holder, updated_at
          FROM public.app_settings
          WHERE id = 'default'
        `.catch(
          () =>
            sql<AppSettingsRow[]>`
              SELECT id, team_share_pct, coop_share_pct,
                     payment_bank_name, payment_account_number, payment_account_holder, updated_at
              FROM public.app_settings
              WHERE id = 'default'
            `
        ),
        sql<ProfitPayoutBatchRow[]>`SELECT * FROM public.profit_payout_batches ORDER BY disbursed_at DESC LIMIT 1000`,
      ]);

      return fromSupabaseRows({
        kitchens: Array.from(kitchens),
        products: Array.from(products),
        orders: Array.from(orders),
        orderItems: Array.from(orderItems),
        invoices: Array.from(invoices),
        ledgerEntries: Array.from(ledgerEntries),
        splitConfigs: [],
        appSettings: Array.from(appSettings),
        payoutBatches: Array.from(payoutBatches),
      });
    },
    env,
    sqlFactory
  );
}

export type HyperdriveActionPayload =
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

/**
 * Executes an RPC or table mutation directly over Cloudflare Hyperdrive.
 */
export async function executeHyperdriveAction(
  payload: HyperdriveActionPayload,
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<Record<string, unknown>> {
  return withHyperdriveSql(
    async (sql) => {
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
          return {
            ok: true,
            order_id: String(res.order_id ?? ''),
            order_code: String(res.order_code ?? ''),
            merged: Boolean(res.merged),
            count: Number(res.count ?? itemsJson.length),
          };
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
          return {
            ok: true,
            order_id: String(res.order_id ?? payload.input.delivery_id),
            count: Number(res.count ?? itemsJson.length),
          };
        }

        case 'mark_invoice_paid': {
          await sql`SELECT public.rpc_mark_invoice_paid(${payload.invoiceId}::text)`;
          return { ok: true };
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
          return {
            ok: true,
            count: Number(res.count ?? 0),
            total_payout_rp: Number(res.total_payout_rp ?? 0),
          };
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
          return { ok: true };
        }

        case 'delete_order_item': {
          await sql`DELETE FROM public.kitchen_order_items WHERE id = ${payload.itemId}`;
          return { ok: true };
        }

        case 'delete_order': {
          await sql`DELETE FROM public.kitchen_orders WHERE id = ${payload.orderId} AND status <> 'BAST_LOCKED'`;
          return { ok: true };
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
          return { ok: true };
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
          return { ok: true };
        }

        case 'delete_kitchen': {
          await sql`DELETE FROM public.kitchens WHERE id = ${payload.kitchenId}`;
          return { ok: true };
        }

        case 'delete_product': {
          await sql`DELETE FROM public.products WHERE id = ${payload.productId}`;
          return { ok: true };
        }

        case 'verify_role_pin': {
          const rows = await sql<Array<{ res: { ok?: boolean } }>>`
            SELECT public.rpc_verify_role_pin(${payload.role}::text, ${payload.pin}::text) AS res
          `;
          return { ok: Boolean(rows[0]?.res?.ok) };
        }
      }
    },
    env,
    sqlFactory
  );
}
