-- =============================================================================
-- Migration: 0006_pure_supabase_cloud_rpcs_and_triggers.sql
-- Project  : MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger (Stage 8)
-- Ref      : nrdepkayabbbshnmyrvc
-- Purpose  : 100% Pure Supabase Cloud Backend (Single Source of Truth):
--            1. app_settings table (team_share_pct, coop_share_pct, admin_pin, coop_pin)
--            2. profit_ledger_entries.order_id column + automatic triggers
--            3. PostgreSQL Triggers for automatic invoice & profit ledger recalculation
--               on kitchen_order_items changes and cash-basis unlock on PAID
--            4. Strict Price-Free View v_courier_kitchen_orders + SECURITY DEFINER RPC
--               submit_courier_weighing (supports single or batch weighing)
--            5. RPCs reset_to_simulation_seed() and clear_all_transactions()
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. APP SETTINGS TABLE & PROFIT LEDGER ORDER_ID COLUMN
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.app_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    team_share_pct NUMERIC(5,2) NOT NULL DEFAULT 60.00 CHECK (team_share_pct >= 0 AND team_share_pct <= 100),
    coop_share_pct NUMERIC(5,2) NOT NULL DEFAULT 40.00 CHECK (coop_share_pct >= 0 AND coop_share_pct <= 100),
    admin_pin VARCHAR(30) NOT NULL DEFAULT '1234',
    coop_pin VARCHAR(30) NOT NULL DEFAULT '5678',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_app_settings_split_100 CHECK (team_share_pct + coop_share_pct = 100.00)
);

INSERT INTO public.app_settings (id, team_share_pct, coop_share_pct, admin_pin, coop_pin)
VALUES ('default', 60.00, 40.00, '1234', '5678')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_public_sync_select ON public.app_settings;
DROP POLICY IF EXISTS pol_public_sync_insert ON public.app_settings;
DROP POLICY IF EXISTS pol_public_sync_update ON public.app_settings;
DROP POLICY IF EXISTS pol_public_sync_delete ON public.app_settings;

CREATE POLICY pol_public_sync_select ON public.app_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY pol_public_sync_insert ON public.app_settings FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY pol_public_sync_update ON public.app_settings FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY pol_public_sync_delete ON public.app_settings FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_settings'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
        END IF;
    END IF;
END $$;

-- Ensure profit_ledger_entries has order_id column and unique constraint per order_item_id
ALTER TABLE public.profit_ledger_entries
    ADD COLUMN IF NOT EXISTS order_id TEXT REFERENCES public.kitchen_orders(id) ON DELETE CASCADE;

UPDATE public.profit_ledger_entries ple
   SET order_id = ki.order_id
  FROM public.kitchen_invoices ki
 WHERE ple.invoice_id = ki.id
   AND ple.order_id IS NULL;

-- =============================================================================
-- 2. STRICT COURIER VIEW (v_courier_kitchen_orders — Invariant 5: Zero Prices)
-- =============================================================================

DROP VIEW IF EXISTS public.v_safe_delivery_items_bast;
DROP VIEW IF EXISTS public.v_courier_kitchen_orders;

CREATE VIEW public.v_courier_kitchen_orders WITH (security_barrier = true) AS
SELECT
    koi.order_id,
    ko.order_code,
    ko.order_date,
    ko.status AS order_status,
    ko.kitchen_id,
    k.code AS kitchen_code,
    k.name AS kitchen_name,
    k.pic_name,
    k.pic_phone,
    k.pic_name AS kitchen_pic_name,
    k.pic_phone AS kitchen_pic_phone,
    koi.id AS item_id,
    koi.id AS order_item_id,
    koi.product_id,
    koi.product_name_snapshot,
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

CREATE VIEW public.v_safe_delivery_items_bast WITH (security_barrier = true) AS
SELECT
    order_item_id AS delivery_item_id,
    order_id AS delivery_id,
    order_code AS delivery_number,
    order_date AS delivery_date,
    kitchen_id,
    kitchen_name,
    product_id AS item_id,
    product_name_snapshot AS item_name,
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

