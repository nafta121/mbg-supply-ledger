-- =============================================================================
-- Migration: 0014_supplier_name_and_payment_account_lock.sql
-- Purpose  : 1. Add `supplier_name` to `app_settings`, `profit_split_configs`,
--               and `kitchen_invoices` so every invoice clearly states the
--               supplier / company name.
--            2. Ensure `rpc_update_app_settings`, `fn_trg_app_settings_split_change`,
--               and `fn_recalculate_order_financials` persist and lock
--               `supplier_name`, `payment_bank_name`, `payment_account_number`,
--               and `payment_account_holder` across reloads and unpaid invoices.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS supplier_name TEXT NOT NULL DEFAULT 'Supplier MBG';

ALTER TABLE public.profit_split_configs
  ADD COLUMN IF NOT EXISTS supplier_name TEXT NOT NULL DEFAULT 'Supplier MBG';

ALTER TABLE public.kitchen_invoices
  ADD COLUMN IF NOT EXISTS supplier_name TEXT NOT NULL DEFAULT 'Supplier MBG';

-- Sync existing UNPAID invoices with the current app_settings row
UPDATE public.kitchen_invoices ki
   SET supplier_name = COALESCE(NULLIF(TRIM(s.supplier_name), ''), 'Supplier MBG'),
       payment_bank_name = COALESCE(NULLIF(TRIM(s.payment_bank_name), ''), 'BRI'),
       payment_account_number = COALESCE(NULLIF(TRIM(s.payment_account_number), ''), '0000-0000-0000-000'),
       payment_account_holder = COALESCE(NULLIF(TRIM(s.payment_account_holder), ''), 'Bendahara Supplier MBG')
  FROM public.app_settings s
 WHERE s.id = 'default'
   AND ki.status <> 'PAID';

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
           SET total_amount_rp = v_total_invoice,
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
           cooperative_share_pct = NEW.coop_share_pct,
           supplier_name = COALESCE(NULLIF(TRIM(NEW.supplier_name), ''), supplier_name, 'Supplier MBG'),
           payment_bank_name = COALESCE(NULLIF(TRIM(NEW.payment_bank_name), ''), payment_bank_name, 'BRI'),
           payment_account_number = COALESCE(NULLIF(TRIM(NEW.payment_account_number), ''), payment_account_number, '0000-0000-0000-000'),
           payment_account_holder = COALESCE(NULLIF(TRIM(NEW.payment_account_holder), ''), payment_account_holder, 'Bendahara Supplier MBG')
     WHERE id = 'split-default-60-40' OR is_active = TRUE;

    UPDATE public.kitchen_invoices
       SET supplier_name = COALESCE(NULLIF(TRIM(NEW.supplier_name), ''), 'Supplier MBG'),
           payment_bank_name = COALESCE(NULLIF(TRIM(NEW.payment_bank_name), ''), 'BRI'),
           payment_account_number = COALESCE(NULLIF(TRIM(NEW.payment_account_number), ''), '0000-0000-0000-000'),
           payment_account_holder = COALESCE(NULLIF(TRIM(NEW.payment_account_holder), ''), 'Bendahara Supplier MBG'),
           updated_at = NOW()
     WHERE status <> 'PAID';

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

-- Drop old 5-arg signature so there is a single unambiguous 6-arg RPC with defaults
DROP FUNCTION IF EXISTS public.rpc_update_app_settings(NUMERIC, NUMERIC, TEXT, TEXT, TEXT);

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
    v_order_rec RECORD;
BEGIN
    IF v_team < 0 OR v_coop < 0 OR ROUND(v_team + v_coop, 2) <> 100.00 THEN
        RAISE EXCEPTION 'Total persentase Tim + Koperasi harus tepat 100%%.';
    END IF;

    SELECT * INTO v_cur FROM public.app_settings WHERE id = 'default' LIMIT 1;

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
        'supplier_name', v_supplier,
        'payment_bank_name', v_bank,
        'payment_account_number', v_acc_no,
        'payment_account_holder', v_acc_holder
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_app_settings(NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;

COMMIT;
