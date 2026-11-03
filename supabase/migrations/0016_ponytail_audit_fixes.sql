-- =============================================================================
-- Migration: 0016_ponytail_audit_fixes.sql
-- Purpose  : Address Ponytail Audit Findings #1, #2, #3, #4, and #5:
--            1. Hide `admin_pin` and `coop_pin` from anon/authenticated SELECT
--               on `public.app_settings` and revoke direct client writes on
--               `app_settings`, `kitchen_invoices`, `profit_ledger_entries`,
--               `profit_payout_batches`, and `profit_split_configs`.
--            2. Preserve `qty_ordered_kg`, `shrinkage_reason`, and `shrinkage_note`
--               in `rpc_update_kitchen_order` when an item's accepted weight is
--               not changed.
--            3. Block deleting the last item of a PAID invoice in both
--               `fn_guard_kitchen_order_item_delete` and `fn_recalculate_order_financials`.
--            4. Add transaction advisory locks and `FOR UPDATE` row locks in
--               `rpc_upsert_kitchen_order` and `rpc_execute_profit_payout` to
--               prevent race conditions and duplicate payouts.
--            5. Skip per-row `trg_kitchen_order_items_recalc` during bulk RPC
--               loops (`mbg.skip_item_recalc_trigger = 'on'`) so order saves
--               run `fn_recalculate_order_financials` once instead of N+1 times.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Security Hardening (#1): Column-level SELECT on app_settings & revoke
--    direct anon/authenticated writes on server-managed financial tables
-- =============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.app_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT (
    id,
    team_share_pct,
    coop_share_pct,
    supplier_name,
    payment_bank_name,
    payment_account_number,
    payment_account_holder,
    updated_at
) ON public.app_settings TO anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.kitchen_invoices FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.profit_ledger_entries FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.profit_payout_batches FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.profit_split_configs FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 2. Trigger Guard (#3) & Skip Flag for Bulk RPCs (#5)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_kitchen_order_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profit_ledger_entries ple
    WHERE (ple.order_item_id = OLD.id OR ple.order_id = OLD.order_id)
      AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
  ) THEN
    RAISE EXCEPTION 'Bagi hasil untuk order ini sudah dicairkan — baris barang tidak dapat diubah atau dihapus.';
  END IF;

  -- Block deleting the last remaining item of a PAID invoice
  IF EXISTS (
    SELECT 1
    FROM public.kitchen_invoices ki
    WHERE ki.order_id = OLD.order_id
      AND ki.status = 'PAID'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.kitchen_order_items koi
    WHERE koi.order_id = OLD.order_id
      AND koi.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'Order dengan invoice lunas harus memiliki minimal 1 barang.';
  END IF;

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trg_kitchen_order_items_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_id TEXT := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
    IF current_setting('mbg.skip_item_recalc_trigger', true) = 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM public.fn_recalculate_order_financials(v_order_id);
    RETURN NULL;
END;
$$;

-- =============================================================================
-- 3. Authoritative Recalculation Engine (#3: forbid 0-item PAID order)
-- =============================================================================

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
    v_team_pct NUMERIC(5,2) := 60.00;
    v_coop_pct NUMERIC(5,2) := 40.00;
    v_supplier_name TEXT := 'Supplier MBG';
    v_bank_name TEXT := 'BRI';
    v_account_number TEXT := '0000-0000-0000-000';
    v_account_holder TEXT := 'Bendahara Supplier MBG';
    v_locked_split RECORD;
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
        COUNT(*),
        COUNT(*) FILTER (WHERE is_weighed = TRUE),
        COALESCE(ROUND(SUM(ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * kitchen_unit_price_rp, 2)), 2), 0.00)
      INTO v_total_items, v_weighed_items, v_total_invoice
      FROM public.kitchen_order_items
     WHERE order_id = p_order_id;

    IF v_total_items = 0 THEN
        IF EXISTS (
            SELECT 1 FROM public.kitchen_invoices
             WHERE order_id = p_order_id AND status = 'PAID'
        ) THEN
            RAISE EXCEPTION 'Order dengan invoice lunas harus memiliki minimal 1 barang.';
        END IF;

        DELETE FROM public.kitchen_orders WHERE id = p_order_id;
        RETURN;
    END IF;

    SELECT
        team_share_pct,
        coop_share_pct,
        COALESCE(NULLIF(TRIM(supplier_name), ''), 'Supplier MBG'),
        COALESCE(NULLIF(TRIM(payment_bank_name), ''), 'BRI'),
        COALESCE(NULLIF(TRIM(payment_account_number), ''), '0000-0000-0000-000'),
        COALESCE(NULLIF(TRIM(payment_account_holder), ''), 'Bendahara Supplier MBG')
      INTO v_team_pct, v_coop_pct, v_supplier_name, v_bank_name, v_account_number, v_account_holder
      FROM public.app_settings
     WHERE id = 'default'
     LIMIT 1;

    IF v_team_pct IS NULL THEN
        v_team_pct := 60.00;
        v_coop_pct := 40.00;
    END IF;

    SELECT team_share_pct, coop_share_pct
      INTO v_locked_split
      FROM public.profit_ledger_entries
     WHERE order_id = p_order_id
       AND (team_paid_out = TRUE OR coop_paid_out = TRUE)
     LIMIT 1;

    IF FOUND THEN
        v_team_pct := v_locked_split.team_share_pct;
        v_coop_pct := v_locked_split.coop_share_pct;
    END IF;

    IF v_weighed_items = v_total_items THEN
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

    SELECT * INTO v_invoice FROM public.kitchen_invoices WHERE order_id = p_order_id;
    IF NOT FOUND THEN
        INSERT INTO public.kitchen_invoices (
            id, invoice_code, order_id, kitchen_id, invoice_date, due_date,
            total_amount_rp, amount_paid_rp, status,
            supplier_name, payment_bank_name, payment_account_number, payment_account_holder,
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
            v_supplier_name,
            v_bank_name,
            v_account_number,
            v_account_holder,
            NOW(),
            NOW()
        )
        RETURNING * INTO v_invoice;
    ELSE
        UPDATE public.kitchen_invoices
           SET kitchen_id = v_order.kitchen_id,
               invoice_date = v_order.order_date,
               due_date = v_order.order_date + 7,
               total_amount_rp = v_total_invoice,
               amount_paid_rp = CASE WHEN status = 'PAID' THEN v_total_invoice ELSE amount_paid_rp END,
               supplier_name = CASE WHEN status = 'PAID' THEN COALESCE(NULLIF(TRIM(supplier_name), ''), v_supplier_name) ELSE v_supplier_name END,
               payment_bank_name = CASE WHEN status = 'PAID' THEN COALESCE(NULLIF(TRIM(payment_bank_name), ''), v_bank_name) ELSE v_bank_name END,
               payment_account_number = CASE WHEN status = 'PAID' THEN COALESCE(NULLIF(TRIM(payment_account_number), ''), v_account_number) ELSE v_account_number END,
               payment_account_holder = CASE WHEN status = 'PAID' THEN COALESCE(NULLIF(TRIM(payment_account_holder), ''), v_account_holder) ELSE v_account_holder END,
               updated_at = NOW()
         WHERE id = v_invoice.id
        RETURNING * INTO v_invoice;
    END IF;

    DELETE FROM public.profit_ledger_entries ple
     WHERE ple.invoice_id = v_invoice.id
       AND ple.order_item_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.kitchen_order_items koi WHERE koi.id = ple.order_item_id
       )
       AND ple.team_paid_out = FALSE
       AND ple.coop_paid_out = FALSE;

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
            IF v_existing_ple.team_paid_out = FALSE AND v_existing_ple.coop_paid_out = FALSE THEN
                v_coop_amount := ROUND(v_item_gross * (v_coop_pct / 100.0), 2);
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
            v_coop_amount := ROUND(v_item_gross * (v_coop_pct / 100.0), 2);
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

-- =============================================================================
-- 4. rpc_upsert_kitchen_order (#4 advisory lock + #5 skip per-row recalc trigger)
-- =============================================================================

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

    -- Serialize concurrent order creation for the same kitchen and date
    PERFORM pg_advisory_xact_lock(hashtext('mbg_order_' || p_kitchen_id || '_' || v_date::TEXT));
    PERFORM set_config('mbg.skip_item_recalc_trigger', 'on', true);

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
     LIMIT 1
     FOR UPDATE OF ko;

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
            v_order_id, v_order_code, p_kitchen_id, v_date, 'BAST_VERIFIED', NULLIF(TRIM(p_notes), ''), NOW(), NOW()
        );
    END IF;

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
            v_qty_kg, v_qty_kg,
            v_price_rp, v_margin_rp,
            TRUE, NOW(), NULL, NULL,
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

-- =============================================================================
-- 5. rpc_update_kitchen_order (#2 preserve shrinkage when weight is unchanged + #5 skip trigger)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_update_kitchen_order(
    p_order_id TEXT,
    p_kitchen_id TEXT,
    p_order_date DATE,
    p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order RECORD;
    v_kitchen RECORD;
    v_date DATE := COALESCE(p_order_date, (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE);
    v_elem JSONB;
    v_line_id TEXT;
    v_prod_id TEXT;
    v_prod RECORD;
    v_prev_item RECORD;
    v_qty_kg NUMERIC(12,3);
    v_accepted_kg NUMERIC(12,3);
    v_ordered_kg NUMERIC(12,3);
    v_price_rp NUMERIC(15,2);
    v_margin_rp NUMERIC(15,2);
    v_seen_products TEXT[] := ARRAY[]::TEXT[];
    v_kept_item_ids TEXT[] := ARRAY[]::TEXT[];
    v_count INT := 0;
BEGIN
    SELECT * INTO v_order FROM public.kitchen_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order dapur tidak ditemukan.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.profit_ledger_entries ple
        WHERE ple.order_id = p_order_id
          AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
    ) THEN
        RAISE EXCEPTION 'Bagi hasil untuk order ini sudah dicairkan — order dan invoice tidak dapat diubah.';
    END IF;

    SELECT * INTO v_kitchen FROM public.kitchens WHERE id = p_kitchen_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dapur tujuan tidak ditemukan.';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Order harus memiliki minimal 1 barang.';
    END IF;

    PERFORM set_config('mbg.skip_item_recalc_trigger', 'on', true);

    -- Validate all lines first
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_prod_id   := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_qty_kg    := ROUND(COALESCE((v_elem->>'qty_accepted_kg')::NUMERIC, (v_elem->>'qty_ordered_kg')::NUMERIC, 0), 3);
        v_price_rp  := ROUND(COALESCE((v_elem->>'kitchen_unit_price_rp')::NUMERIC, 0), 2);
        v_margin_rp := ROUND(COALESCE((v_elem->>'margin_per_kg_rp')::NUMERIC, 0), 2);

        IF v_prod_id IS NULL THEN
            RAISE EXCEPTION 'Pilih barang pada setiap baris.';
        END IF;

        SELECT * INTO v_prod FROM public.products WHERE id = v_prod_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Barang (%) tidak ditemukan di master.', v_prod_id;
        END IF;

        IF v_prod_id = ANY(v_seen_products) THEN
            RAISE EXCEPTION '% tidak boleh duplikat dalam satu order/invoice.', v_prod.name;
        END IF;
        v_seen_products := array_append(v_seen_products, v_prod_id);

        IF v_qty_kg <= 0 THEN
            RAISE EXCEPTION '%: berat (kg) harus lebih dari 0.', v_prod.name;
        END IF;

        IF v_price_rp <= 0 THEN
            RAISE EXCEPTION '%: harga dapur / kg harus lebih dari Rp 0.', v_prod.name;
        END IF;

        IF v_margin_rp < 0 THEN
            RAISE EXCEPTION '%: margin / kg tidak boleh negatif.', v_prod.name;
        END IF;

        IF v_margin_rp > v_price_rp THEN
            RAISE EXCEPTION '%: margin / kg tidak boleh melebihi harga dapur / kg.', v_prod.name;
        END IF;
    END LOOP;

    -- Update order header
    UPDATE public.kitchen_orders
       SET kitchen_id = p_kitchen_id,
           order_date = v_date,
           updated_at = NOW()
     WHERE id = p_order_id;

    -- Upsert items and collect kept item IDs
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_line_id     := NULLIF(TRIM(COALESCE(v_elem->>'id', v_elem->>'delivery_item_id', '')), '');
        v_prod_id     := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_accepted_kg := ROUND(COALESCE((v_elem->>'qty_accepted_kg')::NUMERIC, (v_elem->>'qty_ordered_kg')::NUMERIC), 3);
        v_ordered_kg  := ROUND(COALESCE((v_elem->>'qty_ordered_kg')::NUMERIC, v_accepted_kg), 3);
        v_price_rp    := ROUND((v_elem->>'kitchen_unit_price_rp')::NUMERIC, 2);
        v_margin_rp   := ROUND((v_elem->>'margin_per_kg_rp')::NUMERIC, 2);

        SELECT * INTO v_prod FROM public.products WHERE id = v_prod_id;

        IF v_line_id IS NOT NULL THEN
            SELECT * INTO v_prev_item
              FROM public.kitchen_order_items
             WHERE id = v_line_id AND order_id = p_order_id;
        ELSE
            v_prev_item := NULL;
        END IF;

        IF v_prev_item.id IS NOT NULL THEN
            -- Preserve original ordered weight & shrinkage note when accepted weight & product are unchanged
            IF v_prev_item.product_id = v_prod_id
               AND COALESCE(v_prev_item.qty_accepted_kg, v_prev_item.qty_ordered_kg) = v_accepted_kg
            THEN
                v_ordered_kg := GREATEST(v_prev_item.qty_ordered_kg, v_accepted_kg);
                UPDATE public.kitchen_order_items
                   SET kitchen_unit_price_rp = v_price_rp,
                       margin_per_kg_rp = v_margin_rp,
                       qty_ordered_kg = v_ordered_kg,
                       qty_accepted_kg = v_accepted_kg,
                       is_weighed = TRUE,
                       weighed_at = COALESCE(weighed_at, NOW()),
                       updated_at = NOW()
                 WHERE id = v_line_id
                   AND order_id = p_order_id;
            ELSE
                v_ordered_kg := GREATEST(v_ordered_kg, v_accepted_kg);
                UPDATE public.kitchen_order_items
                   SET product_id = v_prod_id,
                       product_name_snapshot = v_prod.name,
                       qty_ordered_kg = v_ordered_kg,
                       qty_accepted_kg = v_accepted_kg,
                       kitchen_unit_price_rp = v_price_rp,
                       margin_per_kg_rp = v_margin_rp,
                       is_weighed = TRUE,
                       weighed_at = COALESCE(weighed_at, NOW()),
                       shrinkage_reason = CASE WHEN v_ordered_kg > v_accepted_kg THEN COALESCE(shrinkage_reason, 'Susut') ELSE NULL END,
                       shrinkage_note = CASE WHEN v_ordered_kg > v_accepted_kg THEN shrinkage_note ELSE NULL END,
                       updated_at = NOW()
                 WHERE id = v_line_id
                   AND order_id = p_order_id;
            END IF;
        ELSE
            v_ordered_kg := GREATEST(v_ordered_kg, v_accepted_kg);
            v_line_id := 'ditem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 5);
            INSERT INTO public.kitchen_order_items (
                id, order_id, product_id, product_name_snapshot,
                qty_ordered_kg, qty_accepted_kg,
                kitchen_unit_price_rp, margin_per_kg_rp,
                is_weighed, weighed_at, shrinkage_reason, shrinkage_note,
                created_at, updated_at
            ) VALUES (
                v_line_id, p_order_id, v_prod_id, v_prod.name,
                v_ordered_kg, v_accepted_kg,
                v_price_rp, v_margin_rp,
                TRUE, NOW(), NULL, NULL,
                NOW(), NOW()
            );
        END IF;

        v_kept_item_ids := array_append(v_kept_item_ids, v_line_id);
        v_count := v_count + 1;
    END LOOP;

    -- Delete removed lines from this order
    DELETE FROM public.kitchen_order_items
     WHERE order_id = p_order_id
       AND NOT (id = ANY(v_kept_item_ids));

    PERFORM public.fn_recalculate_order_financials(p_order_id);

    RETURN jsonb_build_object(
        'ok', true,
        'order_id', p_order_id,
        'count', v_count
    );
END;
$$;

-- =============================================================================
-- 6. rpc_execute_profit_payout (#4 lock rows to prevent concurrent double payout)
-- =============================================================================

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

    -- Serialize concurrent payout executions and lock eligible ledger rows
    PERFORM pg_advisory_xact_lock(hashtext('mbg_profit_payout'));
    PERFORM 1
       FROM public.profit_ledger_entries
      WHERE status = 'AVAILABLE_FOR_PAYOUT'
        AND (team_paid_out = FALSE OR coop_paid_out = FALSE)
      FOR UPDATE;

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

COMMIT;
