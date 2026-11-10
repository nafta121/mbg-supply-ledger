-- =============================================================================
-- Migration: 0001_d1_schema.sql
-- Purpose  : 100% Full Cloudflare D1 (SQLite) relational schema and production
--            master data seed for MBG Supply Chain & Profit-Sharing Ledger.
-- =============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kitchens (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT DEFAULT '-',
  pic_name TEXT NOT NULL,
  pic_phone TEXT NOT NULL,
  default_markup_per_kg NUMERIC NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Lainnya',
  default_kitchen_price_rp NUMERIC NOT NULL DEFAULT 0,
  default_margin_per_kg_rp NUMERIC NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS kitchen_orders (
  id TEXT PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE RESTRICT,
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BAST_VERIFIED',
  bast_signed_by_name TEXT,
  bast_verified_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_kitchen_orders_kitchen_date ON kitchen_orders(kitchen_id, order_date);
CREATE INDEX IF NOT EXISTS idx_kitchen_orders_created_at ON kitchen_orders(created_at DESC);

CREATE TABLE IF NOT EXISTS kitchen_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES kitchen_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot TEXT NOT NULL,
  qty_ordered_kg NUMERIC NOT NULL,
  qty_accepted_kg NUMERIC,
  kitchen_unit_price_rp NUMERIC NOT NULL,
  margin_per_kg_rp NUMERIC NOT NULL,
  is_weighed INTEGER NOT NULL DEFAULT 1,
  weighed_at TEXT,
  shrinkage_reason TEXT,
  shrinkage_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON kitchen_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON kitchen_order_items(product_id);

CREATE TABLE IF NOT EXISTS kitchen_invoices (
  id TEXT PRIMARY KEY,
  invoice_code TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL UNIQUE REFERENCES kitchen_orders(id) ON DELETE CASCADE,
  kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE RESTRICT,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  total_amount_rp NUMERIC NOT NULL DEFAULT 0,
  amount_paid_rp NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'UNPAID',
  paid_at TEXT,
  supplier_name TEXT,
  payment_bank_name TEXT,
  payment_account_number TEXT,
  payment_account_holder TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON kitchen_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON kitchen_invoices(created_at DESC);

CREATE TABLE IF NOT EXISTS profit_payout_batches (
  id TEXT PRIMARY KEY,
  payout_reference TEXT NOT NULL UNIQUE,
  beneficiary_type TEXT NOT NULL,
  total_payout_amount NUMERIC NOT NULL DEFAULT 0,
  transfer_proof_url TEXT NOT NULL,
  notes TEXT,
  disbursed_by TEXT NOT NULL,
  disbursed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payout_batches_disbursed_at ON profit_payout_batches(disbursed_at DESC);

CREATE TABLE IF NOT EXISTS profit_ledger_entries (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES kitchen_invoices(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES kitchen_orders(id) ON DELETE CASCADE,
  order_item_id TEXT REFERENCES kitchen_order_items(id) ON DELETE CASCADE,
  kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE RESTRICT,
  gross_margin_rp NUMERIC NOT NULL DEFAULT 0,
  team_share_pct NUMERIC NOT NULL DEFAULT 60,
  coop_share_pct NUMERIC NOT NULL DEFAULT 40,
  team_amount_rp NUMERIC NOT NULL DEFAULT 0,
  coop_amount_rp NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'LOCKED_UNPAID',
  team_paid_out INTEGER NOT NULL DEFAULT 0,
  coop_paid_out INTEGER NOT NULL DEFAULT 0,
  team_payout_batch_id TEXT,
  coop_payout_batch_id TEXT,
  team_paid_out_at TEXT,
  coop_paid_out_at TEXT,
  unlocked_at TEXT,
  paid_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_order_id ON profit_ledger_entries(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice_id ON profit_ledger_entries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order_item_id ON profit_ledger_entries(order_item_id);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON profit_ledger_entries(status);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  team_share_pct NUMERIC NOT NULL DEFAULT 60,
  coop_share_pct NUMERIC NOT NULL DEFAULT 40,
  supplier_name TEXT NOT NULL DEFAULT 'Megah Sayur',
  payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
  payment_account_number TEXT NOT NULL DEFAULT '3888 0100 5597 504',
  payment_account_holder TEXT NOT NULL DEFAULT 'Yoga Eko Setiawan',
  admin_pin TEXT NOT NULL DEFAULT '',
  coop_pin TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS role_credentials (
  role TEXT PRIMARY KEY,
  pin_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS security_rate_limits (
  client_key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  reset_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mutation_idempotency_log (
  mutation_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_expires ON mutation_idempotency_log(expires_at_ms);

-- Seed role credentials (salted SHA-256 of `<ROLE>:mbg-pin-v1:<PIN>` for default PINs 1122 and 3344)
INSERT OR REPLACE INTO role_credentials (role, pin_sha256, updated_at) VALUES ('OWNER_ADMIN', '65fbd296a1ae8adde6f7340794abb06caa642dc0623c12b8a199d70d4b6265aa', '2026-11-06T12:00:00.000Z');
INSERT OR REPLACE INTO role_credentials (role, pin_sha256, updated_at) VALUES ('COOPERATIVE_VIEWER', '3679bb403222966183d744b3679589c8823dd3bdb739d8a15f85d5cd8d97db6a', '2026-11-06T12:00:00.000Z');

-- Seed app_settings from production snapshot (plaintext PIN columns left blank)
INSERT OR REPLACE INTO app_settings (id, team_share_pct, coop_share_pct, supplier_name, payment_bank_name, payment_account_number, payment_account_holder, admin_pin, coop_pin, updated_at) VALUES ('default', 60, 40, 'Megah Sayur', 'BRI', '3888 0100 5597 504', 'Yoga Eko Setiawan', '', '', '2026-10-16T06:00:00.000Z');

-- Seed kitchens from production snapshot
INSERT OR REPLACE INTO kitchens (id, code, name, address, pic_name, pic_phone, default_markup_per_kg, is_active, created_at) VALUES ('kitchen-dpr-01-1792237194215', 'DPR-01', 'Sppg katikan', 'Katikan Kedunggalar ngawi', 'Muklis', '+62 858-0100-6617', 0, 1, '2026-10-17T11:39:54.21+00:00');

-- Seed products from production snapshot
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm01-kg-1792237271945', 'ITM01-KG', 'Wortel', 'Sayur', 16500, 2000, 1, '2026-10-17T11:41:11.945+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm02-kg-1792237299564', 'ITM02-KG', 'Kubis', 'Sayur', 14000, 2000, 1, '2026-10-17T11:41:39.564+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm03-kg-1792237363066', 'ITM03-KG', 'Buncis', 'Sayur', 0, 0, 1, '2026-10-17T11:42:43.066+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm04-kg-1792672134425', 'ITM04-KG', 'Timun', 'Buah', 16500, 2000, 1, '2026-10-22T12:28:54.419+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm05-kg-1792672185513', 'ITM05-KG', 'Cabai kembung hijau', 'Sayur', 45000, 2000, 1, '2026-10-22T12:29:45.512+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm06-kg-1792672217621', 'ITM06-KG', 'Cabai kembung merah', 'Sayur', 59000, 2000, 1, '2026-10-22T12:30:17.621+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm07-kg-1792931726920', 'ITM07-KG', 'Asem jawa', 'Sayur', 49000, 2000, 1, '2026-10-25T12:35:26.916+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm08-kg-1792931794751', 'ITM08-KG', 'Cabai keriting', 'Sayur', 64000, 2000, 1, '2026-10-25T12:36:34.751+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm09-kg-1792931930306', 'ITM09-KG', 'Daun jeruk', 'Sayur', 85000, 2000, 1, '2026-10-25T12:38:50.306+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm10-kg-1792931953373', 'ITM10-KG', 'Daun salam', 'Sayur', 17000, 2000, 1, '2026-10-25T12:39:13.373+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm11-kg-1792931989204', 'ITM11-KG', 'Gula merah', 'Gula', 23000, 2000, 1, '2026-10-25T12:39:49.204+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm12-kg-1792932018809', 'ITM12-KG', 'Bawang bombay', 'Sayur', 33000, 2000, 1, '2026-10-25T12:40:18.809+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm13-kg-1792932034158', 'ITM13-KG', 'Daun bawang', 'Sayur', 20000, 2000, 1, '2026-10-25T12:40:34.158+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm14-kg-1792932083605', 'ITM14-KG', 'Jahe', 'Rempah', 39000, 2000, 1, '2026-10-25T12:41:23.605+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm15-kg-1792932113268', 'ITM15-KG', 'Kentang isi 5', 'Umbi', 19000, 2000, 1, '2026-10-25T12:41:53.268+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm16-kg-1792932131960', 'ITM16-KG', 'Ketumbar', 'Rempah', 40000, 2000, 1, '2026-10-25T12:42:11.96+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm17-kg-1792932148454', 'ITM17-KG', 'Kunyit', 'Rempah', 19000, 2000, 1, '2026-10-25T12:42:28.454+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm18-kg-1792932201572', 'ITM18-KG', 'Lada bulat', 'Rempah', 179000, 2000, 1, '2026-10-25T12:43:21.572+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm19-kg-1792932242125', 'ITM19-KG', 'Lengkuas', 'Rempah', 12000, 2000, 1, '2026-10-25T12:44:02.125+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm20-kg-1792932258600', 'ITM20-KG', 'Daun sereh', 'Rempah', 20000, 2000, 1, '2026-10-25T12:44:18.6+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm21-kg-1793060547173', 'ITM21-KG', 'Capar kedelai', 'Sayur', 25000, 2000, 1, '2026-10-27T00:22:27.169+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm22-kg-1793060589542', 'ITM22-KG', 'Jepan/labu siem', 'Sayur', 14000, 2000, 1, '2026-10-27T00:23:09.542+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm23-kg-1793060622620', 'ITM23-KG', 'Daun melinjo', 'Sayur', 36000, 2000, 1, '2026-10-27T00:23:42.62+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm24-kg-1793180976451', 'ITM24-KG', 'Kembang kol', 'Sayur', 24000, 2000, 1, '2026-10-28T09:49:36.446+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm25-kg-1793181012172', 'ITM25-KG', 'Sawi putih', 'Sayur', 15500, 2000, 1, '2026-10-28T09:50:12.172+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm26-kg-1793549499153', 'ITM26-KG', 'Bawang merah', 'Bumbu', 32000, 2000, 1, '2026-11-01T16:11:39.145+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm27-kg-1793549519471', 'ITM27-KG', 'Bawang putih', 'Bumbu', 32000, 2000, 1, '2026-11-01T16:11:59.471+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm28-kg-1793549583624', 'ITM28-KG', 'Temu kunci', 'Rempah', 19000, 2000, 1, '2026-11-01T16:13:03.624+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm29-kg-1793549857463', 'ITM29-KG', 'Jeruk nipis', 'Buah', 42000, 2000, 1, '2026-11-01T16:17:37.463+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm30-kg-1793622825772', 'ITM30-KG', 'Daun ubi jalar', 'Sayur', 14000, 2000, 1, '2026-11-02T12:33:45.766+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm31-kg-1793622854331', 'ITM31-KG', 'Gambas', 'Sayur', 17000, 2000, 1, '2026-11-02T12:34:14.331+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm32-kg-1793793845495', 'ITM32-KG', 'Kemangi', 'Sayur', 26500, 2000, 1, '2026-11-04T12:04:05.486+00:00');
INSERT OR REPLACE INTO products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES ('item-itm33-kg-1793884498016', 'ITM33-KG', 'Daun seledri', 'Sayur', 21000, 2000, 1, '2026-11-05T13:14:58.009+00:00');