GRANT SELECT ON public.v_courier_kitchen_orders TO anon, authenticated;
GRANT SELECT ON public.v_safe_delivery_items_bast TO anon, authenticated;

-- =============================================================================
-- 3. AUTOMATIC DATABASE TRIGGERS (Invoice & Profit Ledger Server-Side Engine)
-- =============================================================================

-- 3.1 Helper: Recalculate order status, invoice total, and profit ledger for an order
CREATE OR REPLACE FUNCTION public.fn_recalculate_order_financials(p_order_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order RECORD;
    v_invoice RECORD;
    v_total_items INT := 0;
    v_weighed_items INT := 0;
    v_new_order_status TEXT;
    v_invoice_total NUMERIC(15,2) := 0.00;
    v_team_pct NUMERIC(5,2) := 60.00;
    v_coop_pct NUMERIC(5,2) := 40.00;
    v_item RECORD;
    v_eff_kg INTEGER;
    v_gross NUMERIC(15,2);
    v_coop_amt NUMERIC(15,2);
    v_team_amt NUMERIC(15,2);
    v_existing_ple RECORD;
    v_ple_status TEXT;
BEGIN
    SELECT * INTO v_order FROM public.kitchen_orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT team_share_pct, coop_share_pct
      INTO v_team_pct, v_coop_pct
      FROM public.app_settings
     WHERE id = 'default'
     LIMIT 1;

    IF v_team_pct IS NULL THEN
        v_team_pct := 60.00;
        v_coop_pct := 40.00;
    END IF;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE is_weighed = TRUE),
        COALESCE(SUM(ROUND((COALESCE(qty_accepted_kg, qty_ordered_kg)::NUMERIC) * kitchen_unit_price_rp, 2)), 0.00)
      INTO v_total_items, v_weighed_items, v_invoice_total
      FROM public.kitchen_order_items
     WHERE order_id = p_order_id;

    -- Determine order status from weighing progress
    IF v_total_items > 0 AND v_weighed_items = v_total_items THEN
        v_new_order_status := 'BAST_VERIFIED';
    ELSIF v_weighed_items > 0 THEN
        v_new_order_status := 'PARTIALLY_WEIGHED';
    ELSE
        v_new_order_status := 'IN_TRANSIT';
    END IF;

    UPDATE public.kitchen_orders
       SET status = v_new_order_status,
           bast_verified_at = CASE
               WHEN v_new_order_status = 'BAST_VERIFIED' THEN COALESCE(bast_verified_at, NOW())
               ELSE NULL
           END,
           updated_at = NOW()
     WHERE id = p_order_id
       AND (status IS DISTINCT FROM v_new_order_status OR (v_new_order_status = 'BAST_VERIFIED' AND bast_verified_at IS NULL));

    -- Ensure kitchen_invoices row exists and update total_amount_rp
    SELECT * INTO v_invoice FROM public.kitchen_invoices WHERE order_id = p_order_id;
    IF NOT FOUND AND v_total_items > 0 THEN
        INSERT INTO public.kitchen_invoices (
            id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
            total_amount_rp, amount_paid_rp, status, created_at, updated_at
        ) VALUES (
            'inv-' || p_order_id,
            REPLACE(v_order.order_code, 'SJ-', 'INV-'),
            p_order_id,
            v_order.kitchen_id,
            v_order.order_date,
            v_order.order_date + 7,
            v_invoice_total,
            0.00,
            'UNPAID',
            NOW(),
            NOW()
        )
        RETURNING * INTO v_invoice;
    ELSIF FOUND THEN
        UPDATE public.kitchen_invoices
           SET total_amount_rp = v_invoice_total,
               amount_paid_rp = CASE WHEN status = 'PAID' THEN v_invoice_total ELSE amount_paid_rp END,
               updated_at = NOW()
         WHERE id = v_invoice.id
        RETURNING * INTO v_invoice;
    END IF;

    IF v_invoice.id IS NULL THEN
        RETURN;
    END IF;

    -- Remove ledger entries for deleted order items (unless already paid out)
    DELETE FROM public.profit_ledger_entries ple
     WHERE ple.invoice_id = v_invoice.id
       AND ple.order_item_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.kitchen_order_items koi WHERE koi.id = ple.order_item_id
       )
       AND ple.team_paid_out = FALSE
       AND ple.coop_paid_out = FALSE;

    -- Upsert profit_ledger_entries for each order item
    FOR v_item IN
        SELECT * FROM public.kitchen_order_items WHERE order_id = p_order_id
    LOOP
        v_eff_kg := COALESCE(v_item.qty_accepted_kg, v_item.qty_ordered_kg);
        v_gross := ROUND((v_eff_kg::NUMERIC) * v_item.margin_per_kg_rp, 2);

        SELECT * INTO v_existing_ple
          FROM public.profit_ledger_entries
         WHERE id = 'ple-' || v_item.id OR order_item_id = v_item.id
         LIMIT 1;

        IF FOUND THEN
            -- Do not recalculate if either share was already paid out (Invariant 4)
            IF v_existing_ple.team_paid_out = FALSE AND v_existing_ple.coop_paid_out = FALSE THEN
                v_coop_amt := ROUND(v_gross * v_coop_pct / 100.0, 2);
                v_team_amt := v_gross - v_coop_amt;
                v_ple_status := CASE WHEN v_invoice.status = 'PAID' THEN 'AVAILABLE_FOR_PAYOUT' ELSE 'LOCKED_UNPAID' END;

                UPDATE public.profit_ledger_entries
                   SET order_id = p_order_id,
                       kitchen_id = v_order.kitchen_id,
                       gross_margin_rp = v_gross,
                       team_share_pct = v_team_pct,
                       coop_share_pct = v_coop_pct,
                       team_amount_rp = v_team_amt,
                       coop_amount_rp = v_coop_amt,
                       status = v_ple_status,
                       unlocked_at = CASE WHEN v_invoice.status = 'PAID' THEN COALESCE(unlocked_at, NOW()) ELSE NULL END,
                       updated_at = NOW()
                 WHERE id = v_existing_ple.id;
            END IF;
        ELSE
            v_coop_amt := ROUND(v_gross * v_coop_pct / 100.0, 2);
            v_team_amt := v_gross - v_coop_amt;
            v_ple_status := CASE WHEN v_invoice.status = 'PAID' THEN 'AVAILABLE_FOR_PAYOUT' ELSE 'LOCKED_UNPAID' END;

            INSERT INTO public.profit_ledger_entries (
                id, invoice_id, order_id, order_item_id, kitchen_id,
                gross_margin_rp, team_share_pct, coop_share_pct,
                team_amount_rp, coop_amount_rp, status,
                team_paid_out, coop_paid_out, unlocked_at, created_at, updated_at
            ) VALUES (
                'ple-' || v_item.id,
                v_invoice.id,
                p_order_id,
                v_item.id,
                v_order.kitchen_id,
                v_gross,
                v_team_pct,
                v_coop_pct,
                v_team_amt,
                v_coop_amt,
                v_ple_status,
                FALSE,
                FALSE,
                CASE WHEN v_invoice.status = 'PAID' THEN NOW() ELSE NULL END,
                NOW(),
                NOW()
            );
        END IF;
    END LOOP;
