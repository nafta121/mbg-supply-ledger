-- =============================================================================
-- Migration: 0015_edit_order_invoice_rpc.sql
-- Purpose  : 1. Add `rpc_update_kitchen_order` SECURITY DEFINER RPC so Admin
--               can edit order/invoice date, kitchen, items, quantities (kg),
--               kitchen unit prices (Rp), and margins (Rp) atomically.
--            2. Update `fn_recalculate_order_financials` so editing order_date
--               or kitchen_id also syncs `kitchen_invoices.invoice_date`,
--               `due_date`, and `kitchen_id`.
--            3. Allow editing order items on invoices as long as profit shares
--               have not been disbursed (`team_paid_out = FALSE AND coop_paid_out = FALSE`).
--            4. Avoid duplicate order recalculation in `rpc_update_app_settings`
--               when only supplier/bank details change.
-- =============================================================================

BEGIN;

-- 1. Drop redundant trigger on app_settings (rpc_update_app_settings handles updates directly)
DROP TRIGGER IF EXISTS trg_app_settings_split_change ON public.app_settings;

-- 2. Relax item delete guard so Admin can edit lines on an order/invoice
--    as long as profit sharing has NOT been disbursed yet.
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

  RETURN OLD;
END;
$$;

-- 3. Update fn_recalculate_order_financials to also sync invoice_date, due_date, and kitchen_id
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
        DELETE FROM public.kitchen_orders
         WHERE id = p_order_id
           AND NOT EXISTS (
               SELECT 1 FROM public.kitchen_invoices
                WHERE order_id = p_order_id AND status = 'PAID'
           );
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

-- 4. Optimize rpc_update_app_settings so it only recalculates orders when split percentages change
CREATE OR REPLACE FUNCTION public.rpc_update_app_settings(
    p_team_pct NUMERIC,
    p_coop_pct NUMERIC,
    p_bank_name TEXT DEFAULT NULL,
    p_account_number TEXT DEFAULT NULL,
    p_account_holder TEXT DEFAULT NULL,
    p_supplier_name TEXT DEFAULT NULL
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
    v_supplier TEXT;
    v_bank TEXT;
    v_acc_no TEXT;
    v_acc_holder TEXT;
    v_split_changed BOOLEAN := TRUE;
    v_order_rec RECORD;
BEGIN
    IF v_team < 0 OR v_coop < 0 OR ROUND(v_team + v_coop, 2) <> 100.00 THEN
        RAISE EXCEPTION 'Total persentase Tim + Koperasi harus tepat 100%%.';
    END IF;

    SELECT * INTO v_cur FROM public.app_settings WHERE id = 'default' LIMIT 1;
    IF FOUND THEN
        v_split_changed := (v_cur.team_share_pct IS DISTINCT FROM v_team OR v_cur.coop_share_pct IS DISTINCT FROM v_coop);
    END IF;

    v_supplier   := COALESCE(NULLIF(TRIM(p_supplier_name), ''), v_cur.supplier_name, 'Supplier MBG');
    v_bank       := COALESCE(NULLIF(TRIM(p_bank_name), ''), v_cur.payment_bank_name, 'BRI');
    v_acc_no     := COALESCE(NULLIF(TRIM(p_account_number), ''), v_cur.payment_account_number, '0000-0000-0000-000');
    v_acc_holder := COALESCE(NULLIF(TRIM(p_account_holder), ''), v_cur.payment_account_holder, 'Bendahara Supplier MBG');

    INSERT INTO public.app_settings (
        id, team_share_pct, coop_share_pct,
        admin_pin, coop_pin,
        supplier_name, payment_bank_name, payment_account_number, payment_account_holder,
        updated_at
    ) VALUES (
        'default', v_team, v_coop,
        COALESCE(v_cur.admin_pin, '1122'), COALESCE(v_cur.coop_pin, '3344'),
        v_supplier, v_bank, v_acc_no, v_acc_holder,
        NOW()
    )
    ON CONFLICT (id) DO UPDATE
       SET team_share_pct = EXCLUDED.team_share_pct,
           coop_share_pct = EXCLUDED.coop_share_pct,
           supplier_name = EXCLUDED.supplier_name,
           payment_bank_name = EXCLUDED.payment_bank_name,
           payment_account_number = EXCLUDED.payment_account_number,
           payment_account_holder = EXCLUDED.payment_account_holder,
           updated_at = NOW();

    UPDATE public.profit_split_configs
       SET config_name = 'Skema Bagi Hasil Standar Tim ' || TRIM(TO_CHAR(v_team, 'FM990.##')) || '% : Koperasi ' || TRIM(TO_CHAR(v_coop, 'FM990.##')) || '%',
           team_share_pct = v_team,
           cooperative_share_pct = v_coop,
           supplier_name = v_supplier,
           payment_bank_name = v_bank,
           payment_account_number = v_acc_no,
           payment_account_holder = v_acc_holder
     WHERE id = 'split-default-60-40' OR is_active = TRUE;

    UPDATE public.kitchen_invoices
       SET supplier_name = v_supplier,
           payment_bank_name = v_bank,
           payment_account_number = v_acc_no,
           payment_account_holder = v_acc_holder,
           updated_at = NOW()
     WHERE status <> 'PAID';

    IF v_split_changed THEN
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
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'team_share_pct', v_team,
        'coop_share_pct', v_coop,
        'supplier_name', v_supplier,
        'payment_bank_name', v_bank,
        'payment_account_number', v_acc_no,
        'payment_account_holder', v_acc_holder
    );
