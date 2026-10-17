-- =============================================================================
-- Migration: 0009_review_fixes_and_batch_rpc.sql
-- Project  : MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger (Stage 8)
-- Ref      : nrdepkayabbbshnmyrvc
-- Purpose  : 1. PIN-protected destructive RPCs (clear_all_transactions(p_admin_pin),
--               reset_to_simulation_seed(p_admin_pin)) with default admin_pin='1122',
--               coop_pin='3344', while preserving anon courier weighing access.
--            2. Separate team_paid_out_at and coop_paid_out_at timestamps on
--               profit_ledger_entries + order-level split freeze on partial
--               payout + trigger calling fn_recalculate_order_financials.
--            3. Atomic batch RPC submit_courier_weighing_batch(p_items JSONB)
--               with strict SQL bounds (qty_accepted_kg >= 0 AND
--               qty_accepted_kg <= qty_ordered_kg * 2 AND <= qty_ordered_kg).
--            4. Bank account snapshot integration in fn_recalculate_order_financials.
-- =============================================================================

ALTER TABLE public.app_settings
    ALTER COLUMN admin_pin SET DEFAULT '1122',
    ALTER COLUMN coop_pin SET DEFAULT '3344';

UPDATE public.app_settings
   SET admin_pin = CASE WHEN admin_pin IN ('1234', '') THEN '1122' ELSE admin_pin END,
       coop_pin  = CASE WHEN coop_pin IN ('5678', '') THEN '3344' ELSE coop_pin END
 WHERE id = 'default';

ALTER TABLE public.profit_ledger_entries
    ADD COLUMN IF NOT EXISTS team_paid_out_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS coop_paid_out_at TIMESTAMPTZ;

UPDATE public.profit_ledger_entries
   SET team_paid_out_at = COALESCE(team_paid_out_at, paid_out_at)
 WHERE team_paid_out = TRUE
   AND team_paid_out_at IS NULL;

UPDATE public.profit_ledger_entries
   SET coop_paid_out_at = COALESCE(coop_paid_out_at, paid_out_at)
 WHERE coop_paid_out = TRUE
   AND coop_paid_out_at IS NULL;

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
    v_bank_name TEXT := 'BRI';
    v_account_number TEXT := '0000-0000-0000-000';
    v_account_holder TEXT := 'Bendahara Supplier MBG';
    v_locked_split RECORD;
    v_order_has_payout BOOLEAN := FALSE;
    v_item RECORD;
    v_eff_kg NUMERIC(12,3);
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

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE is_weighed = TRUE),
        COALESCE(SUM(ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * kitchen_unit_price_rp, 2)), 0.00)
      INTO v_total_items, v_weighed_items, v_invoice_total
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
            v_invoice_total,
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
           SET total_amount_rp = v_invoice_total,
               amount_paid_rp = CASE WHEN status = 'PAID' THEN v_invoice_total ELSE amount_paid_rp END,
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

    FOR v_item IN
        SELECT * FROM public.kitchen_order_items WHERE order_id = p_order_id
    LOOP
        v_eff_kg := COALESCE(v_item.qty_accepted_kg, v_item.qty_ordered_kg);
        v_gross := ROUND(v_eff_kg * v_item.margin_per_kg_rp, 2);

        SELECT * INTO v_existing_ple
          FROM public.profit_ledger_entries
         WHERE id = 'ple-' || v_item.id OR order_item_id = v_item.id
         LIMIT 1;

        IF FOUND THEN
            IF v_existing_ple.team_paid_out = FALSE AND v_existing_ple.coop_paid_out = FALSE AND NOT v_order_has_payout THEN
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

