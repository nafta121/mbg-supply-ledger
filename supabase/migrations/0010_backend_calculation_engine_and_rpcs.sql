-- =============================================================================
-- Migration: 0010_backend_calculation_engine_and_rpcs.sql
-- Project  : MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger (Stage 8)
-- Ref      : nrdepkayabbbshnmyrvc
-- Purpose  : Backend-Driven Calculation Architecture (Single Authoritative
--            Calculation Engine in PostgreSQL Supabase):
--            1. Ensure payment account & PIN columns on app_settings &
--               kitchen_invoices, and team_paid_out_at / coop_paid_out_at on
--               profit_ledger_entries.
--            2. Authoritative fn_recalculate_order_financials(p_order_id) in
--               PostgreSQL (with Invariant 4 order-level split freeze).
--            3. Six SECURITY DEFINER Atomic RPCs:
--               - rpc_upsert_kitchen_order
--               - rpc_submit_courier_weighing_batch
--               - rpc_mark_invoice_paid
--               - rpc_execute_profit_payout
--               - rpc_update_app_settings
--               - rpc_admin_reset_data
--               Plus helper RPCs rpc_delete_order_item & rpc_delete_kitchen_order.
-- =============================================================================

-- 1. Ensure columns exist on app_settings, kitchen_invoices, and profit_ledger_entries
ALTER TABLE public.app_settings
    ADD COLUMN IF NOT EXISTS payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
    ADD COLUMN IF NOT EXISTS payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000',
    ADD COLUMN IF NOT EXISTS payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG';

ALTER TABLE public.app_settings
    ALTER COLUMN admin_pin SET DEFAULT '1122',
    ALTER COLUMN coop_pin SET DEFAULT '3344';

ALTER TABLE public.kitchen_invoices
    ADD COLUMN IF NOT EXISTS payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
    ADD COLUMN IF NOT EXISTS payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000',
    ADD COLUMN IF NOT EXISTS payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG';

ALTER TABLE public.profit_ledger_entries
    ADD COLUMN IF NOT EXISTS team_paid_out_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS coop_paid_out_at TIMESTAMPTZ;

-- 2. Core Authoritative Calculation Engine: fn_recalculate_order_financials
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
    v_total_invoice NUMERIC(15,2) := 0.00;
    v_gross_margin NUMERIC(15,2) := 0.00;
    v_team_pct NUMERIC(5,2) := 60.00;
    v_coop_pct NUMERIC(5,2) := 40.00;
    v_bank_name TEXT := 'BRI';
    v_account_number TEXT := '0000-0000-0000-000';
    v_account_holder TEXT := 'Bendahara Supplier MBG';
    v_locked_split RECORD;
    v_order_has_payout BOOLEAN := FALSE;
    v_item RECORD;
    v_eff_kg NUMERIC(12,3);
    v_item_gross NUMERIC(15,2);
    v_coop_amount NUMERIC(15,2);
    v_team_amount NUMERIC(15,2);
    v_existing_ple RECORD;
    v_ple_status TEXT;