END;
$$;

-- 5. New RPC: rpc_update_kitchen_order for editing date, kitchen, items, qty, price, and margin
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
    v_qty_kg NUMERIC(12,3);
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

    -- Validate all lines first
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_prod_id   := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_qty_kg    := ROUND(COALESCE((v_elem->>'qty_ordered_kg')::NUMERIC, 0), 3);
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
        v_line_id   := NULLIF(TRIM(COALESCE(v_elem->>'id', v_elem->>'delivery_item_id', '')), '');
        v_prod_id   := COALESCE(NULLIF(TRIM(v_elem->>'product_id'), ''), NULLIF(TRIM(v_elem->>'item_id'), ''));
        v_qty_kg    := ROUND((v_elem->>'qty_ordered_kg')::NUMERIC, 3);
        v_price_rp  := ROUND((v_elem->>'kitchen_unit_price_rp')::NUMERIC, 2);
        v_margin_rp := ROUND((v_elem->>'margin_per_kg_rp')::NUMERIC, 2);

        SELECT * INTO v_prod FROM public.products WHERE id = v_prod_id;

        IF v_line_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.kitchen_order_items WHERE id = v_line_id AND order_id = p_order_id
        ) THEN
            UPDATE public.kitchen_order_items
               SET product_id = v_prod_id,
                   product_name_snapshot = v_prod.name,
                   qty_ordered_kg = v_qty_kg,
                   qty_accepted_kg = v_qty_kg,
                   kitchen_unit_price_rp = v_price_rp,
                   margin_per_kg_rp = v_margin_rp,
                   is_weighed = TRUE,
                   weighed_at = COALESCE(weighed_at, NOW()),
                   shrinkage_reason = NULL,
                   shrinkage_note = NULL,
                   updated_at = NOW()
             WHERE id = v_line_id
               AND order_id = p_order_id;
        ELSE
            v_line_id := 'ditem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(md5(random()::text), 1, 5);
            INSERT INTO public.kitchen_order_items (
                id, order_id, product_id, product_name_snapshot,
                qty_ordered_kg, qty_accepted_kg,
                kitchen_unit_price_rp, margin_per_kg_rp,
                is_weighed, weighed_at, shrinkage_reason, shrinkage_note,
                created_at, updated_at
            ) VALUES (
                v_line_id, p_order_id, v_prod_id, v_prod.name,
                v_qty_kg, v_qty_kg,
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

GRANT EXECUTE ON FUNCTION public.rpc_update_kitchen_order(TEXT, TEXT, DATE, JSONB) TO anon, authenticated, service_role;

COMMIT;