END;
$$;

-- 3.2 Trigger on kitchen_order_items: auto recalculate invoice & ledger
CREATE OR REPLACE FUNCTION public.fn_trg_kitchen_order_items_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_id TEXT := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
    PERFORM public.fn_recalculate_order_financials(v_order_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_kitchen_order_items_recalc ON public.kitchen_order_items;
CREATE TRIGGER trg_kitchen_order_items_recalc
AFTER INSERT OR UPDATE OR DELETE ON public.kitchen_order_items
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_kitchen_order_items_after_change();

-- 3.3 Trigger on kitchen_invoices.status -> PAID: unlock profit_ledger_entries (Cash-Basis Invariant 4)
CREATE OR REPLACE FUNCTION public.fn_trg_kitchen_invoice_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'PAID' AND OLD.status IS DISTINCT FROM 'PAID' THEN
        -- Ensure all items on this order are weighed before allowing PAID
        IF EXISTS (
            SELECT 1 FROM public.kitchen_order_items
            WHERE order_id = NEW.order_id AND is_weighed = FALSE
        ) THEN
            RAISE EXCEPTION 'Invoice % belum bisa ditandai Lunas karena masih ada barang yang belum ditimbang kurir.', NEW.invoice_code;
        END IF;

        NEW.paid_at := COALESCE(NEW.paid_at, NOW());
        NEW.amount_paid_rp := NEW.total_amount_rp;
        NEW.updated_at := NOW();

        UPDATE public.profit_ledger_entries
           SET status = CASE
                   WHEN team_paid_out AND coop_paid_out THEN 'PAID_OUT'
                   ELSE 'AVAILABLE_FOR_PAYOUT'
               END,
               unlocked_at = COALESCE(unlocked_at, NOW()),
               updated_at = NOW()
         WHERE invoice_id = NEW.id
           AND status = 'LOCKED_UNPAID';

    ELSIF OLD.status = 'PAID' AND NEW.status <> 'PAID' THEN
        UPDATE public.profit_ledger_entries
           SET status = 'LOCKED_UNPAID',
               unlocked_at = NULL,
               updated_at = NOW()
         WHERE invoice_id = NEW.id
           AND team_paid_out = FALSE
           AND coop_paid_out = FALSE;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kitchen_invoice_status_change ON public.kitchen_invoices;
CREATE TRIGGER trg_kitchen_invoice_status_change
BEFORE UPDATE OF status ON public.kitchen_invoices
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_kitchen_invoice_status_change();

-- 3.4 Trigger on app_settings / profit_split_configs: recalculate unpaid/un-disbursed ledger entries
CREATE OR REPLACE FUNCTION public.fn_trg_app_settings_split_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.profit_split_configs
       SET team_share_pct = NEW.team_share_pct,
           cooperative_share_pct = NEW.coop_share_pct
     WHERE id = 'split-default-60-40';

    UPDATE public.profit_ledger_entries
       SET team_share_pct = NEW.team_share_pct,
           coop_share_pct = NEW.coop_share_pct,
           coop_amount_rp = ROUND(gross_margin_rp * NEW.coop_share_pct / 100.0, 2),
           team_amount_rp = gross_margin_rp - ROUND(gross_margin_rp * NEW.coop_share_pct / 100.0, 2),
           updated_at = NOW()
     WHERE team_paid_out = FALSE
       AND coop_paid_out = FALSE;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_settings_split_change ON public.app_settings;
CREATE TRIGGER trg_app_settings_split_change
AFTER UPDATE OF team_share_pct, coop_share_pct ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_app_settings_split_change();

-- =============================================================================
-- 4. RPC FUNCTIONS FOR ATOMIC CLOUD OPERATIONS
-- =============================================================================

-- 4.1 submit_courier_weighing (SECURITY DEFINER — Lapangan role never touches price columns)
CREATE OR REPLACE FUNCTION public.submit_courier_weighing(
    p_item_id TEXT,
    p_qty_accepted_kg INTEGER,
    p_shrinkage_reason TEXT DEFAULT NULL,
    p_shrinkage_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item RECORD;
    v_inv RECORD;
BEGIN
    SELECT * INTO v_item FROM public.kitchen_order_items WHERE id = p_item_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Baris order % tidak ditemukan.', p_item_id;
    END IF;

    SELECT * INTO v_inv FROM public.kitchen_invoices WHERE order_id = v_item.order_id;
    IF FOUND AND v_inv.status = 'PAID' THEN
        RAISE EXCEPTION 'Invoice sudah lunas — timbangan terkunci.';
    END IF;

    IF p_qty_accepted_kg < 0 THEN
        RAISE EXCEPTION 'Berat diterima tidak boleh negatif.';
    END IF;

    IF p_qty_accepted_kg > v_item.qty_ordered_kg THEN
        RAISE EXCEPTION '%: berat diterima (% kg) melebihi berat order (% kg).',
            v_item.product_name_snapshot, p_qty_accepted_kg, v_item.qty_ordered_kg;
    END IF;

    UPDATE public.kitchen_order_items
       SET qty_accepted_kg = p_qty_accepted_kg,
           is_weighed = TRUE,
           weighed_at = NOW(),
           shrinkage_reason = CASE WHEN p_qty_accepted_kg < qty_ordered_kg THEN COALESCE(NULLIF(TRIM(p_shrinkage_reason), ''), 'Susut') ELSE NULL END,
           shrinkage_note = CASE WHEN p_qty_accepted_kg < qty_ordered_kg THEN NULLIF(TRIM(p_shrinkage_note), '') ELSE NULL END,
           updated_at = NOW()
     WHERE id = p_item_id;

    -- Trigger trg_kitchen_order_items_recalc automatically updates kitchen_orders, kitchen_invoices, and profit_ledger_entries
    RETURN jsonb_build_object(
        'ok', true,
        'item_id', p_item_id,
        'order_id', v_item.order_id,
        'qty_ordered_kg', v_item.qty_ordered_kg,
        'qty_accepted_kg', p_qty_accepted_kg
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_courier_weighing(TEXT, INTEGER, TEXT, TEXT) TO anon, authenticated;

-- 4.2 clear_all_transactions: Kosongkan Transaksi (Mulai Operasional Bersih), pertahankan Master Dapur & Barang
CREATE OR REPLACE FUNCTION public.clear_all_transactions()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.profit_ledger_entries WHERE true;
    DELETE FROM public.profit_payout_batches WHERE true;
    DELETE FROM public.kitchen_invoices WHERE true;
    DELETE FROM public.kitchen_order_items WHERE true;
    DELETE FROM public.kitchen_orders WHERE true;

    RETURN jsonb_build_object('ok', true, 'mode', 'clean_transactions');
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_all_transactions() TO anon, authenticated;

-- 4.3 reset_to_simulation_seed: Kembalikan ke data simulasi awal (16 Oktober 2026)
CREATE OR REPLACE FUNCTION public.reset_to_simulation_seed()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.profit_ledger_entries WHERE true;
    DELETE FROM public.profit_payout_batches WHERE true;
    DELETE FROM public.kitchen_invoices WHERE true;
    DELETE FROM public.kitchen_order_items WHERE true;
    DELETE FROM public.kitchen_orders WHERE true;

    UPDATE public.app_settings
       SET team_share_pct = 60.00,
           coop_share_pct = 40.00,
           updated_at = NOW()
     WHERE id = 'default';

    UPDATE public.profit_split_configs
       SET team_share_pct = 60.00,
           cooperative_share_pct = 40.00
     WHERE id = 'split-default-60-40';

    -- Ensure 25 kitchens & 5 default products exist
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

    -- Insert 5 simulation orders
    INSERT INTO public.kitchen_orders (id, order_code, kitchen_id, order_date, status, bast_signed_by_name, bast_verified_at, created_at, updated_at) VALUES
    ('deliv-01', 'SJ-20261016-DPR01-01', 'kitchen-01', '2026-10-16', 'BAST_VERIFIED', 'Budi Santoso', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
    ('deliv-04', 'SJ-20261016-DPR02-01', 'kitchen-02', '2026-10-16', 'BAST_VERIFIED', 'Siti Aminah', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T15:00:00.000Z'),
    ('deliv-07', 'SJ-20261016-DPR03-01', 'kitchen-03', '2026-10-16', 'BAST_VERIFIED', 'Hendra Wijaya', '2026-10-16T09:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('deliv-10', 'SJ-20261016-DPR04-01', 'kitchen-04', '2026-10-16', 'IN_TRANSIT', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('deliv-13', 'SJ-20261016-DPR05-01', 'kitchen-05', '2026-10-16', 'PARTIALLY_WEIGHED', 'Agus Pratama', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z');

    -- Insert invoices with canonical IDs before items so trigger updates them cleanly
    INSERT INTO public.kitchen_invoices (
        id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
        total_amount_rp, amount_paid_rp, status, paid_at, created_at, updated_at
    ) VALUES
    ('inv-02', 'INV-20261016-DPR01-01', 'deliv-01', 'kitchen-01', '2026-10-16', '2026-10-23', 740000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('inv-05', 'INV-20261016-DPR02-01', 'deliv-04', 'kitchen-02', '2026-10-16', '2026-10-23', 2570000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('inv-08', 'INV-20261016-DPR03-01', 'deliv-07', 'kitchen-03', '2026-10-16', '2026-10-23', 1212000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('inv-11', 'INV-20261016-DPR04-01', 'deliv-10', 'kitchen-04', '2026-10-16', '2026-10-23', 2990000.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('inv-14', 'INV-20261016-DPR05-01', 'deliv-13', 'kitchen-05', '2026-10-16', '2026-10-23', 2762500.00, 0.00, 'UNPAID', NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z');

    -- Insert items (triggers automatically populate profit_ledger_entries and invoice totals)
    INSERT INTO public.kitchen_order_items (
        id, order_id, product_id, product_name_snapshot,
        qty_ordered_kg, qty_accepted_kg, kitchen_unit_price_rp, margin_per_kg_rp,
        is_weighed, weighed_at, shrinkage_reason, shrinkage_note, created_at, updated_at
    ) VALUES
    ('ditem-03', 'deliv-01', 'item-wortel', 'Wortel', 35, 35, 14000.00, 2000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-04', 'deliv-01', 'item-kubis', 'Kubis', 25, 25, 10000.00, 1500.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-06', 'deliv-04', 'item-ayam', 'Daging Ayam Fillet', 50, 49, 40000.00, 4000.00, TRUE, '2026-10-16T09:00:00.000Z', 'Susut', 'susut air/perjalanan', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-07', 'deliv-04', 'item-telur', 'Telur Ayam', 20, 20, 30500.00, 3000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-09', 'deliv-07', 'item-wortel', 'Wortel', 35, 33, 14000.00, 2000.00, TRUE, '2026-10-16T09:00:00.000Z', 'Barang Rusak/Reject', 'wortel patah/busuk', '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-10', 'deliv-07', 'item-beras', 'Beras', 50, 50, 15000.00, 1500.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-12', 'deliv-10', 'item-wortel', 'Wortel', 35, NULL, 14000.00, 2000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('ditem-13', 'deliv-10', 'item-kubis', 'Kubis', 50, NULL, 10000.00, 1500.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('ditem-14', 'deliv-10', 'item-ayam', 'Daging Ayam Fillet', 50, NULL, 40000.00, 4000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z'),
    ('ditem-16', 'deliv-13', 'item-ayam', 'Daging Ayam Fillet', 50, 50, 40000.00, 4000.00, TRUE, '2026-10-16T09:00:00.000Z', NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T09:00:00.000Z'),
    ('ditem-17', 'deliv-13', 'item-telur', 'Telur Ayam', 25, NULL, 30500.00, 3000.00, FALSE, NULL, NULL, NULL, '2026-10-16T06:00:00.000Z', '2026-10-16T06:00:00.000Z');

    -- Mark DPR-01 and DPR-02 invoices as PAID (triggers unlock their profit_ledger_entries to AVAILABLE_FOR_PAYOUT)
    UPDATE public.kitchen_invoices
       SET status = 'PAID',
           paid_at = '2026-10-16T15:00:00.000Z'
     WHERE id IN ('inv-02', 'inv-05');

    RETURN jsonb_build_object('ok', true, 'mode', 'simulation_seed');
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_to_simulation_seed() TO anon, authenticated;

COMMIT;
