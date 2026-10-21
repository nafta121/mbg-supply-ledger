-- =============================================================================
-- Migration: 0012_disable_field_weighing_requirement.sql
-- Purpose  : Disable courier weighing requirement while the Field (Lapangan)
--            module is turned off. Orders default to accepted = ordered weight
--            and invoices can be marked PAID directly without courier weighing.
-- =============================================================================

-- 1. Backfill any existing unweighed order items so current unpaid invoices can be marked Lunas immediately
UPDATE public.kitchen_order_items
   SET qty_accepted_kg = COALESCE(qty_accepted_kg, qty_ordered_kg),
       is_weighed = TRUE,
       weighed_at = COALESCE(weighed_at, NOW()),
       updated_at = NOW()
 WHERE is_weighed = FALSE;

-- 2. rpc_upsert_kitchen_order: default qty_accepted_kg = qty_ordered_kg & is_weighed = TRUE
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

-- 3. rpc_mark_invoice_paid: auto-accept any unweighed items at ordered weight before marking PAID
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

    UPDATE public.kitchen_order_items
       SET qty_accepted_kg = COALESCE(qty_accepted_kg, qty_ordered_kg),
           is_weighed = TRUE,
           weighed_at = COALESCE(weighed_at, NOW()),
           updated_at = NOW()
     WHERE order_id = v_inv.order_id
       AND is_weighed = FALSE;

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