BEGIN
    SELECT * INTO v_order FROM public.kitchen_orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT
        team_share_pct,
        coop_share_pct,
        COALESCE(NULLIF(TRIM(payment_bank_name), ''), 'BRI'),
        COALESCE(NULLIF(TRIM(payment_account_number), ''), '0000-0000-0000-000'),
        COALESCE(NULLIF(TRIM(payment_account_holder), ''), 'Bendahara Supplier MBG')
      INTO v_team_pct, v_coop_pct, v_bank_name, v_account_number, v_account_holder
      FROM public.app_settings
     WHERE id = 'default'
     LIMIT 1;

    IF v_team_pct IS NULL THEN
        v_team_pct := 60.00;
        v_coop_pct := 40.00;
    END IF;

    -- Invariant 4 (Freeze Paid Entries): If any share on this order was already paid out,
    -- freeze the split percentage for the entire order.
    SELECT team_share_pct, coop_share_pct
      INTO v_locked_split
      FROM public.profit_ledger_entries
     WHERE order_id = p_order_id
       AND (team_paid_out = TRUE OR coop_paid_out = TRUE)
     LIMIT 1;

    IF FOUND THEN
        v_order_has_payout := TRUE;
        v_team_pct := v_locked_split.team_share_pct;
        v_coop_pct := v_locked_split.coop_share_pct;
    END IF;

    -- Calculate total invoice and total gross margin using NUMERIC arithmetic
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE is_weighed = TRUE),
        COALESCE(ROUND(SUM(ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * kitchen_unit_price_rp, 2)), 2), 0.00),
        COALESCE(ROUND(SUM(ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * margin_per_kg_rp, 2)), 2), 0.00)
      INTO v_total_items, v_weighed_items, v_total_invoice, v_gross_margin
      FROM public.kitchen_order_items
     WHERE order_id = p_order_id;

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

    -- Upsert kitchen_invoices
    SELECT * INTO v_invoice FROM public.kitchen_invoices WHERE order_id = p_order_id;
    IF NOT FOUND AND v_total_items > 0 THEN
        INSERT INTO public.kitchen_invoices (
            id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
            total_amount_rp, amount_paid_rp, status,
            payment_bank_name, payment_account_number, payment_account_holder,
            created_at, updated_at
        ) VALUES (
            'inv-' || p_order_id,
            REPLACE(v_order.order_code, 'SJ-', 'INV-'),
            p_order_id,
            v_order.kitchen_id,
            v_order.order_date,
            v_order.order_date + 7,
            v_total_invoice,
            0.00,
            'UNPAID',
            v_bank_name,
            v_account_number,
            v_account_holder,
            NOW(),
            NOW()
        )
        RETURNING * INTO v_invoice;
    ELSIF FOUND THEN
        UPDATE public.kitchen_invoices
           SET total_amount_rp = v_total_invoice,
               amount_paid_rp = CASE WHEN status = 'PAID' THEN v_total_invoice ELSE amount_paid_rp END,
               payment_bank_name = COALESCE(NULLIF(TRIM(payment_bank_name), ''), v_bank_name),
               payment_account_number = COALESCE(NULLIF(TRIM(payment_account_number), ''), v_account_number),
               payment_account_holder = COALESCE(NULLIF(TRIM(payment_account_holder), ''), v_account_holder),
               updated_at = NOW()
         WHERE id = v_invoice.id
        RETURNING * INTO v_invoice;
    END IF;

    IF v_invoice.id IS NULL THEN
        RETURN;
    END IF;

    -- Upsert profit_ledger_entries for each item on the order
    FOR v_item IN
        SELECT * FROM public.kitchen_order_items WHERE order_id = p_order_id
    LOOP
        v_eff_kg := COALESCE(v_item.qty_accepted_kg, v_item.qty_ordered_kg);
        v_item_gross := ROUND(v_eff_kg * v_item.margin_per_kg_rp, 2);

        SELECT * INTO v_existing_ple
          FROM public.profit_ledger_entries
         WHERE id = 'ple-' || v_item.id OR order_item_id = v_item.id
         LIMIT 1;

        IF FOUND THEN
            -- Only recalculate amounts if neither side of this entry has been paid out yet
            IF v_existing_ple.team_paid_out = FALSE AND v_existing_ple.coop_paid_out = FALSE THEN
                v_coop_amount := ROUND(v_item_gross * (v_coop_pct / 100.0), 0);
                v_team_amount := v_item_gross - v_coop_amount;
                v_ple_status := CASE WHEN v_invoice.status = 'PAID' THEN 'AVAILABLE_FOR_PAYOUT' ELSE 'LOCKED_UNPAID' END;

                UPDATE public.profit_ledger_entries
                   SET order_id = p_order_id,
                       kitchen_id = v_order.kitchen_id,
                       gross_margin_rp = v_item_gross,
                       team_share_pct = v_team_pct,
                       coop_share_pct = v_coop_pct,
                       team_amount_rp = v_team_amount,
                       coop_amount_rp = v_coop_amount,
                       status = v_ple_status,
                       unlocked_at = CASE WHEN v_invoice.status = 'PAID' THEN COALESCE(unlocked_at, NOW()) ELSE NULL END,
                       updated_at = NOW()
                 WHERE id = v_existing_ple.id;
            END IF;
        ELSE
            v_coop_amount := ROUND(v_item_gross * (v_coop_pct / 100.0), 0);
            v_team_amount := v_item_gross - v_coop_amount;
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
                v_item_gross,
                v_team_pct,
                v_coop_pct,
                v_team_amount,
                v_coop_amount,
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

