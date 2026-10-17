-- Stage 8: Order-Driven Flow (By Order dari Dapur) — Fase 1.
--
-- Alur: Order Dapur -> Pengiriman & Timbang BAST Kurir -> Invoice Dapur Gabungan -> Bagi Hasil (Tim & Koperasi).
-- Fase ini TIDAK mencatat stok batch supplier maupun hutang/pembayaran ke supplier.
--
-- Perubahan:
--   1. items: harga dapur default & margin default per kg (auto-isi baris order, tetap bisa diedit).
--   2. kitchen_delivery_items: lepas dari supplier batch/HPP; simpan snapshot
--      kitchen_unit_price_snapshot + margin_per_kg_snapshot, kolom generated
--      line_invoice_amount (= qty_accepted_kg × harga) & line_margin_amount (= qty_accepted_kg × margin),
--      serta weighed_at per baris (Perlu Ditimbang vs Tertimbang).
--   3. kitchen_invoices.total_invoice_amount = Σ line_invoice_amount (trigger) — 1 invoice per order.
--   4. View kurir tanpa harga (Invariant 5) tanpa batch_code, dengan is_weighed per baris.
--   5. Tabel supplier_settlements & supplier_procurement_batches dihapus (Fase 1 tanpa supplier).
--
-- WARNING: langkah 5 menghapus data supplier batch & settlement secara permanen.
-- Backup terlebih dahulu sebelum menjalankan migration ini di lingkungan yang berisi data.

BEGIN;

-- 1. ITEMS: default harga dapur & margin per kg -------------------------------
ALTER TABLE public.items
    ADD COLUMN default_kitchen_price_per_kg NUMERIC(15,2) NOT NULL DEFAULT 0.00
        CHECK (default_kitchen_price_per_kg >= 0),
    ADD COLUMN default_margin_per_kg NUMERIC(15,2) NOT NULL DEFAULT 0.00
        CHECK (default_margin_per_kg >= 0),
    ADD CONSTRAINT chk_items_default_margin_le_price
        CHECK (default_margin_per_kg <= default_kitchen_price_per_kg OR default_kitchen_price_per_kg = 0);

-- 2. Lepas ketergantungan ke supplier batch ----------------------------------
DROP VIEW IF EXISTS public.v_safe_delivery_items_bast;
DROP TRIGGER IF EXISTS trg_before_insert_delivery_item_snapshot ON public.kitchen_delivery_items;
DROP FUNCTION IF EXISTS public.fn_populate_supplier_cost_snapshot();

ALTER TABLE public.kitchen_delivery_items
    DROP COLUMN line_supplier_payable_amount,
    DROP COLUMN line_supplier_claim_amount,
    DROP COLUMN line_total_markup_amount;

ALTER TABLE public.kitchen_delivery_items
    DROP CONSTRAINT IF EXISTS kitchen_delivery_items_kitchen_unit_price_snapshot_check;

ALTER TABLE public.kitchen_delivery_items
    DROP COLUMN supplier_actual_cost_snapshot,
    DROP COLUMN supplier_batch_id;

-- 3. Snapshot harga dapur + margin (Invariant 3) & generated amounts (Invariant 2/4)
ALTER TABLE public.kitchen_delivery_items
    ADD CONSTRAINT chk_kdi_kitchen_price_positive CHECK (kitchen_unit_price_snapshot > 0),
    ADD COLUMN margin_per_kg_snapshot NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD CONSTRAINT chk_kdi_margin_range
        CHECK (margin_per_kg_snapshot >= 0 AND margin_per_kg_snapshot <= kitchen_unit_price_snapshot),
    ADD COLUMN line_margin_amount NUMERIC(15,2)
        GENERATED ALWAYS AS (ROUND(qty_accepted_kg * margin_per_kg_snapshot, 2)) STORED,
    ADD COLUMN weighed_at TIMESTAMPTZ;