CREATE OR REPLACE FUNCTION public.fn_trg_app_settings_split_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_rec RECORD;
BEGIN
    UPDATE public.profit_split_configs
       SET team_share_pct = NEW.team_share_pct,
           cooperative_share_pct = NEW.coop_share_pct
     WHERE id = 'split-default-60-40' OR is_active = TRUE;

    FOR v_order_rec IN
        SELECT ko.id
          FROM public.kitchen_orders ko
         WHERE NOT EXISTS (
             SELECT 1
               FROM public.profit_ledger_entries ple
              WHERE (ple.order_id = ko.id OR ple.invoice_id IN (
                         SELECT ki.id FROM public.kitchen_invoices ki WHERE ki.order_id = ko.id
                     ))
                AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
         )
    LOOP
        PERFORM public.fn_recalculate_order_financials(v_order_rec.id);
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_courier_weighing(
    p_item_id TEXT,
    p_qty_accepted_kg NUMERIC(12,3),
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
    v_clean_kg NUMERIC(12,3);
BEGIN
    SELECT * INTO v_item FROM public.kitchen_order_items WHERE id = p_item_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Baris order % tidak ditemukan.', p_item_id;
    END IF;

    SELECT * INTO v_inv FROM public.kitchen_invoices WHERE order_id = v_item.order_id;
    IF FOUND AND v_inv.status = 'PAID' THEN
        RAISE EXCEPTION 'Invoice sudah lunas — timbangan terkunci.';
    END IF;

    v_clean_kg := ROUND(p_qty_accepted_kg, 3);

    IF v_clean_kg IS NULL OR NOT (v_clean_kg >= 0 AND v_clean_kg <= v_item.qty_ordered_kg * 2) THEN
        RAISE EXCEPTION 'Berat diterima (% kg) di luar batas valid (0 s/d % kg).',
            v_clean_kg, v_item.qty_ordered_kg * 2;
    END IF;

    IF v_clean_kg > v_item.qty_ordered_kg THEN
        RAISE EXCEPTION '%: berat diterima (% kg) melebihi berat order (% kg).',
            v_item.product_name_snapshot, v_clean_kg, v_item.qty_ordered_kg;
    END IF;

    UPDATE public.kitchen_order_items
       SET qty_accepted_kg = v_clean_kg,
           is_weighed = TRUE,
           weighed_at = NOW(),
           shrinkage_reason = CASE WHEN v_clean_kg < qty_ordered_kg THEN COALESCE(NULLIF(TRIM(p_shrinkage_reason), ''), 'Susut') ELSE NULL END,
           shrinkage_note = CASE WHEN v_clean_kg < qty_ordered_kg THEN NULLIF(TRIM(p_shrinkage_note), '') ELSE NULL END,
           updated_at = NOW()
     WHERE id = p_item_id;

    RETURN jsonb_build_object(
        'ok', true,
        'item_id', p_item_id,
        'order_id', v_item.order_id,
        'qty_ordered_kg', v_item.qty_ordered_kg,
        'qty_accepted_kg', v_clean_kg
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_courier_weighing(TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_courier_weighing_batch(p_items JSONB)
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
    v_count INT := 0;
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Pilih minimal 1 barang untuk disimpan.';
    END IF;

    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_item_id := COALESCE(v_elem->>'item_id', v_elem->>'delivery_item_id');
        v_raw_kg  := (v_elem->>'qty_accepted_kg')::NUMERIC(12,3);
        v_reason  := v_elem->>'shrinkage_reason';
        v_note    := v_elem->>'shrinkage_note';

        PERFORM public.submit_courier_weighing(v_item_id, v_raw_kg, v_reason, v_note);
        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_courier_weighing_batch(JSONB) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.clear_all_transactions(p_admin_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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

    RETURN public.clear_all_transactions();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.clear_all_transactions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_all_transactions(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.reset_to_simulation_seed(p_admin_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expected_pin TEXT;
    v_bank_name TEXT := 'BRI';
    v_account_number TEXT := '0000-0000-0000-000';
    v_account_holder TEXT := 'Bendahara Supplier MBG';
    v_res JSONB;
BEGIN
    SELECT
        COALESCE(NULLIF(TRIM(admin_pin), ''), '1122'),
        COALESCE(NULLIF(TRIM(payment_bank_name), ''), 'BRI'),
        COALESCE(NULLIF(TRIM(payment_account_number), ''), '0000-0000-0000-000'),
        COALESCE(NULLIF(TRIM(payment_account_holder), ''), 'Bendahara Supplier MBG')
      INTO v_expected_pin, v_bank_name, v_account_number, v_account_holder
      FROM public.app_settings
     WHERE id = 'default'
     LIMIT 1;
    v_expected_pin := COALESCE(v_expected_pin, '1122');

    IF p_admin_pin IS NULL OR TRIM(p_admin_pin) <> v_expected_pin THEN
        RAISE EXCEPTION 'PIN Admin tidak valid — operasi ditolak.';
    END IF;

    v_res := public.reset_to_simulation_seed();

    UPDATE public.kitchen_invoices
       SET payment_bank_name = v_bank_name,
           payment_account_number = v_account_number,
           payment_account_holder = v_account_holder
     WHERE id IS NOT NULL;

    RETURN v_res;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_to_simulation_seed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_to_simulation_seed(TEXT) TO anon, authenticated;