-- UUID overload forwarding to TEXT for callers passing ::UUID
CREATE OR REPLACE FUNCTION public.fn_recalculate_order_financials(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.fn_recalculate_order_financials(p_order_id::TEXT);
END;
$$;

-- 3. Six Official SECURITY DEFINER Atomic RPC Functions

-- 3.1 rpc_upsert_kitchen_order
CREATE OR REPLACE FUNCTION public.rpc_upsert_kitchen_order(
    p_kitchen_id TEXT,
    p_order_date DATE,
    p_items JSONB,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kitchen RECORD;
    v_date DATE := COALESCE(p_order_date, (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE);
    v_order RECORD;
    v_merged BOOLEAN := FALSE;
    v_seq INT := 1;
    v_order_id TEXT;
    v_order_code TEXT;
    v_elem JSONB;
    v_prod_id TEXT;
    v_prod RECORD;
    v_qty_kg NUMERIC(12,3);
    v_price_rp NUMERIC(15,2);
    v_margin_rp NUMERIC(15,2);
    v_item_id TEXT;
    v_inserted INT := 0;
BEGIN
    SELECT * INTO v_kitchen FROM public.kitchens WHERE id = p_kitchen_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dapur tujuan tidak ditemukan.';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Tambahkan minimal 1 barang pada order dapur.';
    END IF;

    -- Validate all lines before inserting
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_prod_id   := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_qty_kg    := ROUND(COALESCE((v_elem->>'qty_ordered_kg')::NUMERIC, 0), 3);
        v_price_rp  := ROUND(COALESCE((v_elem->>'kitchen_unit_price_rp')::NUMERIC, 0), 2);
        v_margin_rp := ROUND(COALESCE((v_elem->>'margin_per_kg_rp')::NUMERIC, 0), 2);

        IF v_prod_id IS NULL THEN
            RAISE EXCEPTION 'Pilih barang pada setiap baris order.';
        END IF;

        SELECT * INTO v_prod FROM public.products WHERE id = v_prod_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Barang (%) tidak ditemukan di master.', v_prod_id;
        END IF;

        IF v_qty_kg <= 0 THEN
            RAISE EXCEPTION '%: berat order (kg) harus lebih dari 0 (contoh: 12,5 atau 0,2).', v_prod.name;
        END IF;

        IF v_price_rp <= 0 THEN
            RAISE EXCEPTION '%: harga dapur / kg harus lebih dari Rp 0.', v_prod.name;
        END IF;

        IF v_margin_rp < 0 THEN
            RAISE EXCEPTION '%: margin per kg tidak boleh negatif.', v_prod.name;
        END IF;

        IF v_margin_rp > v_price_rp THEN
            RAISE EXCEPTION '%: margin per kg tidak boleh melebihi harga dapur per kg.', v_prod.name;
        END IF;
    END LOOP;

    -- Find open (UNPAID and no partial payout) order for this kitchen on v_date
    SELECT ko.*
      INTO v_order
      FROM public.kitchen_orders ko
      LEFT JOIN public.kitchen_invoices ki ON ki.order_id = ko.id
     WHERE ko.kitchen_id = p_kitchen_id
       AND ko.order_date = v_date
       AND COALESCE(ki.status, 'UNPAID') <> 'PAID'
       AND NOT EXISTS (
           SELECT 1 FROM public.profit_ledger_entries ple
           WHERE ple.order_id = ko.id
             AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
       )
     ORDER BY ko.created_at ASC
     LIMIT 1;

    IF FOUND THEN
        v_merged := TRUE;
        v_order_id := v_order.id;
        v_order_code := v_order.order_code;
        IF p_notes IS NOT NULL AND TRIM(p_notes) <> '' THEN
            UPDATE public.kitchen_orders
               SET notes = TRIM(p_notes),
                   updated_at = NOW()
             WHERE id = v_order_id;
        END IF;
    ELSE
        SELECT COUNT(*) + 1
          INTO v_seq
          FROM public.kitchen_orders
         WHERE kitchen_id = p_kitchen_id
           AND order_date = v_date;

        v_order_id := 'deliv-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 4);
        v_order_code := 'SJ-' || to_char(v_date, 'YYYYMMDD') || '-' || REPLACE(v_kitchen.code, '-', '') || '-' || LPAD(v_seq::TEXT, 2, '0');

        WHILE EXISTS (SELECT 1 FROM public.kitchen_orders WHERE order_code = v_order_code) LOOP
            v_seq := v_seq + 1;
            v_order_code := 'SJ-' || to_char(v_date, 'YYYYMMDD') || '-' || REPLACE(v_kitchen.code, '-', '') || '-' || LPAD(v_seq::TEXT, 2, '0');
        END LOOP;

        INSERT INTO public.kitchen_orders (
            id, order_code, kitchen_id, order_date, status, notes, created_at, updated_at
        ) VALUES (
            v_order_id, v_order_code, p_kitchen_id, v_date, 'IN_TRANSIT', NULLIF(TRIM(p_notes), ''), NOW(), NOW()
        );
    END IF;

    -- Insert order items
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_prod_id   := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_qty_kg    := ROUND((v_elem->>'qty_ordered_kg')::NUMERIC, 3);
        v_price_rp  := ROUND((v_elem->>'kitchen_unit_price_rp')::NUMERIC, 2);
        v_margin_rp := ROUND((v_elem->>'margin_per_kg_rp')::NUMERIC, 2);

        SELECT * INTO v_prod FROM public.products WHERE id = v_prod_id;

        IF EXISTS (
            SELECT 1 FROM public.kitchen_order_items
             WHERE order_id = v_order_id AND product_id = v_prod_id
        ) THEN
            RAISE EXCEPTION '% sudah ada pada order dapur ini.', v_prod.name;
        END IF;

        v_item_id := 'ditem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 5);

        INSERT INTO public.kitchen_order_items (
            id, order_id, product_id, product_name_snapshot,
            qty_ordered_kg, qty_accepted_kg,
            kitchen_unit_price_rp, margin_per_kg_rp,
            is_weighed, weighed_at, shrinkage_reason, shrinkage_note,
            created_at, updated_at
        ) VALUES (
            v_item_id, v_order_id, v_prod_id, v_prod.name,
            v_qty_kg, NULL,
            v_price_rp, v_margin_rp,
            FALSE, NULL, NULL, NULL,
            NOW(), NOW()
        );

        v_inserted := v_inserted + 1;
    END LOOP;

    PERFORM public.fn_recalculate_order_financials(v_order_id);

    RETURN jsonb_build_object(
        'ok', true,
        'order_id', v_order_id,
        'order_code', v_order_code,
        'merged', v_merged,
        'count', v_inserted
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_kitchen_order(TEXT, DATE, JSONB, TEXT) TO anon, authenticated;

-- 3.2 rpc_submit_courier_weighing_batch
CREATE OR REPLACE FUNCTION public.rpc_submit_courier_weighing_batch(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_elem JSONB;
    v_item_id TEXT;
    v_raw_kg NUMERIC(12,3);
    v_reason TEXT;
    v_note TEXT;
    v_item RECORD;
    v_inv RECORD;
    v_order_ids TEXT[] := ARRAY[]::TEXT[];
    v_oid TEXT;
    v_count INT := 0;
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Pilih minimal 1 barang untuk disimpan.';
    END IF;

    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_item_id := COALESCE(v_elem->>'item_id', v_elem->>'delivery_item_id');
        v_raw_kg  := ROUND((v_elem->>'qty_accepted_kg')::NUMERIC, 3);
        v_reason  := v_elem->>'shrinkage_reason';
        v_note    := v_elem->>'shrinkage_note';

        SELECT * INTO v_item FROM public.kitchen_order_items WHERE id = v_item_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Baris order % tidak ditemukan.', v_item_id;
        END IF;

        SELECT * INTO v_inv FROM public.kitchen_invoices WHERE order_id = v_item.order_id;
        IF FOUND AND v_inv.status = 'PAID' THEN
            RAISE EXCEPTION 'Invoice sudah lunas — timbangan terkunci.';
        END IF;

        IF v_raw_kg IS NULL OR NOT (v_raw_kg >= 0 AND v_raw_kg <= v_item.qty_ordered_kg * 2) THEN
            RAISE EXCEPTION 'Berat diterima (% kg) di luar batas valid (0 s/d % kg).',
                v_raw_kg, v_item.qty_ordered_kg * 2;
        END IF;

        IF v_raw_kg > v_item.qty_ordered_kg THEN
            RAISE EXCEPTION '%: berat diterima (% kg) melebihi berat order (% kg).',
                v_item.product_name_snapshot, v_raw_kg, v_item.qty_ordered_kg;
        END IF;

        UPDATE public.kitchen_order_items
           SET qty_accepted_kg = v_raw_kg,
               is_weighed = TRUE,
               weighed_at = NOW(),
               shrinkage_reason = CASE WHEN v_raw_kg < qty_ordered_kg THEN COALESCE(NULLIF(TRIM(v_reason), ''), 'Susut') ELSE NULL END,
               shrinkage_note = CASE WHEN v_raw_kg < qty_ordered_kg THEN NULLIF(TRIM(v_note), '') ELSE NULL END,
               updated_at = NOW()
         WHERE id = v_item_id;

        IF NOT (v_item.order_id = ANY(v_order_ids)) THEN
            v_order_ids := array_append(v_order_ids, v_item.order_id);
        END IF;

        v_count := v_count + 1;
    END LOOP;

    FOREACH v_oid IN ARRAY v_order_ids
    LOOP
        PERFORM public.fn_recalculate_order_financials(v_oid);
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'count', v_count,
        'order_ids', to_jsonb(v_order_ids)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_submit_courier_weighing_batch(JSONB) TO anon, authenticated;

-- Keep submit_courier_weighing_batch alias delegating to rpc_submit_courier_weighing_batch
CREATE OR REPLACE FUNCTION public.submit_courier_weighing_batch(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.rpc_submit_courier_weighing_batch(p_items);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_courier_weighing_batch(JSONB) TO anon, authenticated;

-- 3.3 rpc_mark_invoice_paid
CREATE OR REPLACE FUNCTION public.rpc_mark_invoice_paid(p_invoice_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inv RECORD;
BEGIN
    SELECT * INTO v_inv FROM public.kitchen_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice tidak ditemukan.';
    END IF;

    IF v_inv.status = 'PAID' THEN
        RAISE EXCEPTION 'Invoice ini sudah lunas.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.kitchen_order_items
         WHERE order_id = v_inv.order_id AND is_weighed = FALSE
    ) THEN
        RAISE EXCEPTION 'Belum semua barang ditimbang kurir — tagihan belum final.';
    END IF;

    PERFORM public.fn_recalculate_order_financials(v_inv.order_id);

    UPDATE public.kitchen_invoices
       SET status = 'PAID',
           paid_at = NOW(),
           amount_paid_rp = total_amount_rp,
           updated_at = NOW()
     WHERE id = p_invoice_id
    RETURNING * INTO v_inv;

    UPDATE public.profit_ledger_entries
       SET status = CASE
               WHEN team_paid_out AND coop_paid_out THEN 'PAID_OUT'
               ELSE 'AVAILABLE_FOR_PAYOUT'
           END,
           unlocked_at = COALESCE(unlocked_at, NOW()),
           updated_at = NOW()
     WHERE invoice_id = p_invoice_id;

    RETURN jsonb_build_object(
        'ok', true,
        'invoice_id', v_inv.id,
        'invoice_code', v_inv.invoice_code,
        'total_amount_rp', v_inv.total_amount_rp,
        'status', v_inv.status,
        'paid_at', v_inv.paid_at
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_mark_invoice_paid(TEXT) TO anon, authenticated;

-- 3.4 rpc_execute_profit_payout
CREATE OR REPLACE FUNCTION public.rpc_execute_profit_payout(
    p_target TEXT,
    p_entry_ids TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target TEXT := UPPER(TRIM(COALESCE(p_target, '')));
    v_filter_ids BOOLEAN := (p_entry_ids IS NOT NULL AND COALESCE(cardinality(p_entry_ids), 0) > 0);
    v_now TIMESTAMPTZ := NOW();
    v_today DATE := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
    v_team_total NUMERIC(15,2) := 0.00;
    v_team_cnt INT := 0;
    v_team_batch_id TEXT := NULL;
    v_team_ref TEXT := NULL;
    v_coop_total NUMERIC(15,2) := 0.00;
    v_coop_cnt INT := 0;
    v_coop_batch_id TEXT := NULL;
    v_coop_ref TEXT := NULL;
    v_seq INT := 1;
BEGIN
    IF v_target = 'ALL' THEN
        v_target := 'BOTH';
    END IF;

    IF v_target NOT IN ('TEAM', 'COOPERATIVE', 'BOTH') THEN
        RAISE EXCEPTION 'Target pencairan harus TEAM, COOPERATIVE, atau BOTH.';
    END IF;

    -- TEAM payout
    IF v_target IN ('TEAM', 'BOTH') THEN
        SELECT COALESCE(ROUND(SUM(team_amount_rp), 2), 0.00), COUNT(*)
          INTO v_team_total, v_team_cnt
          FROM public.profit_ledger_entries
         WHERE status = 'AVAILABLE_FOR_PAYOUT'
           AND team_paid_out = FALSE
           AND (
               NOT v_filter_ids
               OR id = ANY(p_entry_ids)
               OR (id || '-team') = ANY(p_entry_ids)
               OR order_item_id = ANY(p_entry_ids)
           );

        IF v_team_cnt > 0 AND v_team_total > 0 THEN
            SELECT COUNT(*) + 1 INTO v_seq FROM public.profit_payout_batches;
            v_team_batch_id := 'pbatch-team-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 4);
            v_team_ref := 'POUT-' || to_char(v_today, 'YYYYMMDD') || '-TIM-' || LPAD(v_seq::TEXT, 2, '0');

            WHILE EXISTS (SELECT 1 FROM public.profit_payout_batches WHERE payout_reference = v_team_ref) LOOP
                v_seq := v_seq + 1;
                v_team_ref := 'POUT-' || to_char(v_today, 'YYYYMMDD') || '-TIM-' || LPAD(v_seq::TEXT, 2, '0');
            END LOOP;

            INSERT INTO public.profit_payout_batches (
                id, payout_reference, beneficiary_type, total_payout_amount,
                transfer_proof_url, notes, disbursed_by, disbursed_at, created_at
            ) VALUES (
                v_team_batch_id, v_team_ref, 'TEAM', v_team_total,
                'https://storage.mbg.id/payouts/' || lower(v_team_ref) || '.jpg',
                'Pencairan bagi hasil Tim (' || v_team_cnt || ' baris)',
                'user-admin-01', v_now, v_now
            );

            UPDATE public.profit_ledger_entries
               SET team_paid_out = TRUE,
                   team_paid_out_at = v_now,
                   team_payout_batch_id = v_team_batch_id,
                   paid_out_at = v_now,
                   status = CASE WHEN coop_paid_out THEN 'PAID_OUT' ELSE 'AVAILABLE_FOR_PAYOUT' END,
                   updated_at = v_now
             WHERE status = 'AVAILABLE_FOR_PAYOUT'
               AND team_paid_out = FALSE
               AND (
                   NOT v_filter_ids
                   OR id = ANY(p_entry_ids)
                   OR (id || '-team') = ANY(p_entry_ids)
                   OR order_item_id = ANY(p_entry_ids)
               );
        END IF;
    END IF;

    -- COOPERATIVE payout
    IF v_target IN ('COOPERATIVE', 'BOTH') THEN
        SELECT COALESCE(ROUND(SUM(coop_amount_rp), 2), 0.00), COUNT(*)
          INTO v_coop_total, v_coop_cnt
          FROM public.profit_ledger_entries
         WHERE status = 'AVAILABLE_FOR_PAYOUT'
           AND coop_paid_out = FALSE
           AND (
               NOT v_filter_ids
               OR id = ANY(p_entry_ids)
               OR (id || '-coop') = ANY(p_entry_ids)
               OR order_item_id = ANY(p_entry_ids)
           );

        IF v_coop_cnt > 0 AND v_coop_total > 0 THEN
            SELECT COUNT(*) + 1 INTO v_seq FROM public.profit_payout_batches;
            v_coop_batch_id := 'pbatch-coop-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 4);
            v_coop_ref := 'POUT-' || to_char(v_today, 'YYYYMMDD') || '-KOP-' || LPAD(v_seq::TEXT, 2, '0');

            WHILE EXISTS (SELECT 1 FROM public.profit_payout_batches WHERE payout_reference = v_coop_ref) LOOP
                v_seq := v_seq + 1;
                v_coop_ref := 'POUT-' || to_char(v_today, 'YYYYMMDD') || '-KOP-' || LPAD(v_seq::TEXT, 2, '0');
            END LOOP;

            INSERT INTO public.profit_payout_batches (
                id, payout_reference, beneficiary_type, total_payout_amount,
                transfer_proof_url, notes, disbursed_by, disbursed_at, created_at
            ) VALUES (
                v_coop_batch_id, v_coop_ref, 'COOPERATIVE', v_coop_total,
                'https://storage.mbg.id/payouts/' || lower(v_coop_ref) || '.jpg',
                'Pencairan bagi hasil Koperasi (' || v_coop_cnt || ' baris)',
                'user-admin-01', v_now, v_now
            );

            UPDATE public.profit_ledger_entries
               SET coop_paid_out = TRUE,
                   coop_paid_out_at = v_now,
                   coop_payout_batch_id = v_coop_batch_id,
                   paid_out_at = v_now,
                   status = CASE WHEN team_paid_out THEN 'PAID_OUT' ELSE 'AVAILABLE_FOR_PAYOUT' END,
                   updated_at = v_now
             WHERE status = 'AVAILABLE_FOR_PAYOUT'
               AND coop_paid_out = FALSE
               AND (
                   NOT v_filter_ids
                   OR id = ANY(p_entry_ids)
                   OR (id || '-coop') = ANY(p_entry_ids)
                   OR order_item_id = ANY(p_entry_ids)
               );
        END IF;
    END IF;

    IF v_team_cnt = 0 AND v_coop_cnt = 0 THEN
        RAISE EXCEPTION 'Tidak ada saldo Siap Dicairkan untuk pilihan ini.';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'target', v_target,
        'count', v_team_cnt + v_coop_cnt,
        'team_count', v_team_cnt,
        'coop_count', v_coop_cnt,
        'team_payout_rp', v_team_total,
        'coop_payout_rp', v_coop_total,
        'total_payout_rp', v_team_total + v_coop_total
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_execute_profit_payout(TEXT, TEXT[]) TO anon, authenticated;

-- 3.5 rpc_update_app_settings
CREATE OR REPLACE FUNCTION public.rpc_update_app_settings(
    p_team_pct NUMERIC,
    p_coop_pct NUMERIC,
    p_bank_name TEXT DEFAULT NULL,
    p_account_number TEXT DEFAULT NULL,
    p_account_holder TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_team NUMERIC(5,2) := ROUND(COALESCE(p_team_pct, 60.00), 2);
    v_coop NUMERIC(5,2) := ROUND(COALESCE(p_coop_pct, 40.00), 2);
    v_cur RECORD;
    v_bank TEXT;
    v_acc_no TEXT;
    v_acc_holder TEXT;
    v_order_rec RECORD;
BEGIN
    IF v_team < 0 OR v_coop < 0 OR ROUND(v_team + v_coop, 2) <> 100.00 THEN
        RAISE EXCEPTION 'Total persentase Tim + Koperasi harus tepat 100%%.';
    END IF;

    SELECT * INTO v_cur FROM public.app_settings WHERE id = 'default' LIMIT 1;

    v_bank       := COALESCE(NULLIF(TRIM(p_bank_name), ''), v_cur.payment_bank_name, 'BRI');
    v_acc_no     := COALESCE(NULLIF(TRIM(p_account_number), ''), v_cur.payment_account_number, '0000-0000-0000-000');
    v_acc_holder := COALESCE(NULLIF(TRIM(p_account_holder), ''), v_cur.payment_account_holder, 'Bendahara Supplier MBG');

    INSERT INTO public.app_settings (
        id, team_share_pct, coop_share_pct,
        admin_pin, coop_pin,
        payment_bank_name, payment_account_number, payment_account_holder,
        updated_at
    ) VALUES (
        'default', v_team, v_coop,
        COALESCE(v_cur.admin_pin, '1122'), COALESCE(v_cur.coop_pin, '3344'),
        v_bank, v_acc_no, v_acc_holder,
        NOW()
    )
    ON CONFLICT (id) DO UPDATE
       SET team_share_pct = EXCLUDED.team_share_pct,
           coop_share_pct = EXCLUDED.coop_share_pct,
           payment_bank_name = EXCLUDED.payment_bank_name,
           payment_account_number = EXCLUDED.payment_account_number,
           payment_account_holder = EXCLUDED.payment_account_holder,
           updated_at = NOW();

    UPDATE public.profit_split_configs
       SET config_name = 'Skema Bagi Hasil Standar Tim ' || TRIM(TO_CHAR(v_team, 'FM990.##')) || '% : Koperasi ' || TRIM(TO_CHAR(v_coop, 'FM990.##')) || '%',
           team_share_pct = v_team,
           cooperative_share_pct = v_coop,
           payment_bank_name = v_bank,
           payment_account_number = v_acc_no,
           payment_account_holder = v_acc_holder
     WHERE id = 'split-default-60-40' OR is_active = TRUE;

    -- Update payment account snapshot on all UNPAID invoices
    UPDATE public.kitchen_invoices
       SET payment_bank_name = v_bank,
           payment_account_number = v_acc_no,
           payment_account_holder = v_acc_holder,
           updated_at = NOW()
     WHERE status <> 'PAID';

    -- Recalculate all orders where neither TEAM nor COOPERATIVE has been paid out yet
    FOR v_order_rec IN
        SELECT ko.id
          FROM public.kitchen_orders ko
         WHERE NOT EXISTS (
             SELECT 1
               FROM public.profit_ledger_entries ple
              WHERE ple.order_id = ko.id
                AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
         )
    LOOP
        PERFORM public.fn_recalculate_order_financials(v_order_rec.id);
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'team_share_pct', v_team,
        'coop_share_pct', v_coop,
        'payment_bank_name', v_bank,
        'payment_account_number', v_acc_no,
        'payment_account_holder', v_acc_holder
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_app_settings(NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO anon, authenticated;

-- 3.6 rpc_admin_reset_data
CREATE OR REPLACE FUNCTION public.rpc_admin_reset_data(
    p_mode TEXT,
    p_admin_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_mode TEXT := UPPER(TRIM(COALESCE(p_mode, '')));
    v_expected_pin TEXT;
BEGIN
    SELECT COALESCE(NULLIF(TRIM(admin_pin), ''), '1122')
      INTO v_expected_pin
      FROM public.app_settings
     WHERE id = 'default'
     LIMIT 1;
    v_expected_pin := COALESCE(v_expected_pin, '1122');

    IF p_admin_pin IS NULL OR TRIM(p_admin_pin) <> v_expected_pin THEN
        RAISE EXCEPTION 'PIN Admin tidak valid — operasi ditolak.';
    END IF;

    IF v_mode = 'CLEAR_TRANSACTIONS' THEN
        RETURN public.clear_all_transactions(p_admin_pin);
    ELSIF v_mode = 'RESET_SEED' THEN
        RETURN public.reset_to_simulation_seed(p_admin_pin);
    ELSE
        RAISE EXCEPTION 'Mode reset (%) tidak dikenal. Gunakan CLEAR_TRANSACTIONS atau RESET_SEED.', p_mode;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_admin_reset_data(TEXT, TEXT) TO anon, authenticated;
