-- =============================================================================
-- Migration: 0007_decimal_kg_support.sql
-- Project  : MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger (Stage 8)
-- Ref      : nrdepkayabbbshnmyrvc
-- Purpose  : Enable dynamic decimal kilogram quantities (NUMERIC(12,3), e.g.
--            12.5 kg, 0.2 kg, 1.25 kg) across kitchen_order_items, views,
--            triggers, and RPC functions.
-- =============================================================================

BEGIN;

-- 1. Drop dependent views & generated columns before altering column types
DROP VIEW IF EXISTS public.v_safe_delivery_items_bast;
DROP VIEW IF EXISTS public.v_courier_kitchen_orders;

ALTER TABLE public.kitchen_order_items
    DROP COLUMN IF EXISTS line_invoice_amount_rp,
    DROP COLUMN IF EXISTS line_margin_amount_rp;

-- 2. Drop any existing check constraints on qty_ordered_kg / qty_accepted_kg
ALTER TABLE public.kitchen_order_items
    DROP CONSTRAINT IF EXISTS kitchen_order_items_qty_ordered_kg_check,
    DROP CONSTRAINT IF EXISTS kitchen_order_items_qty_accepted_kg_check,
    DROP CONSTRAINT IF EXISTS chk_kitchen_order_items_qty_ordered_positive,
    DROP CONSTRAINT IF EXISTS chk_kitchen_order_items_qty_accepted_bounds;

-- 3. Alter qty_ordered_kg and qty_accepted_kg from INTEGER to NUMERIC(12,3)
ALTER TABLE public.kitchen_order_items
    ALTER COLUMN qty_ordered_kg TYPE NUMERIC(12,3) USING ROUND(qty_ordered_kg::NUMERIC, 3),
    ALTER COLUMN qty_accepted_kg TYPE NUMERIC(12,3) USING CASE
        WHEN qty_accepted_kg IS NULL THEN NULL
        ELSE ROUND(qty_accepted_kg::NUMERIC, 3)
    END;

-- 4. Add check constraints allowing decimal weights > 0 (e.g. 0.2 kg, 12.5 kg)
ALTER TABLE public.kitchen_order_items
    ADD CONSTRAINT chk_kitchen_order_items_qty_ordered_positive
        CHECK (qty_ordered_kg > 0),
    ADD CONSTRAINT chk_kitchen_order_items_qty_accepted_bounds
        CHECK (qty_accepted_kg IS NULL OR (qty_accepted_kg >= 0 AND qty_accepted_kg <= qty_ordered_kg));

-- 5. Re-add generated columns with ROUND(qty * price, 2)
ALTER TABLE public.kitchen_order_items
    ADD COLUMN line_invoice_amount_rp NUMERIC(15,2) GENERATED ALWAYS AS (
        ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * kitchen_unit_price_rp, 2)
    ) STORED,
    ADD COLUMN line_margin_amount_rp NUMERIC(15,2) GENERATED ALWAYS AS (
        ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * margin_per_kg_rp, 2)
    ) STORED;

-- 6. Recreate price-free courier views exposing NUMERIC(12,3) weights
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
    ROUND(koi.qty_ordered_kg - COALESCE(koi.qty_accepted_kg, koi.qty_ordered_kg), 3)::NUMERIC(12,3) AS qty_shrinkage_kg,
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

-- 7. Update fn_recalculate_order_financials to use NUMERIC(12,3) for v_eff_kg
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
        COALESCE(SUM(ROUND(COALESCE(qty_accepted_kg, qty_ordered_kg) * kitchen_unit_price_rp, 2)), 0.00)
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
        v_gross := ROUND(v_eff_kg * v_item.margin_per_kg_rp, 2);

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

-- 8. Replace submit_courier_weighing with NUMERIC(12,3) parameter
DROP FUNCTION IF EXISTS public.submit_courier_weighing(TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.submit_courier_weighing(TEXT, NUMERIC, TEXT, TEXT);

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
    SELECT * INTO v_item FROM public.kitchen_order_items WHERE id = p_item_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Baris order % tidak ditemukan.', p_item_id;
    END IF;

    SELECT * INTO v_inv FROM public.kitchen_invoices WHERE order_id = v_item.order_id;
    IF FOUND AND v_inv.status = 'PAID' THEN
        RAISE EXCEPTION 'Invoice sudah lunas — timbangan terkunci.';
    END IF;

    v_clean_kg := ROUND(p_qty_accepted_kg, 3);

    IF v_clean_kg < 0 THEN
        RAISE EXCEPTION 'Berat diterima tidak boleh negatif.';
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

    -- Trigger trg_kitchen_order_items_recalc automatically updates kitchen_orders, kitchen_invoices, and profit_ledger_entries
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

COMMIT;