-- Harga & margin terkunci setelah baris dibuat (perubahan master tidak mengubah histori).
CREATE OR REPLACE FUNCTION public.fn_guard_order_line_price_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NEW.kitchen_unit_price_snapshot IS DISTINCT FROM OLD.kitchen_unit_price_snapshot
       OR NEW.margin_per_kg_snapshot IS DISTINCT FROM OLD.margin_per_kg_snapshot THEN
        RAISE EXCEPTION 'Invariant 3 Violation: snapshot harga dapur / margin tidak boleh diubah';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.kitchen_invoices
         WHERE delivery_id = NEW.delivery_id AND payment_status = 'PAID'
    ) THEN
        RAISE EXCEPTION 'Invoice dapur sudah lunas — timbangan order terkunci';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_order_line_price_snapshot
BEFORE UPDATE ON public.kitchen_delivery_items
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_order_line_price_snapshot();

-- 4. Invoice Dapur Gabungan: total = Σ qty_accepted_kg × harga dapur ---------
CREATE OR REPLACE FUNCTION public.fn_recalc_kitchen_invoice_total()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_delivery_id UUID := COALESCE(NEW.delivery_id, OLD.delivery_id);
BEGIN
    UPDATE public.kitchen_invoices ki
       SET total_invoice_amount = COALESCE((
               SELECT SUM(kdi.line_invoice_amount)
                 FROM public.kitchen_delivery_items kdi
                WHERE kdi.delivery_id = v_delivery_id), 0),
           updated_at = NOW()
     WHERE ki.delivery_id = v_delivery_id
       AND ki.payment_status <> 'PAID';
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_recalc_kitchen_invoice_total
AFTER INSERT OR UPDATE OF qty_accepted_kg OR DELETE ON public.kitchen_delivery_items
FOR EACH ROW EXECUTE FUNCTION public.fn_recalc_kitchen_invoice_total();

-- Lunas hanya boleh setelah semua barang order ditimbang kurir.
CREATE OR REPLACE FUNCTION public.fn_guard_invoice_paid_requires_bast()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NEW.payment_status = 'PAID' AND OLD.payment_status IS DISTINCT FROM 'PAID' AND EXISTS (
        SELECT 1 FROM public.kitchen_delivery_items
         WHERE delivery_id = NEW.delivery_id AND weighed_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Invoice % belum final: masih ada barang yang belum ditimbang', NEW.invoice_number;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_invoice_paid_requires_bast
BEFORE UPDATE OF payment_status ON public.kitchen_invoices
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_invoice_paid_requires_bast();

-- 5. Hapus modul supplier (Fase 1 tanpa stok batch & settlement supplier) -----
DROP TABLE IF EXISTS public.supplier_settlements;
DROP TABLE IF EXISTS public.supplier_procurement_batches;
DROP TYPE IF EXISTS settlement_status_enum;

-- 6. View kurir tanpa harga (Invariant 5) -------------------------------------
CREATE VIEW public.v_safe_delivery_items_bast WITH (security_barrier = true) AS
SELECT kdi.id AS delivery_item_id, kdi.delivery_id, kd.delivery_number, kd.delivery_date,
       kd.kitchen_id, k.name AS kitchen_name, kdi.item_id, i.name AS item_name, i.base_unit,
       kdi.qty_dispatched_kg, kdi.qty_accepted_kg, kdi.qty_shrinkage_kg, kdi.rejection_reason,
       k.kitchen_code,
       k.pic_name AS kitchen_pic_name,
       k.pic_phone AS kitchen_pic_phone,
       (kdi.weighed_at IS NOT NULL) AS is_weighed,
       EXISTS (
           SELECT 1 FROM public.kitchen_invoices ki
            WHERE ki.delivery_id = kdi.delivery_id AND ki.payment_status = 'PAID'
       ) AS is_locked
FROM public.kitchen_delivery_items kdi
JOIN public.kitchen_deliveries kd ON kd.id = kdi.delivery_id
JOIN public.kitchens k ON k.id = kd.kitchen_id
JOIN public.items i ON i.id = kdi.item_id;

GRANT SELECT ON public.v_safe_delivery_items_bast TO authenticated;

COMMIT;
