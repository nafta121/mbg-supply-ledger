-- =============================================================================
-- Migration: 0005_order_driven_supabase_sync.sql
-- Project  : MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger (Stage 8)
-- Ref      : nrdepkayabbbshnmyrvc
-- Purpose  : Order-Driven by Kitchen Schema (Tanpa Stok Batch Supplier),
--            INTEGER kilogram bulat (Invariant 1), NUMERIC(15,2) IDR,
--            v_courier_kitchen_orders & v_safe_delivery_items_bast (Invariant 5),
--            Realtime publication, RLS policies, and initial seed data.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. CORE ORDER-DRIVEN TABLES (Backend Supabase Agent Spec)
-- =============================================================================

-- 1.1 KITCHENS (20-30 Dapur MBG / SPPG)
CREATE TABLE IF NOT EXISTS public.kitchens (
    id TEXT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    kitchen_code VARCHAR(30) GENERATED ALWAYS AS (code) STORED,
    name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL DEFAULT '-',
    pic_name VARCHAR(120) NOT NULL,
    pic_phone VARCHAR(30) NOT NULL,
    default_markup_per_kg NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (default_markup_per_kg >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.2 PRODUCTS (Master Barang — Satuan Dasar wajib 'kg', Invariant 1)
CREATE TABLE IF NOT EXISTS public.products (
    id TEXT PRIMARY KEY,
    code VARCHAR(40) UNIQUE NOT NULL,
    sku VARCHAR(40) GENERATED ALWAYS AS (code) STORED,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'Sayuran Segar',
    base_unit VARCHAR(10) NOT NULL DEFAULT 'kg' CHECK (base_unit = 'kg'),
    default_kitchen_price_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (default_kitchen_price_rp >= 0),
    default_margin_per_kg_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (default_margin_per_kg_rp >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_products_margin_le_price
        CHECK (default_margin_per_kg_rp <= default_kitchen_price_rp OR default_kitchen_price_rp = 0)
);

-- 1.3 KITCHEN ORDERS (1 Order Dapur = 1 Kartu Kurir = 1 Invoice Gabungan)
CREATE TABLE IF NOT EXISTS public.kitchen_orders (
    id TEXT PRIMARY KEY,
    order_code VARCHAR(60) UNIQUE NOT NULL,
    kitchen_id TEXT NOT NULL REFERENCES public.kitchens(id) ON DELETE RESTRICT,
    order_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'IN_TRANSIT'
        CHECK (status IN ('ALLOCATED', 'IN_TRANSIT', 'PARTIALLY_WEIGHED', 'BAST_VERIFIED', 'INVOICED')),
    bast_signed_by_name VARCHAR(120),
    bast_verified_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.4 KITCHEN ORDER ITEMS (Berat wajib INTEGER kilogram bulat — Invariant 1, 2, 3)
CREATE TABLE IF NOT EXISTS public.kitchen_order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES public.kitchen_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    product_name_snapshot VARCHAR(150) NOT NULL,
    qty_ordered_kg INTEGER NOT NULL CHECK (qty_ordered_kg > 0),
    qty_accepted_kg INTEGER NULL CHECK (qty_accepted_kg IS NULL OR (qty_accepted_kg >= 0 AND qty_accepted_kg <= qty_ordered_kg)),
    kitchen_unit_price_rp NUMERIC(15,2) NOT NULL CHECK (kitchen_unit_price_rp > 0),
    margin_per_kg_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00
        CHECK (margin_per_kg_rp >= 0 AND margin_per_kg_rp <= kitchen_unit_price_rp),
    is_weighed BOOLEAN NOT NULL DEFAULT FALSE,
    weighed_at TIMESTAMPTZ,
    shrinkage_reason TEXT,
    shrinkage_note TEXT,
    line_invoice_amount_rp NUMERIC(15,2) GENERATED ALWAYS AS (
        ROUND((COALESCE(qty_accepted_kg, qty_ordered_kg)::NUMERIC) * kitchen_unit_price_rp, 2)
    ) STORED,
    line_margin_amount_rp NUMERIC(15,2) GENERATED ALWAYS AS (
        ROUND((COALESCE(qty_accepted_kg, qty_ordered_kg)::NUMERIC) * margin_per_kg_rp, 2)
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.5 KITCHEN INVOICES (1 Invoice Gabungan per Order Dapur — Invariant 2 & 4)
CREATE TABLE IF NOT EXISTS public.kitchen_invoices (
    id TEXT PRIMARY KEY,
    invoice_code VARCHAR(60) UNIQUE NOT NULL,
    order_id TEXT UNIQUE NOT NULL REFERENCES public.kitchen_orders(id) ON DELETE CASCADE,
    kitchen_id TEXT NOT NULL REFERENCES public.kitchens(id) ON DELETE RESTRICT,
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL DEFAULT (CURRENT_DATE + 7),
    total_amount_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (total_amount_rp >= 0),
    amount_paid_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (amount_paid_rp >= 0),
    status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID', 'PAID')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.6 PROFIT SPLIT CONFIGS (Pengaturan Persentase Bagi Hasil Tim vs Koperasi)
CREATE TABLE IF NOT EXISTS public.profit_split_configs (
    id TEXT PRIMARY KEY,
    config_name VARCHAR(100) NOT NULL,
    team_share_pct NUMERIC(5,2) NOT NULL CHECK (team_share_pct >= 0 AND team_share_pct <= 100),
    cooperative_share_pct NUMERIC(5,2) NOT NULL CHECK (cooperative_share_pct >= 0 AND cooperative_share_pct <= 100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_profit_split_100 CHECK (team_share_pct + cooperative_share_pct = 100.00)
);

-- 1.7 PROFIT PAYOUT BATCHES (Bukti Pencairan Bagi Hasil)
CREATE TABLE IF NOT EXISTS public.profit_payout_batches (
    id TEXT PRIMARY KEY,
    payout_reference VARCHAR(60) UNIQUE NOT NULL,
    beneficiary_type TEXT NOT NULL CHECK (beneficiary_type IN ('TEAM', 'COOPERATIVE')),
    total_payout_amount NUMERIC(15,2) NOT NULL CHECK (total_payout_amount > 0),
    transfer_proof_url TEXT NOT NULL,
    notes TEXT,
    disbursed_by TEXT NOT NULL,
    disbursed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.8 PROFIT LEDGER ENTRIES (Cash-Basis Profit Sharing — Invariant 4)
CREATE TABLE IF NOT EXISTS public.profit_ledger_entries (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES public.kitchen_invoices(id) ON DELETE CASCADE,
    order_item_id TEXT REFERENCES public.kitchen_order_items(id) ON DELETE CASCADE,
    kitchen_id TEXT NOT NULL REFERENCES public.kitchens(id) ON DELETE RESTRICT,
    gross_margin_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (gross_margin_rp >= 0),
    team_share_pct NUMERIC(5,2) NOT NULL DEFAULT 60.00 CHECK (team_share_pct >= 0 AND team_share_pct <= 100),
    coop_share_pct NUMERIC(5,2) NOT NULL DEFAULT 40.00 CHECK (coop_share_pct >= 0 AND coop_share_pct <= 100),
    team_amount_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (team_amount_rp >= 0),
    coop_amount_rp NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (coop_amount_rp >= 0),
    status TEXT NOT NULL DEFAULT 'LOCKED_UNPAID'
        CHECK (status IN ('LOCKED_UNPAID', 'AVAILABLE_FOR_PAYOUT', 'PAID_OUT')),
    team_paid_out BOOLEAN NOT NULL DEFAULT FALSE,
    coop_paid_out BOOLEAN NOT NULL DEFAULT FALSE,
    team_payout_batch_id TEXT REFERENCES public.profit_payout_batches(id) ON DELETE SET NULL,
    coop_payout_batch_id TEXT REFERENCES public.profit_payout_batches(id) ON DELETE SET NULL,
    unlocked_at TIMESTAMPTZ,
    paid_out_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_team_plus_coop_eq_gross CHECK (team_amount_rp + coop_amount_rp = gross_margin_rp)
);

CREATE INDEX IF NOT EXISTS idx_kitchen_orders_kitchen_date ON public.kitchen_orders(kitchen_id, order_date);
CREATE INDEX IF NOT EXISTS idx_kitchen_order_items_order ON public.kitchen_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_invoices_order ON public.kitchen_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_profit_ledger_invoice ON public.profit_ledger_entries(invoice_id);

-- =============================================================================
-- 2. PROTEKSI KEAMANAN LAPANGAN (Security-Barrier Views — Invariant 5)
-- =============================================================================
-- View v_courier_kitchen_orders HANYA mengekspos identitas dapur, nama barang,
-- qty_ordered_kg, qty_accepted_kg, is_weighed, dan catatan susut TANPA harga/margin.

CREATE OR REPLACE VIEW public.v_courier_kitchen_orders WITH (security_barrier = true) AS
SELECT
    koi.id AS order_item_id,
    koi.order_id,
    ko.order_code,
    ko.order_date,
    ko.status AS order_status,
    ko.kitchen_id,
    k.code AS kitchen_code,
    k.name AS kitchen_name,
    k.pic_name AS kitchen_pic_name,
    k.pic_phone AS kitchen_pic_phone,
    koi.product_id,
    koi.product_name_snapshot AS product_name,
    'kg'::VARCHAR(10) AS base_unit,
    koi.qty_ordered_kg,
    koi.qty_accepted_kg,
    (koi.qty_ordered_kg - COALESCE(koi.qty_accepted_kg, koi.qty_ordered_kg)) AS qty_shrinkage_kg,
    koi.is_weighed,
    koi.shrinkage_reason,
    koi.shrinkage_note,
    EXISTS (
        SELECT 1 FROM public.kitchen_invoices ki
        WHERE ki.order_id = ko.id AND ki.status = 'PAID'
    ) AS is_locked
FROM public.kitchen_order_items koi
JOIN public.kitchen_orders ko ON ko.id = koi.order_id
JOIN public.kitchens k ON k.id = ko.kitchen_id;

-- Alias view untuk kompatibilitas v_safe_delivery_items_bast
CREATE OR REPLACE VIEW public.v_safe_delivery_items_bast WITH (security_barrier = true) AS
SELECT
    order_item_id AS delivery_item_id,
    order_id AS delivery_id,
    order_code AS delivery_number,
    order_date AS delivery_date,
    kitchen_id,
    kitchen_name,
    product_id AS item_id,
    product_name AS item_name,
    base_unit,
    qty_ordered_kg AS qty_dispatched_kg,
    COALESCE(qty_accepted_kg, qty_ordered_kg) AS qty_accepted_kg,
    qty_shrinkage_kg,
    CASE
        WHEN shrinkage_reason IS NOT NULL AND shrinkage_note IS NOT NULL AND shrinkage_note <> ''
            THEN shrinkage_reason || ' — ' || shrinkage_note
        ELSE shrinkage_reason
    END AS rejection_reason,
    kitchen_code,
    kitchen_pic_name,
    kitchen_pic_phone,
    is_weighed,
    is_locked
FROM public.v_courier_kitchen_orders;

-- =============================================================================
-- 3. ROW LEVEL SECURITY (RLS) & DATA API GRANTS
-- =============================================================================

ALTER TABLE public.kitchens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kitchen_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kitchen_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kitchen_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_split_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_ledger_entries ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'kitchens',
        'products',
        'kitchen_orders',
        'kitchen_order_items',
        'kitchen_invoices',
        'profit_split_configs',
        'profit_payout_batches',
        'profit_ledger_entries'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS pol_public_sync_select ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS pol_public_sync_insert ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS pol_public_sync_update ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS pol_public_sync_delete ON public.%I', tbl);

        EXECUTE format('CREATE POLICY pol_public_sync_select ON public.%I FOR SELECT TO anon, authenticated USING (true)', tbl);
        EXECUTE format('CREATE POLICY pol_public_sync_insert ON public.%I FOR INSERT TO anon, authenticated WITH CHECK (true)', tbl);
        EXECUTE format('CREATE POLICY pol_public_sync_update ON public.%I FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)', tbl);
        EXECUTE format('CREATE POLICY pol_public_sync_delete ON public.%I FOR DELETE TO anon, authenticated USING (true)', tbl);

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated', tbl);
    END LOOP;
END $$;

GRANT SELECT ON public.v_courier_kitchen_orders TO anon, authenticated;
GRANT SELECT ON public.v_safe_delivery_items_bast TO anon, authenticated;

-- Enable Supabase Realtime on operational tables
DO $$
DECLARE
    tbl TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH tbl IN ARRAY ARRAY[
            'kitchens',
            'products',
            'kitchen_orders',
            'kitchen_order_items',
            'kitchen_invoices',
            'profit_split_configs',
            'profit_payout_batches',
            'profit_ledger_entries'
        ] LOOP
            IF NOT EXISTS (
                SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl
            ) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
            END IF;
        END LOOP;
    END IF;
END $$;

-- =============================================================================
-- 4. INITIAL SEED DATA (Skenario Nyata 16 Oktober 2026 — Tim 60% : Koperasi 40%)
-- =============================================================================

INSERT INTO public.kitchens (id, code, name, address, pic_name, pic_phone, is_active, created_at) VALUES
('kitchen-01', 'DPR-01', 'SPPG Dapur 01 - Tebet (Dapur A)', 'Jl. Tebet Raya No. 12, Jakarta Selatan', 'Budi Santoso', '0812-9000-0001', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-02', 'DPR-02', 'SPPG Dapur 02 - Cawang (Dapur B)', 'Jl. Dewi Sartika No. 45, Jakarta Timur', 'Siti Aminah', '0812-9000-0002', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-03', 'DPR-03', 'SPPG Dapur 03 - Kalibata (Dapur C)', 'Jl. Raya Kalibata No. 8, Jakarta Selatan', 'Hendra Wijaya', '0812-9000-0003', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-04', 'DPR-04', 'SPPG Dapur 04 - Pasar Minggu (Dapur D)', 'Jl. Ragunan Raya No. 19, Jakarta Selatan', 'Rina Kusuma', '0812-9000-0004', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-05', 'DPR-05', 'SPPG Dapur 05 - Pancoran (Dapur E)', 'Jl. Pancoran Barat No. 3, Jakarta Selatan', 'Agus Pratama', '0812-9000-0005', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-06', 'DPR-06', 'SPPG Dapur 06 - Manggarai', 'Jl. Sultan Agung No. 21, Jakarta Selatan', 'Dewi Sartika', '0812-9000-0006', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-07', 'DPR-07', 'SPPG Dapur 07 - Matraman', 'Jl. Matraman Raya No. 54, Jakarta Timur', 'Eko Nugroho', '0812-9000-0007', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-08', 'DPR-08', 'SPPG Dapur 08 - Jatinegara', 'Jl. Jatinegara Timur No. 77, Jakarta Timur', 'Fajar Hidayat', '0812-9000-0008', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-09', 'DPR-09', 'SPPG Dapur 09 - Kramat Jati', 'Jl. Raya Bogor KM 19, Jakarta Timur', 'Gita Permata', '0812-9000-0009', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-10', 'DPR-10', 'SPPG Dapur 10 - Cililitan', 'Jl. Mayjen Sutoyo No. 14, Jakarta Timur', 'Hadi Sucipto', '0812-9000-0010', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-11', 'DPR-11', 'SPPG Dapur 11 - Pejaten', 'Jl. Pejaten Barat No. 30, Jakarta Selatan', 'Indah Lestari', '0812-9000-0011', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-12', 'DPR-12', 'SPPG Dapur 12 - Kemang', 'Jl. Kemang Raya No. 62, Jakarta Selatan', 'Joko Susilo', '0812-9000-0012', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-13', 'DPR-13', 'SPPG Dapur 13 - Mampang', 'Jl. Mampang Prapatan No. 88, Jakarta Selatan', 'Kartika Sari', '0812-9000-0013', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-14', 'DPR-14', 'SPPG Dapur 14 - Kuningan', 'Jl. HR Rasuna Said Kav. 10, Jakarta Selatan', 'Lukman Hakim', '0812-9000-0014', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-15', 'DPR-15', 'SPPG Dapur 15 - Setiabudi', 'Jl. Setiabudi Utara No. 5, Jakarta Selatan', 'Maya Anggraini', '0812-9000-0015', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-16', 'DPR-16', 'SPPG Dapur 16 - Cipete', 'Jl. Cipete Raya No. 41, Jakarta Selatan', 'Nanda Putra', '0812-9000-0016', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-17', 'DPR-17', 'SPPG Dapur 17 - Fatmawati', 'Jl. RS Fatmawati No. 17, Jakarta Selatan', 'Oki Setiawan', '0812-9000-0017', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-18', 'DPR-18', 'SPPG Dapur 18 - Cilandak', 'Jl. Cilandak KKO No. 25, Jakarta Selatan', 'Putri Maharani', '0812-9000-0018', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-19', 'DPR-19', 'SPPG Dapur 19 - Jagakarsa', 'Jl. Moh. Kahfi II No. 9, Jakarta Selatan', 'Qori Rahman', '0812-9000-0019', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-20', 'DPR-20', 'SPPG Dapur 20 - Lenteng Agung', 'Jl. Raya Lenteng Agung No. 33, Jakarta Selatan', 'Rudi Hermawan', '0812-9000-0020', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-21', 'DPR-21', 'SPPG Dapur 21 - Duren Sawit', 'Jl. Kolonel Sugiono No. 50, Jakarta Timur', 'Sari Wulandari', '0812-9000-0021', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-22', 'DPR-22', 'SPPG Dapur 22 - Pondok Bambu', 'Jl. Pahlawan Revolusi No. 16, Jakarta Timur', 'Taufik Hidayat', '0812-9000-0022', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-23', 'DPR-23', 'SPPG Dapur 23 - Klender', 'Jl. I Gusti Ngurah Rai No. 72, Jakarta Timur', 'Umar Bakri', '0812-9000-0023', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-24', 'DPR-24', 'SPPG Dapur 24 - Rawamangun', 'Jl. Pemuda No. 29, Jakarta Timur', 'Vina Panduwinata', '0812-9000-0024', TRUE, '2026-10-16T06:00:00.000Z'),
('kitchen-25', 'DPR-25', 'SPPG Dapur 25 - Pulogadung', 'Jl. Perintis Kemerdekaan No. 64, Jakarta Timur', 'Wahyu Kurniawan', '0812-9000-0025', TRUE, '2026-10-16T06:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.products (id, code, name, category, default_kitchen_price_rp, default_margin_per_kg_rp, is_active, created_at) VALUES
('item-wortel', 'SYR-WRT-KG', 'Wortel', 'Sayuran Segar', 14000.00, 2000.00, TRUE, '2026-10-16T06:00:00.000Z'),
('item-kubis', 'SYR-KBS-KG', 'Kubis', 'Sayuran Segar', 10000.00, 1500.00, TRUE, '2026-10-16T06:00:00.000Z'),
('item-ayam', 'AYM-FIL-KG', 'Daging Ayam Fillet', 'Protein Hewani', 40000.00, 4000.00, TRUE, '2026-10-16T06:00:00.000Z'),
('item-telur', 'TLR-AYM-KG', 'Telur Ayam', 'Protein Hewani', 30500.00, 3000.00, TRUE, '2026-10-16T06:00:00.000Z'),
('item-beras', 'BRS-PRM-KG', 'Beras', 'Karbohidrat Utama', 15000.00, 1500.00, TRUE, '2026-10-16T06:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profit_split_configs (id, config_name, team_share_pct, cooperative_share_pct, is_active, effective_from, created_at) VALUES
('split-default-60-40', 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%', 60.00, 40.00, TRUE, '2026-10-16', '2026-10-16T06:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

-- 5 Order Dapur (16 Oktober 2026)
INSERT INTO public.kitchen_orders (id, order_code, kitchen_id, order_date, status, bast_signed_by_name, bast_verified_at, created_at, updated_at) VALUES
('deliv-01', 'SJ-20261016-DPR01-01', 'kitchen-01', '2026-10-16', 'BAST_VERIFIED', 'Budi Santoso', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('deliv-04', 'SJ-20261016-DPR02-01', 'kitchen-02', '2026-10-16', 'BAST_VERIFIED', 'Siti Aminah', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('deliv-07', 'SJ-20261016-DPR03-01', 'kitchen-03', '2026-10-16', 'BAST_VERIFIED', 'Hendra Wijaya', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('deliv-10', 'SJ-20261016-DPR04-01', 'kitchen-04', '2026-10-16', 'IN_TRANSIT', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('deliv-13', 'SJ-20261016-DPR05-01', 'kitchen-05', '2026-10-16', 'IN_TRANSIT', 'Agus Pratama', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.kitchen_order_items (
    id, order_id, product_id, product_name_snapshot,
    qty_ordered_kg, qty_accepted_kg, kitchen_unit_price_rp, margin_per_kg_rp,
    is_weighed, weighed_at, shrinkage_reason, shrinkage_note, created_at, updated_at
) VALUES
-- DPR-01: Wortel 35->35, Kubis 25->25
('ditem-03', 'deliv-01', 'item-wortel', 'Wortel', 35, 35, 14000.00, 2000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ditem-04', 'deliv-01', 'item-kubis', 'Kubis', 25, 25, 10000.00, 1500.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
-- DPR-02: Daging Ayam 50->49 (susut -1), Telur 20->20
('ditem-06', 'deliv-04', 'item-ayam', 'Daging Ayam Fillet', 50, 49, 40000.00, 4000.00, TRUE, '2026-10-16T09:00:00.000Z', 'Susut', 'susut air/perjalanan', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ditem-07', 'deliv-04', 'item-telur', 'Telur Ayam', 20, 20, 30500.00, 3000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
-- DPR-03: Wortel 35->33 (reject -2), Beras 50->50
('ditem-09', 'deliv-07', 'item-wortel', 'Wortel', 35, 33, 14000.00, 2000.00, TRUE, '2026-10-16T09:00:00.000Z', 'Barang Rusak/Reject', 'wortel patah/busuk', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ditem-10', 'deliv-07', 'item-beras', 'Beras', 50, 50, 15000.00, 1500.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
-- DPR-04: Wortel 35, Kubis 50, Daging Ayam 50 (Menunggu Kurir)
('ditem-12', 'deliv-10', 'item-wortel', 'Wortel', 35, NULL, 14000.00, 2000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('ditem-13', 'deliv-10', 'item-kubis', 'Kubis', 50, NULL, 10000.00, 1500.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('ditem-14', 'deliv-10', 'item-ayam', 'Daging Ayam Fillet', 50, NULL, 40000.00, 4000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
-- DPR-05: Daging Ayam 50->50, Telur 25 (belum ditimbang)
('ditem-16', 'deliv-13', 'item-ayam', 'Daging Ayam Fillet', 50, 50, 40000.00, 4000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ditem-17', 'deliv-13', 'item-telur', 'Telur Ayam', 25, NULL, 30500.00, 3000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.kitchen_invoices (
    id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
    total_amount_rp, amount_paid_rp, status, paid_at, created_at, updated_at
) VALUES
('inv-02', 'INV-20261016-DPR01-01', 'deliv-01', 'kitchen-01', '2026-10-16', '2026-10-23', 740000.00, 740000.00, 'PAID', '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('inv-05', 'INV-20261016-DPR02-01', 'deliv-04', 'kitchen-02', '2026-10-16', '2026-10-23', 2570000.00, 2570000.00, 'PAID', '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('inv-08', 'INV-20261016-DPR03-01', 'deliv-07', 'kitchen-03', '2026-10-16', '2026-10-23', 1212000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('inv-11', 'INV-20261016-DPR04-01', 'deliv-10', 'kitchen-04', '2026-10-16', '2026-10-23', 2990000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('inv-14', 'INV-20261016-DPR05-01', 'deliv-13', 'kitchen-05', '2026-10-16', '2026-10-23', 2762500.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profit_ledger_entries (
    id, invoice_id, order_item_id, kitchen_id,
    gross_margin_rp, team_share_pct, coop_share_pct, team_amount_rp, coop_amount_rp,
    status, team_paid_out, coop_paid_out, unlocked_at, created_at, updated_at
) VALUES
('ple-ditem-03', 'inv-02', 'ditem-03', 'kitchen-01', 70000.00, 60.00, 40.00, 42000.00, 28000.00, 'AVAILABLE_FOR_PAYOUT', FALSE, FALSE, '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('ple-ditem-04', 'inv-02', 'ditem-04', 'kitchen-01', 37500.00, 60.00, 40.00, 22500.00, 15000.00, 'AVAILABLE_FOR_PAYOUT', FALSE, FALSE, '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('ple-ditem-06', 'inv-05', 'ditem-06', 'kitchen-02', 196000.00, 60.00, 40.00, 117600.00, 78400.00, 'AVAILABLE_FOR_PAYOUT', FALSE, FALSE, '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('ple-ditem-07', 'inv-05', 'ditem-07', 'kitchen-02', 60000.00, 60.00, 40.00, 36000.00, 24000.00, 'AVAILABLE_FOR_PAYOUT', FALSE, FALSE, '2026-10-16T15:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
('ple-ditem-09', 'inv-08', 'ditem-09', 'kitchen-03', 66000.00, 60.00, 40.00, 39600.00, 26400.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ple-ditem-10', 'inv-08', 'ditem-10', 'kitchen-03', 75000.00, 60.00, 40.00, 45000.00, 30000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ple-ditem-12', 'inv-11', 'ditem-12', 'kitchen-04', 70000.00, 60.00, 40.00, 42000.00, 28000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('ple-ditem-13', 'inv-11', 'ditem-13', 'kitchen-04', 75000.00, 60.00, 40.00, 45000.00, 30000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('ple-ditem-14', 'inv-11', 'ditem-14', 'kitchen-04', 200000.00, 60.00, 40.00, 120000.00, 80000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
('ple-ditem-16', 'inv-14', 'ditem-16', 'kitchen-05', 200000.00, 60.00, 40.00, 120000.00, 80000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
('ple-ditem-17', 'inv-14', 'ditem-17', 'kitchen-05', 75000.00, 60.00, 40.00, 45000.00, 30000.00, 'LOCKED_UNPAID', FALSE, FALSE, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

COMMIT;
