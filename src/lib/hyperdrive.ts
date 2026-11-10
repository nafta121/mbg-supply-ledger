/**
 * Cloudflare D1 (SQLite) & Edge Ledger Engine for MBG Supply Chain Ledger.
 *
 * Primary production backend: Cloudflare D1 (`env.DB`) with atomic `db.batch([...])`
 * transactions, `BigInt` Sen/Gram financial calculations (`src/lib/financial-engine.ts`),
 * and Web Crypto API (`crypto.subtle`) constant-time PIN verification.
 * Also preserves `sqlFactory` support for legacy SQL unit-test harnesses.
 */
import type { BeneficiaryType, Item, Kitchen } from '../types/mbg';
import {
  calculateProfitSplitEntry,
  DEFAULT_PAYMENT_INFO,
  divideHalfUp,
  idrToSen,
  kgToGrams,
  multiplyWeightGramsByPriceSen,
  pctToBasisPoints,
  roundKg,
  senToIdr,
} from './financial-engine';
import { type CreateOrderInput, type MbgData, type UpdateOrderInput } from './order-engine';
import { getJakartaTodayYmd } from './ui-format';
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

export interface Sql {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  json?: (v: unknown) => unknown;
  array?: (v: unknown) => unknown;
  end: (opts?: { timeout?: number }) => Promise<void>;
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export interface HyperdriveBinding {
  connectionString: string;
}

export interface HyperdriveEnv {
  DB?: D1DatabaseLike;
  HYPERDRIVE?: HyperdriveBinding;
  HYPERDRIVE_CONNECTION_STRING?: string;
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE?: string;
  DATABASE_URL?: string;
}

const PLACEHOLDER_LOCAL_CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function resolveD1Database(env?: HyperdriveEnv): D1DatabaseLike | null {
  const globalEnv = (globalThis as unknown as { __env__?: HyperdriveEnv }).__env__;
  const candidate = env?.DB ?? globalEnv?.DB;
  if (candidate && typeof candidate.prepare === 'function' && typeof candidate.batch === 'function') {
    return candidate;
  }
  return null;
}

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
  return resolveD1Database(env) !== null || resolveHyperdriveConnectionString(env) !== null;
}

export async function withHyperdriveSql<T>(
  fn: (sql: Sql) => Promise<T>,
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<T> {
  const connStr = resolveHyperdriveConnectionString(env);
  if (!connStr || !sqlFactory) {
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
 * Queries all relational tables in a single D1 `db.batch([...])` round-trip
 * and maps them to `MbgData`. Never selects `admin_pin` or `coop_pin` from `app_settings`.
 */
export async function fetchMbgSnapshotFromD1(db: D1DatabaseLike): Promise<MbgData> {
  const [
    kitchensRes,
    productsRes,
    ordersRes,
    orderItemsRes,
    invoicesRes,
    ledgerRes,
    settingsRes,
    payoutsRes,
  ] = await db.batch([
    db.prepare('SELECT * FROM kitchens ORDER BY code ASC'),
    db.prepare('SELECT * FROM products ORDER BY code ASC'),
    db.prepare('SELECT * FROM kitchen_orders ORDER BY created_at DESC LIMIT 2000'),
    db.prepare(
      'SELECT * FROM kitchen_order_items WHERE order_id IN (SELECT id FROM kitchen_orders ORDER BY created_at DESC LIMIT 2000) ORDER BY created_at DESC'
    ),
    db.prepare(
      'SELECT * FROM kitchen_invoices WHERE order_id IN (SELECT id FROM kitchen_orders ORDER BY created_at DESC LIMIT 2000) ORDER BY created_at DESC'
    ),
    db.prepare(
      'SELECT * FROM profit_ledger_entries WHERE order_id IN (SELECT id FROM kitchen_orders ORDER BY created_at DESC LIMIT 2000) OR invoice_id IN (SELECT id FROM kitchen_invoices WHERE order_id IN (SELECT id FROM kitchen_orders ORDER BY created_at DESC LIMIT 2000)) ORDER BY created_at DESC'
    ),
    db.prepare(
      "SELECT id, team_share_pct, coop_share_pct, supplier_name, payment_bank_name, payment_account_number, payment_account_holder, updated_at FROM app_settings WHERE id = 'default'"
    ),
    db.prepare('SELECT * FROM profit_payout_batches ORDER BY disbursed_at DESC LIMIT 1000'),
  ]);

  return fromSupabaseRows({
    kitchens: (kitchensRes?.results ?? []) as unknown as KitchenRow[],
    products: (productsRes?.results ?? []) as unknown as ProductRow[],
    orders: (ordersRes?.results ?? []) as unknown as KitchenOrderRow[],
    orderItems: (orderItemsRes?.results ?? []) as unknown as KitchenOrderItemRow[],
    invoices: (invoicesRes?.results ?? []) as unknown as KitchenInvoiceRow[],
    ledgerEntries: (ledgerRes?.results ?? []) as unknown as ProfitLedgerRow[],
    splitConfigs: [],
    appSettings: (settingsRes?.results ?? []) as unknown as AppSettingsRow[],
    payoutBatches: (payoutsRes?.results ?? []) as unknown as ProfitPayoutBatchRow[],
  });
}

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
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM public.profit_ledger_entries WHERE order_id IN (SELECT id FROM recent_orders) OR invoice_id IN (SELECT id FROM public.kitchen_invoices WHERE order_id IN (SELECT id FROM recent_orders)) ORDER BY created_at DESC) t), '[]'::json) AS "ledgerEntries",
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
  const d1 = resolveD1Database(env);
  if (d1 && !sqlFactory) {
    return fetchMbgSnapshotFromD1(d1);
  }
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
  clientMutationId?: string;
};

const ADMIN_PIN_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedAdminPin: { digest: Uint8Array; expiresAt: number } | null = null;

const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MS = 10 * 60 * 1000;
const MAX_TRACKED_PIN_CLIENTS = 256;
const PIN_LOCKOUT_ERROR = 'Terlalu banyak percobaan PIN salah. Coba lagi dalam 10 menit.';

const MUTATION_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_MUTATION_IDS = 256;

interface PinFailureEntry {
  count: number;
  resetAt: number;
}

interface CompletedMutationEntry {
  result: Record<string, unknown>;
  expiresAt: number;
}

const pinFailuresByClient = new Map<string, PinFailureEntry>();
const completedMutations = new Map<string, CompletedMutationEntry>();

export function resetHyperdrivePinGuardForTest(): void {
  cachedAdminPin = null;
  pinFailuresByClient.clear();
  completedMutations.clear();
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hashBuffer);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await sha256Bytes(input);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += (digest[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = globalThis.crypto?.subtle as
    | (SubtleCrypto & { timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean })
    | undefined;
  if (subtle && typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a as BufferSource, b as BufferSource);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export async function computeSnapshotEtag(data: unknown): Promise<string> {
  const digest = await sha256Bytes(JSON.stringify(data));
  let hex = '';
  for (let i = 0; i < 16 && i < digest.length; i++) {
    hex += (digest[i] ?? 0).toString(16).padStart(2, '0');
  }
  return `W/"${hex}"`;
}

async function isAdminPinCached(pin: string): Promise<boolean> {
  if (!cachedAdminPin) return false;
  if (Date.now() > cachedAdminPin.expiresAt) {
    cachedAdminPin = null;
    return false;
  }
  const candidateDigest = await sha256Bytes(pin);
  return timingSafeEqualBytes(cachedAdminPin.digest, candidateDigest);
}

async function cacheVerifiedAdminPin(pin: string): Promise<void> {
  const digest = await sha256Bytes(pin);
  cachedAdminPin = { digest, expiresAt: Date.now() + ADMIN_PIN_CACHE_TTL_MS };
}

function getCachedMutationResult(mutationKey: string): Record<string, unknown> | null {
  const entry = completedMutations.get(mutationKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    completedMutations.delete(mutationKey);
    return null;
  }
  return entry.result;
}

function recordCompletedMutation(mutationKey: string, result: Record<string, unknown>): void {
  if (!completedMutations.has(mutationKey) && completedMutations.size >= MAX_TRACKED_MUTATION_IDS) {
    const oldestKey = completedMutations.keys().next().value;
    if (oldestKey !== undefined) {
      completedMutations.delete(oldestKey);
    }
  }
  completedMutations.set(mutationKey, {
    result,
    expiresAt: Date.now() + MUTATION_IDEMPOTENCY_TTL_MS,
  });
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

// ---------- Cloudflare D1 Atomic Ledger Helpers ----------

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

function makeRandomId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

function addDaysYmd(isoDate: string, days: number): string {
  const clean = String(isoDate ?? '').slice(0, 10) || getJakartaTodayYmd();
  const d = new Date(`${clean}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return getJakartaTodayYmd();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function hashRolePin(role: string, pin: string): Promise<string> {
  const normalizedRole = String(role ?? '').trim().toUpperCase();
  const cleanPin = String(pin ?? '').trim();
  return (await sha256Hex(`${normalizedRole}:mbg-pin-v1:${cleanPin}`)).toLowerCase();
}

async function isClientPinLockedD1(db: D1DatabaseLike, clientKey: string): Promise<boolean> {
  if (isClientPinLocked(clientKey)) return true;
  try {
    const row = await db
      .prepare('SELECT fail_count, reset_at_ms FROM security_rate_limits WHERE client_key = ? LIMIT 1')
      .bind(clientKey)
      .first<{ fail_count?: number; reset_at_ms?: number }>();
    if (!row) return false;
    const now = Date.now();
    const resetAt = num(row.reset_at_ms);
    const count = num(row.fail_count);
    if (now > resetAt) return false;
    pinFailuresByClient.set(clientKey, { count, resetAt });
    return count >= MAX_PIN_FAILURES;
  } catch {
    return false;
  }
}

async function recordPinFailureD1(db: D1DatabaseLike, clientKey: string): Promise<void> {
  recordPinFailure(clientKey);
  const entry = pinFailuresByClient.get(clientKey);
  if (!entry) return;
  try {
    await db
      .prepare(
        `INSERT INTO security_rate_limits (client_key, fail_count, reset_at_ms, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET
           fail_count = excluded.fail_count,
           reset_at_ms = excluded.reset_at_ms,
           updated_at = excluded.updated_at`
      )
      .bind(clientKey, entry.count, entry.resetAt, new Date().toISOString())
      .run();
  } catch {
    // Fallback to in-memory map when table is absent in lightweight test mocks
  }
}

async function clearPinFailureD1(db: D1DatabaseLike, clientKey: string): Promise<void> {
  pinFailuresByClient.delete(clientKey);
  try {
    await db.prepare('DELETE FROM security_rate_limits WHERE client_key = ?').bind(clientKey).run();
  } catch {
    // Ignore when table is absent in test mocks
  }
}

async function getCachedMutationResultD1(
  db: D1DatabaseLike,
  mutationKey: string
): Promise<Record<string, unknown> | null> {
  const local = getCachedMutationResult(mutationKey);
  if (local) return local;
  try {
    const row = await db
      .prepare(
        'SELECT result_json, expires_at_ms FROM mutation_idempotency_log WHERE mutation_key = ? LIMIT 1'
      )
      .bind(mutationKey)
      .first<{ result_json?: string; expires_at_ms?: number }>();
    if (!row || !row.result_json) return null;
    if (Date.now() > num(row.expires_at_ms)) return null;
    const parsed = JSON.parse(row.result_json) as Record<string, unknown>;
    recordCompletedMutation(mutationKey, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function recordCompletedMutationD1(
  db: D1DatabaseLike,
  mutationKey: string,
  result: Record<string, unknown>
): Promise<void> {
  recordCompletedMutation(mutationKey, result);
  const expiresAt = Date.now() + MUTATION_IDEMPOTENCY_TTL_MS;
  try {
    await db
      .prepare(
        `INSERT INTO mutation_idempotency_log (mutation_key, result_json, expires_at_ms, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mutation_key) DO UPDATE SET
           result_json = excluded.result_json,
           expires_at_ms = excluded.expires_at_ms`
      )
      .bind(mutationKey, JSON.stringify(result), expiresAt, new Date().toISOString())
      .run();
  } catch {
    // Fallback to in-memory map when table is absent in lightweight test mocks
  }
}

async function verifyPinOnD1(db: D1DatabaseLike, role: string, pin: string): Promise<boolean> {
  const normalizedRole = String(role ?? '').trim().toUpperCase();
  const cleanPin = String(pin ?? '').trim();
  if (!cleanPin || (normalizedRole !== 'OWNER_ADMIN' && normalizedRole !== 'COOPERATIVE_VIEWER')) {
    return false;
  }

  const credRow = await db
    .prepare('SELECT pin_sha256 FROM role_credentials WHERE role = ? LIMIT 1')
    .bind(normalizedRole)
    .first<{ pin_sha256?: string }>();
  if (credRow?.pin_sha256) {
    const storedBytes = new TextEncoder().encode(credRow.pin_sha256.trim().toLowerCase());
    const [saltedHex, legacyUnsaltedHex] = await Promise.all([
      hashRolePin(normalizedRole, cleanPin),
      sha256Hex(cleanPin),
    ]);
    if (timingSafeEqualBytes(storedBytes, new TextEncoder().encode(saltedHex))) {
      return true;
    }
    if (timingSafeEqualBytes(storedBytes, new TextEncoder().encode(legacyUnsaltedHex.toLowerCase()))) {
      // Auto-upgrade legacy unsalted hash to role-salted hash and purge plaintext PINs
      const nowIso = new Date().toISOString();
      await db
        .batch([
          db
            .prepare('UPDATE role_credentials SET pin_sha256 = ?, updated_at = ? WHERE role = ?')
            .bind(saltedHex, nowIso, normalizedRole),
          db.prepare("UPDATE app_settings SET admin_pin = '', coop_pin = '' WHERE id = 'default'"),
        ])
        .catch(() => undefined);
      return true;
    }
    return false;
  }

  const settingsRow = await db
    .prepare("SELECT admin_pin, coop_pin FROM app_settings WHERE id = 'default' LIMIT 1")
    .first<{ admin_pin?: string; coop_pin?: string }>();
  const rawFallback =
    normalizedRole === 'OWNER_ADMIN'
      ? String(settingsRow?.admin_pin ?? '').trim()
      : String(settingsRow?.coop_pin ?? '').trim();
  if (!rawFallback) return false;
  const [expectedDigest, candidateDigest] = await Promise.all([
    sha256Bytes(rawFallback),
    sha256Bytes(cleanPin),
  ]);
  const matched = timingSafeEqualBytes(expectedDigest, candidateDigest);
  if (matched) {
    const saltedHex = await hashRolePin(normalizedRole, cleanPin);
    const nowIso = new Date().toISOString();
    await db
      .batch([
        db
          .prepare(
            'INSERT OR REPLACE INTO role_credentials (role, pin_sha256, updated_at) VALUES (?, ?, ?)'
          )
          .bind(normalizedRole, saltedHex, nowIso),
        db.prepare("UPDATE app_settings SET admin_pin = '', coop_pin = '' WHERE id = 'default'"),
      ])
      .catch(() => undefined);
  }
  return matched;
}

/**
 * Reconciles `profit_payout_batches` totals and purges empty/orphaned batches on D1.
 * Matches `public.fn_reconcile_payout_batches()` from `0019_auto_reconcile_payout_batches.sql`.
 */
export async function reconcilePayoutBatchesD1(db: D1DatabaseLike): Promise<void> {
  await db.batch([
    db.prepare(`
      UPDATE profit_payout_batches
      SET total_payout_amount = COALESCE((
        SELECT ROUND(SUM(
          CASE
            WHEN profit_payout_batches.beneficiary_type = 'TEAM' THEN p.team_amount_rp
            ELSE p.coop_amount_rp
          END
        ), 2)
        FROM profit_ledger_entries p
        WHERE (profit_payout_batches.beneficiary_type = 'TEAM' AND p.team_payout_batch_id = profit_payout_batches.id AND p.team_paid_out = 1)
           OR (profit_payout_batches.beneficiary_type = 'COOPERATIVE' AND p.coop_payout_batch_id = profit_payout_batches.id AND p.coop_paid_out = 1)
      ), 0)
    `),
    db.prepare(`
      DELETE FROM profit_payout_batches
      WHERE COALESCE(total_payout_amount, 0) <= 0
         OR NOT EXISTS (
           SELECT 1 FROM profit_ledger_entries p
           WHERE (profit_payout_batches.beneficiary_type = 'TEAM' AND p.team_payout_batch_id = profit_payout_batches.id AND p.team_paid_out = 1)
              OR (profit_payout_batches.beneficiary_type = 'COOPERATIVE' AND p.coop_payout_batch_id = profit_payout_batches.id AND p.coop_paid_out = 1)
         )
    `),
  ]);
}

/**
 * Authoritative recalculation of `kitchen_orders`, `kitchen_invoices`, and `profit_ledger_entries` on D1.
 * Matches `public.fn_recalculate_order_financials(p_order_id)` from `0016_ponytail_audit_fixes.sql`.
 */
export async function recalculateOrderFinancialsD1(db: D1DatabaseLike, orderId: string): Promise<void> {
  const [orderRes, itemsRes, invRes, settingsRes, ledgerRes] = await db.batch([
    db.prepare('SELECT * FROM kitchen_orders WHERE id = ? LIMIT 1').bind(orderId),
    db.prepare('SELECT * FROM kitchen_order_items WHERE order_id = ? ORDER BY created_at ASC').bind(orderId),
    db.prepare('SELECT * FROM kitchen_invoices WHERE order_id = ? LIMIT 1').bind(orderId),
    db.prepare("SELECT * FROM app_settings WHERE id = 'default' LIMIT 1"),
    db.prepare('SELECT * FROM profit_ledger_entries WHERE order_id = ?').bind(orderId),
  ]);

  const order = (orderRes?.results?.[0] ?? null) as KitchenOrderRow | null;
  if (!order) return;

  const items = (itemsRes?.results ?? []) as unknown as KitchenOrderItemRow[];
  const existingInv = (invRes?.results?.[0] ?? null) as KitchenInvoiceRow | null;

  if (items.length === 0) {
    if (existingInv?.status === 'PAID') {
      throw new Error('Order dengan invoice lunas harus memiliki minimal 1 barang.');
    }
    await db.batch([
      db.prepare('DELETE FROM profit_ledger_entries WHERE order_id = ?').bind(orderId),
      db.prepare('DELETE FROM kitchen_invoices WHERE order_id = ?').bind(orderId),
      db.prepare('DELETE FROM kitchen_orders WHERE id = ?').bind(orderId),
    ]);
    await reconcilePayoutBatchesD1(db);
    return;
  }

  const setting = (settingsRes?.results?.[0] ?? null) as AppSettingsRow | null;
  const existingLedgers = (ledgerRes?.results ?? []) as unknown as ProfitLedgerRow[];

  let teamPct = setting ? num(setting.team_share_pct) : 60;
  let coopPct = setting ? num(setting.coop_share_pct) : 40;
  const lockedLedger = existingLedgers.find((le) => Boolean(le.team_paid_out) || Boolean(le.coop_paid_out));
  if (lockedLedger) {
    teamPct = num(lockedLedger.team_share_pct);
    coopPct = num(lockedLedger.coop_share_pct);
  }

  const supplierName = (setting?.supplier_name ?? '').trim() || DEFAULT_PAYMENT_INFO.supplier_name;
  const bankName = (setting?.payment_bank_name ?? '').trim() || DEFAULT_PAYMENT_INFO.payment_bank_name;
  const accountNumber =
    (setting?.payment_account_number ?? '').trim() || DEFAULT_PAYMENT_INFO.payment_account_number;
  const accountHolder =
    (setting?.payment_account_holder ?? '').trim() || DEFAULT_PAYMENT_INFO.payment_account_holder;

  let weighedCount = 0;
  let totalInvoiceSen = 0n;
  for (const item of items) {
    const isWeighed = Boolean(item.is_weighed);
    if (isWeighed) weighedCount++;
    const effKg = isWeighed && item.qty_accepted_kg != null ? roundKg(item.qty_accepted_kg) : roundKg(item.qty_ordered_kg);
    const unitPriceRp = num(item.kitchen_unit_price_rp);
    totalInvoiceSen += multiplyWeightGramsByPriceSen(kgToGrams(effKg), idrToSen(unitPriceRp));
  }
  const totalInvoiceRp = senToIdr(totalInvoiceSen);

  const newOrderStatus =
    weighedCount === items.length ? 'BAST_VERIFIED' : weighedCount > 0 ? 'PARTIALLY_WEIGHED' : 'IN_TRANSIT';
  const nowIso = new Date().toISOString();
  const bastVerifiedAt =
    newOrderStatus === 'BAST_VERIFIED' ? order.bast_verified_at ?? nowIso : null;

  const stmts: D1PreparedStatementLike[] = [
    db
      .prepare('UPDATE kitchen_orders SET status = ?, bast_verified_at = ?, updated_at = ? WHERE id = ?')
      .bind(newOrderStatus, bastVerifiedAt, nowIso, orderId),
  ];

  const invoiceId = existingInv?.id ?? `inv-${orderId}`;
  const invoiceStatus: 'UNPAID' | 'PAID' = existingInv?.status === 'PAID' ? 'PAID' : 'UNPAID';
  const dueDate = addDaysYmd(order.order_date, 7);

  if (!existingInv) {
    const invoiceCode = order.order_code.replace(/^SJ-/, 'INV-');
    stmts.push(
      db
        .prepare(
          `INSERT INTO kitchen_invoices (
            id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
            total_amount_rp, amount_paid_rp, status,
            supplier_name, payment_bank_name, payment_account_number, payment_account_holder,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          invoiceId,
          invoiceCode,
          orderId,
          order.kitchen_id,
          order.order_date,
          dueDate,
          totalInvoiceRp,
          supplierName,
          bankName,
          accountNumber,
          accountHolder,
          nowIso,
          nowIso
        )
    );
  } else {
    const amountPaidRp = invoiceStatus === 'PAID' ? totalInvoiceRp : num(existingInv.amount_paid_rp);
    const invSupplier =
      invoiceStatus === 'PAID' ? (existingInv.supplier_name ?? '').trim() || supplierName : supplierName;
    const invBank =
      invoiceStatus === 'PAID' ? (existingInv.payment_bank_name ?? '').trim() || bankName : bankName;
    const invAccNum =
      invoiceStatus === 'PAID'
        ? (existingInv.payment_account_number ?? '').trim() || accountNumber
        : accountNumber;
    const invAccHolder =
      invoiceStatus === 'PAID'
        ? (existingInv.payment_account_holder ?? '').trim() || accountHolder
        : accountHolder;

    stmts.push(
      db
        .prepare(
          `UPDATE kitchen_invoices
           SET kitchen_id = ?, invoice_date = ?, due_date = ?,
               total_amount_rp = ?, amount_paid_rp = ?,
               supplier_name = ?, payment_bank_name = ?, payment_account_number = ?, payment_account_holder = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          order.kitchen_id,
          order.order_date,
          dueDate,
          totalInvoiceRp,
          amountPaidRp,
          invSupplier,
          invBank,
          invAccNum,
          invAccHolder,
          nowIso,
          invoiceId
        )
    );
  }

  const activeItemIds = new Set(items.map((it) => it.id));
  let deletedAnyLedger = false;
  for (const oldLe of existingLedgers) {
    if (
      oldLe.order_item_id &&
      !activeItemIds.has(oldLe.order_item_id) &&
      !Boolean(oldLe.team_paid_out) &&
      !Boolean(oldLe.coop_paid_out)
    ) {
      stmts.push(db.prepare('DELETE FROM profit_ledger_entries WHERE id = ?').bind(oldLe.id));
      deletedAnyLedger = true;
    }
  }

  if (pctToBasisPoints(teamPct) + pctToBasisPoints(coopPct) !== 10000n) {
    coopPct = Math.round((100 - teamPct) * 100) / 100;
  }

  for (const item of items) {
    const isWeighed = Boolean(item.is_weighed);
    const effKg = Math.max(
      0,
      isWeighed && item.qty_accepted_kg != null ? roundKg(item.qty_accepted_kg) : roundKg(item.qty_ordered_kg)
    );
    const split = calculateProfitSplitEntry({
      qty_accepted_kg: effKg,
      margin_per_kg_rp: Math.max(0, num(item.margin_per_kg_rp)),
      team_share_pct: teamPct,
      cooperative_share_pct: coopPct,
      invoice_payment_status: invoiceStatus,
    });
    const itemGrossRp = split.total_margin;
    const coopAmountRp = split.koperasi_share_amount;
    const teamAmountRp = split.team_share_amount;
    const pleStatus = split.payout_status;

    const existingPle = existingLedgers.find(
      (le) => le.id === `ple-${item.id}` || le.order_item_id === item.id
    );

    if (existingPle) {
      if (!Boolean(existingPle.team_paid_out) && !Boolean(existingPle.coop_paid_out)) {
        const unlockedAt = invoiceStatus === 'PAID' ? existingPle.unlocked_at ?? nowIso : null;
        stmts.push(
          db
            .prepare(
              `UPDATE profit_ledger_entries
               SET order_id = ?, kitchen_id = ?, gross_margin_rp = ?,
                   team_share_pct = ?, coop_share_pct = ?,
                   team_amount_rp = ?, coop_amount_rp = ?,
                   status = ?, unlocked_at = ?, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              orderId,
              order.kitchen_id,
              itemGrossRp,
              teamPct,
              coopPct,
              teamAmountRp,
              coopAmountRp,
              pleStatus,
              unlockedAt,
              nowIso,
              existingPle.id
            )
        );
      }
    } else {
      const unlockedAt = invoiceStatus === 'PAID' ? nowIso : null;
      stmts.push(
        db
          .prepare(
            `INSERT INTO profit_ledger_entries (
              id, invoice_id, order_id, order_item_id, kitchen_id,
              gross_margin_rp, team_share_pct, coop_share_pct,
              team_amount_rp, coop_amount_rp, status,
              team_paid_out, coop_paid_out, unlocked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
          )
          .bind(
            `ple-${item.id}`,
            invoiceId,
            orderId,
            item.id,
            order.kitchen_id,
            itemGrossRp,
            teamPct,
            coopPct,
            teamAmountRp,
            coopAmountRp,
            pleStatus,
            unlockedAt,
            nowIso,
            nowIso
          )
      );
    }
  }

  await db.batch(stmts);
  if (deletedAnyLedger) {
    await reconcilePayoutBatchesD1(db);
  }
}

async function executeD1Action(
  db: D1DatabaseLike,
  payload: HyperdriveActionPayload
): Promise<Record<string, unknown>> {
  const clientKey = (payload.clientIp ?? 'global').trim() || 'global';
  if (payload.action !== 'verify_role_pin') {
    const pin = String(payload.adminPin ?? '').trim();
    if (!pin) {
      return { ok: false, error: 'PIN Admin wajib diisi untuk mengubah data.' };
    }
    if (await isClientPinLockedD1(db, clientKey)) {
      return { ok: false, error: PIN_LOCKOUT_ERROR };
    }
    if (!(await isAdminPinCached(pin))) {
      const valid = await verifyPinOnD1(db, 'OWNER_ADMIN', pin);
      if (!valid) {
        await recordPinFailureD1(db, clientKey);
        return { ok: false, error: 'PIN Admin tidak valid atau sesi telah berakhir.' };
      }
      await clearPinFailureD1(db, clientKey);
      await cacheVerifiedAdminPin(pin);
    }
  }

  const rawMutationId = typeof payload.clientMutationId === 'string' ? payload.clientMutationId.trim() : '';
  const mutationKey =
    payload.action !== 'verify_role_pin' && rawMutationId ? `${payload.action}:${rawMutationId}` : '';
  if (mutationKey) {
    const cachedMutation = await getCachedMutationResultD1(db, mutationKey);
    if (cachedMutation) {
      return { ...cachedMutation, deduplicated: true };
    }
  }

  const attachSnapshot = async (res: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let finalRes = res;
    if (res.ok && payload.includeSnapshot) {
      const snapshot = await fetchMbgSnapshotFromD1(db);
      finalRes = { ...res, snapshot };
    }
    if (finalRes.ok && mutationKey) {
      await recordCompletedMutationD1(db, mutationKey, finalRes);
    }
    return finalRes;
  };

  try {
    switch (payload.action) {
      case 'verify_role_pin': {
        if (await isClientPinLockedD1(db, clientKey)) {
          return { ok: false, error: PIN_LOCKOUT_ERROR };
        }
        const ok = await verifyPinOnD1(db, payload.role, payload.pin);
        if (!ok) {
          await recordPinFailureD1(db, clientKey);
          return { ok: false };
        }
        await clearPinFailureD1(db, clientKey);
        if (payload.role === 'OWNER_ADMIN') {
          await cacheVerifiedAdminPin(String(payload.pin ?? '').trim());
        }
        return { ok: true };
      }

      case 'upsert_order': {
        const kitchenId = String(payload.input.kitchen_id ?? '').trim();
        const orderDate = String(payload.orderDate ?? '').trim() || getJakartaTodayYmd();
        const lines = payload.input.lines ?? [];
        if (lines.length === 0) {
          return { ok: false, error: 'Tambahkan minimal 1 barang pada order dapur.' };
        }

        const [kitchenRes, productsRes, openOrdersRes, allDayOrdersRes] = await db.batch([
          db.prepare('SELECT * FROM kitchens WHERE id = ? LIMIT 1').bind(kitchenId),
          db.prepare('SELECT * FROM products'),
          db
            .prepare(
              `SELECT ko.* FROM kitchen_orders ko
               LEFT JOIN kitchen_invoices ki ON ki.order_id = ko.id
               WHERE ko.kitchen_id = ? AND ko.order_date = ?
                 AND COALESCE(ki.status, 'UNPAID') <> 'PAID'
                 AND NOT EXISTS (
                   SELECT 1 FROM profit_ledger_entries ple
                   WHERE ple.order_id = ko.id AND (ple.team_paid_out = 1 OR ple.coop_paid_out = 1)
                 )
               ORDER BY ko.created_at ASC LIMIT 1`
            )
            .bind(kitchenId, orderDate),
          db
            .prepare('SELECT order_code FROM kitchen_orders WHERE kitchen_id = ? AND order_date = ?')
            .bind(kitchenId, orderDate),
        ]);

        const kitchen = (kitchenRes?.results?.[0] ?? null) as KitchenRow | null;
        if (!kitchen) return { ok: false, error: 'Dapur tujuan tidak ditemukan.' };

        const productMap = new Map(
          ((productsRes?.results ?? []) as unknown as ProductRow[]).map((p) => [p.id, p])
        );

        for (const line of lines) {
          const prodId = String(line.item_id ?? '').trim();
          const prod = productMap.get(prodId);
          if (!prod) return { ok: false, error: `Barang (${prodId}) tidak ditemukan di master.` };
          const qtyKg = roundKg(line.qty_ordered_kg);
          const priceRp = Math.round(num(line.kitchen_unit_price_rp) * 100) / 100;
          const marginRp = Math.round(num(line.margin_per_kg_rp) * 100) / 100;
          if (qtyKg <= 0) return { ok: false, error: `${prod.name}: berat order (kg) harus lebih dari 0.` };
          if (priceRp <= 0) return { ok: false, error: `${prod.name}: harga dapur / kg harus lebih dari Rp 0.` };
          if (marginRp < 0) return { ok: false, error: `${prod.name}: margin per kg tidak boleh negatif.` };
          if (marginRp > priceRp) {
            return { ok: false, error: `${prod.name}: margin per kg tidak boleh melebihi harga dapur per kg.` };
          }
        }

        const existingOrder = (openOrdersRes?.results?.[0] ?? null) as KitchenOrderRow | null;
        const nowIso = new Date().toISOString();
        const stmts: D1PreparedStatementLike[] = [];
        let orderId: string;
        let orderCode: string;
        let merged = false;

        if (existingOrder) {
          merged = true;
          orderId = existingOrder.id;
          orderCode = existingOrder.order_code;
          const existingItemsRes = await db
            .prepare('SELECT product_id FROM kitchen_order_items WHERE order_id = ?')
            .bind(orderId)
            .all<{ product_id: string }>();
          const existingProdIds = new Set((existingItemsRes.results ?? []).map((r) => r.product_id));
          for (const line of lines) {
            if (existingProdIds.has(line.item_id)) {
              const prod = productMap.get(line.item_id)!;
              return { ok: false, error: `${prod.name} sudah ada pada order dapur ini.` };
            }
          }
          if (payload.input.notes && payload.input.notes.trim()) {
            stmts.push(
              db
                .prepare('UPDATE kitchen_orders SET notes = ?, updated_at = ? WHERE id = ?')
                .bind(payload.input.notes.trim(), nowIso, orderId)
            );
          }
        } else {
          const existingCodes = new Set(
            ((allDayOrdersRes?.results ?? []) as Array<{ order_code: string }>).map((r) => r.order_code)
          );
          const dateCompact = orderDate.replace(/-/g, '');
          const kitchenCompact = kitchen.code.replace(/-/g, '');
          let seq = existingCodes.size + 1;
          orderCode = `SJ-${dateCompact}-${kitchenCompact}-${String(seq).padStart(2, '0')}`;
          while (existingCodes.has(orderCode)) {
            seq++;
            orderCode = `SJ-${dateCompact}-${kitchenCompact}-${String(seq).padStart(2, '0')}`;
          }
          orderId = makeRandomId('deliv');
          stmts.push(
            db
              .prepare(
                `INSERT INTO kitchen_orders (
                  id, order_code, kitchen_id, order_date, status, bast_signed_by_name, bast_verified_at, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'BAST_VERIFIED', ?, ?, ?, ?, ?)`
              )
              .bind(
                orderId,
                orderCode,
                kitchenId,
                orderDate,
                kitchen.pic_name,
                nowIso,
                payload.input.notes?.trim() || null,
                nowIso,
                nowIso
              )
          );
        }

        for (const line of lines) {
          const prod = productMap.get(line.item_id)!;
          const qtyKg = roundKg(line.qty_ordered_kg);
          const priceRp = Math.round(num(line.kitchen_unit_price_rp) * 100) / 100;
          const marginRp = Math.round(num(line.margin_per_kg_rp) * 100) / 100;
          const itemId = makeRandomId('ditem');
          stmts.push(
            db
              .prepare(
                `INSERT INTO kitchen_order_items (
                  id, order_id, product_id, product_name_snapshot,
                  qty_ordered_kg, qty_accepted_kg, kitchen_unit_price_rp, margin_per_kg_rp,
                  is_weighed, weighed_at, shrinkage_reason, shrinkage_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)`
              )
              .bind(itemId, orderId, prod.id, prod.name, qtyKg, qtyKg, priceRp, marginRp, nowIso, nowIso, nowIso)
          );
        }

        await db.batch(stmts);
        await recalculateOrderFinancialsD1(db, orderId);

        return attachSnapshot({
          ok: true,
          order_id: orderId,
          order_code: orderCode,
          merged,
          count: lines.length,
        });
      }

      case 'update_order': {
        const orderId = String(payload.input.delivery_id ?? '').trim();
        const kitchenId = String(payload.input.kitchen_id ?? '').trim();
        const orderDate = String(payload.input.order_date ?? '').trim() || getJakartaTodayYmd();
        const lines = payload.input.lines ?? [];
        if (lines.length === 0) {
          return { ok: false, error: 'Order harus memiliki minimal 1 barang.' };
        }

        const [orderRes, kitchenRes, productsRes, prevItemsRes, paidLedgerRes] = await db.batch([
          db.prepare('SELECT * FROM kitchen_orders WHERE id = ? LIMIT 1').bind(orderId),
          db.prepare('SELECT * FROM kitchens WHERE id = ? LIMIT 1').bind(kitchenId),
          db.prepare('SELECT * FROM products'),
          db.prepare('SELECT * FROM kitchen_order_items WHERE order_id = ?').bind(orderId),
          db
            .prepare(
              'SELECT id FROM profit_ledger_entries WHERE order_id = ? AND (team_paid_out = 1 OR coop_paid_out = 1) LIMIT 1'
            )
            .bind(orderId),
        ]);

        if (!orderRes?.results?.[0]) {
          return { ok: false, error: 'Order dapur tidak ditemukan.' };
        }
        if ((paidLedgerRes?.results ?? []).length > 0) {
          return {
            ok: false,
            error: 'Bagi hasil untuk order ini sudah dicairkan — order dan invoice tidak dapat diubah.',
          };
        }
        const kitchen = (kitchenRes?.results?.[0] ?? null) as KitchenRow | null;
        if (!kitchen) {
          return { ok: false, error: 'Dapur tujuan tidak ditemukan.' };
        }

        const productMap = new Map(
          ((productsRes?.results ?? []) as unknown as ProductRow[]).map((p) => [p.id, p])
        );
        const prevItemMap = new Map(
          ((prevItemsRes?.results ?? []) as unknown as KitchenOrderItemRow[]).map((it) => [it.id, it])
        );

        const seenProducts = new Set<string>();
        for (const line of lines) {
          const prodId = String(line.item_id ?? '').trim();
          const prod = productMap.get(prodId);
          if (!prod) return { ok: false, error: `Barang (${prodId}) tidak ditemukan di master.` };
          if (seenProducts.has(prodId)) {
            return { ok: false, error: `${prod.name} tidak boleh duplikat dalam satu order/invoice.` };
          }
          seenProducts.add(prodId);
          const qtyKg = roundKg(line.qty_accepted_kg ?? line.qty_ordered_kg);
          const priceRp = Math.round(num(line.kitchen_unit_price_rp) * 100) / 100;
          const marginRp = Math.round(num(line.margin_per_kg_rp) * 100) / 100;
          if (qtyKg <= 0) return { ok: false, error: `${prod.name}: berat (kg) harus lebih dari 0.` };
          if (priceRp <= 0) return { ok: false, error: `${prod.name}: harga dapur / kg harus lebih dari Rp 0.` };
          if (marginRp < 0) return { ok: false, error: `${prod.name}: margin / kg tidak boleh negatif.` };
          if (marginRp > priceRp) {
            return { ok: false, error: `${prod.name}: margin / kg tidak boleh melebihi harga dapur / kg.` };
          }
        }

        const nowIso = new Date().toISOString();
        const stmts: D1PreparedStatementLike[] = [
          db
            .prepare('UPDATE kitchen_orders SET kitchen_id = ?, order_date = ?, updated_at = ? WHERE id = ?')
            .bind(kitchenId, orderDate, nowIso, orderId),
        ];

        const keptItemIds = new Set<string>();
        for (const line of lines) {
          const prod = productMap.get(line.item_id)!;
          const acceptedKg = roundKg(line.qty_accepted_kg ?? line.qty_ordered_kg);
          let orderedKg = roundKg(line.qty_ordered_kg ?? acceptedKg);
          const priceRp = Math.round(num(line.kitchen_unit_price_rp) * 100) / 100;
          const marginRp = Math.round(num(line.margin_per_kg_rp) * 100) / 100;
          const prev = line.id ? prevItemMap.get(line.id) : undefined;

          if (prev) {
            keptItemIds.add(prev.id);
            const prevAccepted =
              prev.qty_accepted_kg != null ? roundKg(prev.qty_accepted_kg) : roundKg(prev.qty_ordered_kg);
            if (prev.product_id === prod.id && prevAccepted === acceptedKg) {
              orderedKg = Math.max(roundKg(prev.qty_ordered_kg), acceptedKg);
              stmts.push(
                db
                  .prepare(
                    `UPDATE kitchen_order_items
                     SET kitchen_unit_price_rp = ?, margin_per_kg_rp = ?,
                         qty_ordered_kg = ?, qty_accepted_kg = ?,
                         is_weighed = 1, weighed_at = COALESCE(weighed_at, ?), updated_at = ?
                     WHERE id = ? AND order_id = ?`
                  )
                  .bind(priceRp, marginRp, orderedKg, acceptedKg, nowIso, nowIso, prev.id, orderId)
              );
            } else {
              orderedKg = Math.max(orderedKg, acceptedKg);
              const shrinkReason = orderedKg > acceptedKg ? prev.shrinkage_reason ?? 'Susut' : null;
              const shrinkNote = orderedKg > acceptedKg ? prev.shrinkage_note ?? null : null;
              stmts.push(
                db
                  .prepare(
                    `UPDATE kitchen_order_items
                     SET product_id = ?, product_name_snapshot = ?,
                         qty_ordered_kg = ?, qty_accepted_kg = ?,
                         kitchen_unit_price_rp = ?, margin_per_kg_rp = ?,
                         is_weighed = 1, weighed_at = COALESCE(weighed_at, ?),
                         shrinkage_reason = ?, shrinkage_note = ?, updated_at = ?
                     WHERE id = ? AND order_id = ?`
                  )
                  .bind(
                    prod.id,
                    prod.name,
                    orderedKg,
                    acceptedKg,
                    priceRp,
                    marginRp,
                    nowIso,
                    shrinkReason,
                    shrinkNote,
                    nowIso,
                    prev.id,
                    orderId
                  )
              );
            }
          } else {
            orderedKg = Math.max(orderedKg, acceptedKg);
            const newId = makeRandomId('ditem');
            keptItemIds.add(newId);
            stmts.push(
              db
                .prepare(
                  `INSERT INTO kitchen_order_items (
                    id, order_id, product_id, product_name_snapshot,
                    qty_ordered_kg, qty_accepted_kg, kitchen_unit_price_rp, margin_per_kg_rp,
                    is_weighed, weighed_at, shrinkage_reason, shrinkage_note, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)`
                )
                .bind(newId, orderId, prod.id, prod.name, orderedKg, acceptedKg, priceRp, marginRp, nowIso, nowIso, nowIso)
            );
          }
        }

        for (const prevId of prevItemMap.keys()) {
          if (!keptItemIds.has(prevId)) {
            stmts.push(
              db.prepare('DELETE FROM kitchen_order_items WHERE id = ? AND order_id = ?').bind(prevId, orderId)
            );
          }
        }

        await db.batch(stmts);
        await recalculateOrderFinancialsD1(db, orderId);

        return attachSnapshot({
          ok: true,
          order_id: orderId,
          count: lines.length,
        });
      }

      case 'mark_invoice_paid': {
        const inv = await db
          .prepare('SELECT * FROM kitchen_invoices WHERE id = ? LIMIT 1')
          .bind(payload.invoiceId)
          .first<KitchenInvoiceRow>();
        if (!inv) {
          return { ok: false, error: 'Invoice dapur tidak ditemukan.' };
        }
        if (inv.status === 'PAID') {
          return attachSnapshot({ ok: true });
        }

        const nowIso = new Date().toISOString();
        await db.batch([
          db
            .prepare(
              `UPDATE kitchen_order_items
               SET qty_accepted_kg = COALESCE(qty_accepted_kg, qty_ordered_kg),
                   is_weighed = 1,
                   weighed_at = COALESCE(weighed_at, ?),
                   updated_at = ?
               WHERE order_id = ? AND (is_weighed = 0 OR qty_accepted_kg IS NULL)`
            )
            .bind(nowIso, nowIso, inv.order_id),
        ]);

        await recalculateOrderFinancialsD1(db, inv.order_id);

        const refreshedInv = await db
          .prepare('SELECT * FROM kitchen_invoices WHERE id = ? LIMIT 1')
          .bind(payload.invoiceId)
          .first<KitchenInvoiceRow>();
        const totalAmountRp = num(refreshedInv?.total_amount_rp ?? inv.total_amount_rp);
        if (totalAmountRp <= 0) {
          return { ok: false, error: 'Total tagihan Rp 0 tidak dapat ditandai lunas.' };
        }

        await db.batch([
          db
            .prepare(
              `UPDATE kitchen_invoices
               SET status = 'PAID', amount_paid_rp = total_amount_rp, paid_at = COALESCE(paid_at, ?), updated_at = ?
               WHERE id = ?`
            )
            .bind(nowIso, nowIso, payload.invoiceId),
          db
            .prepare(
              `UPDATE profit_ledger_entries
               SET status = CASE WHEN team_paid_out = 1 AND coop_paid_out = 1 THEN 'PAID_OUT' ELSE 'AVAILABLE_FOR_PAYOUT' END,
                   unlocked_at = COALESCE(unlocked_at, ?),
                   updated_at = ?
               WHERE invoice_id = ?`
            )
            .bind(nowIso, nowIso, payload.invoiceId),
        ]);

        return attachSnapshot({ ok: true });
      }

      case 'execute_payout': {
        const rawTarget = String(payload.target ?? '').trim().toUpperCase();
        const target = rawTarget === 'ALL' ? 'BOTH' : rawTarget;
        if (target !== 'TEAM' && target !== 'COOPERATIVE' && target !== 'BOTH') {
          return { ok: false, error: 'Target pencairan harus TEAM, COOPERATIVE, atau BOTH.' };
        }

        const [entriesRes, batchesRes] = await db.batch([
          db.prepare("SELECT * FROM profit_ledger_entries WHERE status = 'AVAILABLE_FOR_PAYOUT'"),
          db.prepare('SELECT payout_reference FROM profit_payout_batches'),
        ]);

        const entries = (entriesRes?.results ?? []) as unknown as ProfitLedgerRow[];
        const existingRefs = new Set(
          ((batchesRes?.results ?? []) as Array<{ payout_reference: string }>).map((b) => b.payout_reference)
        );
        const filterSet =
          payload.entryIds && payload.entryIds.length > 0 ? new Set(payload.entryIds) : null;

        const matchesFilter = (le: ProfitLedgerRow) =>
          !filterSet ||
          filterSet.has(le.id) ||
          filterSet.has(`${le.id}-team`) ||
          filterSet.has(`${le.id}-coop`) ||
          (le.order_item_id !== null &&
            le.order_item_id !== undefined &&
            filterSet.has(le.order_item_id));

        const nowIso = new Date().toISOString();
        const todayCompact = getJakartaTodayYmd().replace(/-/g, '');
        const stmts: D1PreparedStatementLike[] = [];
        let totalCount = 0;
        let totalPayoutSen = 0n;
        let seq = existingRefs.size + 1;

        if (target === 'TEAM' || target === 'BOTH') {
          const teamEligible = entries.filter((le) => !Boolean(le.team_paid_out) && matchesFilter(le));
          let teamSen = 0n;
          for (const le of teamEligible) teamSen += idrToSen(num(le.team_amount_rp));
          const teamTotalRp = senToIdr(teamSen);

          if (teamEligible.length > 0 && teamTotalRp > 0) {
            let teamRef = `POUT-${todayCompact}-TIM-${String(seq).padStart(2, '0')}`;
            while (existingRefs.has(teamRef)) {
              seq++;
              teamRef = `POUT-${todayCompact}-TIM-${String(seq).padStart(2, '0')}`;
            }
            existingRefs.add(teamRef);
            seq++;
            const batchId = makeRandomId('pbatch-team');
            stmts.push(
              db
                .prepare(
                  `INSERT INTO profit_payout_batches (
                    id, payout_reference, beneficiary_type, total_payout_amount,
                    transfer_proof_url, notes, disbursed_by, disbursed_at, created_at
                  ) VALUES (?, ?, 'TEAM', ?, ?, ?, 'user-admin-01', ?, ?)`
                )
                .bind(
                  batchId,
                  teamRef,
                  teamTotalRp,
                  `https://storage.mbg.id/payouts/${teamRef.toLowerCase()}.jpg`,
                  `Pencairan bagi hasil Tim (${teamEligible.length} baris)`,
                  nowIso,
                  nowIso
                )
            );

            for (const le of teamEligible) {
              const bothPaid = Boolean(le.coop_paid_out) || target === 'BOTH';
              stmts.push(
                db
                  .prepare(
                    `UPDATE profit_ledger_entries
                     SET team_paid_out = 1, team_paid_out_at = ?, team_payout_batch_id = ?,
                         paid_out_at = ?, status = ?, updated_at = ?
                     WHERE id = ?`
                  )
                  .bind(
                    nowIso,
                    batchId,
                    nowIso,
                    bothPaid ? 'PAID_OUT' : 'AVAILABLE_FOR_PAYOUT',
                    nowIso,
                    le.id
                  )
              );
            }
            totalCount += teamEligible.length;
            totalPayoutSen += teamSen;
          }
        }

        if (target === 'COOPERATIVE' || target === 'BOTH') {
          const coopEligible = entries.filter((le) => !Boolean(le.coop_paid_out) && matchesFilter(le));
          let coopSen = 0n;
          for (const le of coopEligible) coopSen += idrToSen(num(le.coop_amount_rp));
          const coopTotalRp = senToIdr(coopSen);

          if (coopEligible.length > 0 && coopTotalRp > 0) {
            let coopRef = `POUT-${todayCompact}-KOP-${String(seq).padStart(2, '0')}`;
            while (existingRefs.has(coopRef)) {
              seq++;
              coopRef = `POUT-${todayCompact}-KOP-${String(seq).padStart(2, '0')}`;
            }
            existingRefs.add(coopRef);
            seq++;
            const batchId = makeRandomId('pbatch-coop');
            stmts.push(
              db
                .prepare(
                  `INSERT INTO profit_payout_batches (
                    id, payout_reference, beneficiary_type, total_payout_amount,
                    transfer_proof_url, notes, disbursed_by, disbursed_at, created_at
                  ) VALUES (?, ?, 'COOPERATIVE', ?, ?, ?, 'user-admin-01', ?, ?)`
                )
                .bind(
                  batchId,
                  coopRef,
                  coopTotalRp,
                  `https://storage.mbg.id/payouts/${coopRef.toLowerCase()}.jpg`,
                  `Pencairan bagi hasil Koperasi (${coopEligible.length} baris)`,
                  nowIso,
                  nowIso
                )
            );

            for (const le of coopEligible) {
              const bothPaid = Boolean(le.team_paid_out) || target === 'BOTH';
              stmts.push(
                db
                  .prepare(
                    `UPDATE profit_ledger_entries
                     SET coop_paid_out = 1, coop_paid_out_at = ?, coop_payout_batch_id = ?,
                         paid_out_at = ?, status = ?, updated_at = ?
                     WHERE id = ?`
                  )
                  .bind(
                    nowIso,
                    batchId,
                    nowIso,
                    bothPaid ? 'PAID_OUT' : 'AVAILABLE_FOR_PAYOUT',
                    nowIso,
                    le.id
                  )
              );
            }
            totalCount += coopEligible.length;
            totalPayoutSen += coopSen;
          }
        }

        if (stmts.length > 0) {
          await db.batch(stmts);
        }

        return attachSnapshot({
          ok: true,
          count: totalCount,
          total_payout_rp: senToIdr(totalPayoutSen),
        });
      }

      case 'update_app_settings': {
        const p = payload.params;
        const teamPct = Math.round(num(p.teamSharePct) * 100) / 100;
        const coopPct = Math.round(num(p.coopSharePct) * 100) / 100;
        const teamBp = pctToBasisPoints(teamPct);
        const coopBp = pctToBasisPoints(coopPct);
        if (teamBp < 0n || coopBp < 0n || teamBp + coopBp !== 10000n) {
          return { ok: false, error: 'Total persentase bagi hasil Tim + Koperasi harus tepat 100%.' };
        }

        const [currentRes, openLedgersRes] = await db.batch([
          db.prepare("SELECT * FROM app_settings WHERE id = 'default' LIMIT 1"),
          db.prepare(
            `SELECT id, gross_margin_rp FROM profit_ledger_entries ple
             WHERE ple.team_paid_out = 0 AND ple.coop_paid_out = 0
               AND NOT EXISTS (
                 SELECT 1 FROM profit_ledger_entries p2
                 WHERE p2.order_id = ple.order_id AND (p2.team_paid_out = 1 OR p2.coop_paid_out = 1)
               )`
          ),
        ]);

        const current = (currentRes?.results?.[0] ?? null) as AppSettingsRow | null;
        const openLedgers = (openLedgersRes?.results ?? []) as Array<{
          id: string;
          gross_margin_rp: number;
        }>;

        const supplierName = (p.supplierName ?? current?.supplier_name ?? '').trim() || DEFAULT_PAYMENT_INFO.supplier_name;
        const bankName = (p.bankName ?? current?.payment_bank_name ?? '').trim() || DEFAULT_PAYMENT_INFO.payment_bank_name;
        const accountNumber =
          (p.accountNumber ?? current?.payment_account_number ?? '').trim() ||
          DEFAULT_PAYMENT_INFO.payment_account_number;
        const accountHolder =
          (p.accountHolder ?? current?.payment_account_holder ?? '').trim() ||
          DEFAULT_PAYMENT_INFO.payment_account_holder;
        const nowIso = new Date().toISOString();

        const stmts: D1PreparedStatementLike[] = [
          db
            .prepare(
              `INSERT INTO app_settings (
                id, team_share_pct, coop_share_pct, supplier_name,
                payment_bank_name, payment_account_number, payment_account_holder,
                admin_pin, coop_pin, updated_at
              ) VALUES ('default', ?, ?, ?, ?, ?, ?, '', '', ?)
              ON CONFLICT (id) DO UPDATE SET
                team_share_pct = excluded.team_share_pct,
                coop_share_pct = excluded.coop_share_pct,
                supplier_name = excluded.supplier_name,
                payment_bank_name = excluded.payment_bank_name,
                payment_account_number = excluded.payment_account_number,
                payment_account_holder = excluded.payment_account_holder,
                admin_pin = '',
                coop_pin = '',
                updated_at = excluded.updated_at`
            )
            .bind(teamPct, coopPct, supplierName, bankName, accountNumber, accountHolder, nowIso),
          db
            .prepare(
              `UPDATE kitchen_invoices
               SET supplier_name = ?, payment_bank_name = ?, payment_account_number = ?, payment_account_holder = ?, updated_at = ?
               WHERE status <> 'PAID'`
            )
            .bind(supplierName, bankName, accountNumber, accountHolder, nowIso),
        ];

        for (const le of openLedgers) {
          const grossSen = idrToSen(Math.max(0, num(le.gross_margin_rp)));
          const coopSen = divideHalfUp(grossSen * coopBp, 10000n);
          const teamSen = grossSen - coopSen;
          stmts.push(
            db
              .prepare(
                `UPDATE profit_ledger_entries
                 SET team_share_pct = ?, coop_share_pct = ?,
                     team_amount_rp = ?, coop_amount_rp = ?, updated_at = ?
                 WHERE id = ?`
              )
              .bind(teamPct, coopPct, senToIdr(teamSen), senToIdr(coopSen), nowIso, le.id)
          );
        }

        await db.batch(stmts);
        return attachSnapshot({ ok: true });
      }

      case 'delete_order_item': {
        const item = await db
          .prepare('SELECT * FROM kitchen_order_items WHERE id = ? LIMIT 1')
          .bind(payload.itemId)
          .first<KitchenOrderItemRow>();
        if (!item) {
          return { ok: false, error: 'Baris order tidak ditemukan.' };
        }

        const [paidLedger, siblingItemsRes, inv] = await Promise.all([
          db
            .prepare(
              'SELECT id FROM profit_ledger_entries WHERE (order_item_id = ? OR order_id = ?) AND (team_paid_out = 1 OR coop_paid_out = 1) LIMIT 1'
            )
            .bind(item.id, item.order_id)
            .first<{ id: string }>(),
          db
            .prepare('SELECT id FROM kitchen_order_items WHERE order_id = ? AND id <> ?')
            .bind(item.order_id, item.id)
            .all<{ id: string }>(),
          db
            .prepare('SELECT status FROM kitchen_invoices WHERE order_id = ? LIMIT 1')
            .bind(item.order_id)
            .first<{ status: string }>(),
        ]);

        if (paidLedger) {
          return {
            ok: false,
            error: 'Bagi hasil untuk order ini sudah dicairkan — baris barang tidak dapat diubah atau dihapus.',
          };
        }
        if (inv?.status === 'PAID' && (siblingItemsRes.results ?? []).length === 0) {
          return { ok: false, error: 'Order dengan invoice lunas harus memiliki minimal 1 barang.' };
        }

        await db.batch([
          db.prepare('DELETE FROM profit_ledger_entries WHERE order_item_id = ?').bind(item.id),
          db.prepare('DELETE FROM kitchen_order_items WHERE id = ?').bind(item.id),
        ]);
        await recalculateOrderFinancialsD1(db, item.order_id);
        await reconcilePayoutBatchesD1(db);
        return attachSnapshot({ ok: true });
      }

      case 'delete_order': {
        const order = await db
          .prepare('SELECT id FROM kitchen_orders WHERE id = ? LIMIT 1')
          .bind(payload.orderId)
          .first<{ id: string }>();
        if (!order) {
          return { ok: false, error: 'Order / invoice tidak ditemukan.' };
        }

        await db.batch([
          db.prepare('DELETE FROM profit_ledger_entries WHERE order_id = ?').bind(payload.orderId),
          db.prepare('DELETE FROM kitchen_invoices WHERE order_id = ?').bind(payload.orderId),
          db.prepare('DELETE FROM kitchen_order_items WHERE order_id = ?').bind(payload.orderId),
          db.prepare('DELETE FROM kitchen_orders WHERE id = ?').bind(payload.orderId),
        ]);
        await reconcilePayoutBatchesD1(db);
        return attachSnapshot({ ok: true });
      }

      case 'upsert_kitchen': {
        const k = payload.kitchen;
        await db
          .prepare(
            `INSERT INTO kitchens (
              id, code, name, address, pic_name, pic_phone, default_markup_per_kg, is_active, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              code = excluded.code,
              name = excluded.name,
              address = excluded.address,
              pic_name = excluded.pic_name,
              pic_phone = excluded.pic_phone,
              default_markup_per_kg = excluded.default_markup_per_kg,
              is_active = excluded.is_active`
          )
          .bind(
            k.id,
            k.kitchen_code,
            k.name,
            k.address,
            k.pic_name,
            k.pic_phone,
            k.default_markup_per_kg,
            k.is_active ? 1 : 0,
            k.created_at
          )
          .run();
        return attachSnapshot({ ok: true });
      }

      case 'upsert_product': {
        const it = payload.item;
        await db
          .prepare(
            `INSERT INTO products (
              id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              code = excluded.code,
              name = excluded.name,
              category = excluded.category,
              default_kitchen_price_rp = excluded.default_kitchen_price_rp,
              default_margin_per_kg_rp = excluded.default_margin_per_kg_rp,
              is_active = excluded.is_active`
          )
          .bind(
            it.id,
            it.sku,
            it.name,
            it.category,
            it.default_kitchen_price_per_kg,
            it.default_margin_per_kg,
            it.is_active ? 1 : 0,
            it.created_at
          )
          .run();
        return attachSnapshot({ ok: true });
      }

      case 'delete_kitchen': {
        const used = await db
          .prepare('SELECT id FROM kitchen_orders WHERE kitchen_id = ? LIMIT 1')
          .bind(payload.kitchenId)
          .first<{ id: string }>();
        if (used) {
          return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki histori order.' };
        }
        await db.prepare('DELETE FROM kitchens WHERE id = ?').bind(payload.kitchenId).run();
        return attachSnapshot({ ok: true });
      }

      case 'delete_product': {
        const used = await db
          .prepare('SELECT id FROM kitchen_order_items WHERE product_id = ? LIMIT 1')
          .bind(payload.productId)
          .first<{ id: string }>();
        if (used) {
          return { ok: false, error: 'Barang tidak dapat dihapus karena masih digunakan di order dapur.' };
        }
        await db.prepare('DELETE FROM products WHERE id = ?').bind(payload.productId).run();
        return attachSnapshot({ ok: true });
      }

      default: {
        const unknownAction = String((payload as { action?: unknown }).action ?? '');
        return { ok: false, error: `Aksi tidak dikenal: ${unknownAction}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Gagal memproses mutasi pada Cloudflare D1.',
    };
  }
}

/**
 * Executes an RPC or table mutation over Cloudflare D1 (`env.DB`) in production,
 * or over a provided `sqlFactory` in SQL unit tests.
 */
export async function executeHyperdriveAction(
  payload: HyperdriveActionPayload,
  env?: HyperdriveEnv,
  sqlFactory?: (connStr: string) => Sql
): Promise<Record<string, unknown>> {
  const d1 = resolveD1Database(env);
  if (d1 && !sqlFactory) {
    return executeD1Action(d1, payload);
  }

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
        if (!useEdgePinCache || !(await isAdminPinCached(pin))) {
          const pinRows = await sql<Array<{ res: { ok?: boolean } }>>`
            SELECT public.rpc_verify_role_pin('OWNER_ADMIN', ${pin}::text) AS res
          `;
          if (!pinRows[0]?.res?.ok) {
            recordPinFailure(clientKey);
            return { ok: false, error: 'PIN Admin tidak valid atau sesi telah berakhir.' };
          }
          pinFailuresByClient.delete(clientKey);
          if (useEdgePinCache) await cacheVerifiedAdminPin(pin);
        }
      }

      const rawMutationId = typeof payload.clientMutationId === 'string' ? payload.clientMutationId.trim() : '';
      const mutationKey =
        payload.action !== 'verify_role_pin' && rawMutationId ? `${payload.action}:${rawMutationId}` : '';
      if (mutationKey) {
        const cachedMutation = getCachedMutationResult(mutationKey);
        if (cachedMutation) {
          return { ...cachedMutation, deduplicated: true };
        }
      }

      const attachSnapshot = async (res: Record<string, unknown>): Promise<Record<string, unknown>> => {
        let finalRes = res;
        if (res.ok && payload.includeSnapshot) {
          const snapshot = await fetchMbgSnapshotFromSql(sql);
          finalRes = { ...res, snapshot };
        }
        if (finalRes.ok && mutationKey) {
          recordCompletedMutation(mutationKey, finalRes);
        }
        return finalRes;
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
              ${sql.json ? sql.json(itemsJson) : itemsJson}::jsonb,
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
              ${sql.json ? sql.json(itemsJson) : itemsJson}::jsonb
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
              ${entryIds ? (sql.array ? sql.array(entryIds) : entryIds) : null}::text[]
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
            RETURNING oi.id
          `;
          if (deleted.length === 0) {
            return { ok: false, error: 'Baris order tidak ditemukan.' };
          }
          await sql`SELECT public.fn_reconcile_payout_batches()`;
          return attachSnapshot({ ok: true });
        }

        case 'delete_order': {
          const deleted = await sql<Array<{ id: string }>>`
            DELETE FROM public.kitchen_orders o
            WHERE o.id = ${payload.orderId}
            RETURNING o.id
          `;
          if (!deleted || deleted.length === 0) {
            return { ok: false, error: 'Order / invoice tidak ditemukan.' };
          }
          await sql`SELECT public.fn_reconcile_payout_batches()`;
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
            await cacheVerifiedAdminPin(String(payload.pin ?? '').trim());
          }
          return { ok: true };
        }

        default: {
          const unknownAction = String((payload as { action?: unknown }).action ?? '');
          return { ok: false, error: `Aksi tidak dikenal: ${unknownAction}` };
        }
      }
    },
    env,
    sqlFactory
  );
}
