-- Stage 6: Kitchen-centric courier view (1 kartu = 1 dapur).
-- Extends the price-free security-barrier view with non-financial context only:
-- batch code (traceability, Invariant 3), kitchen code/PIC, and delivery status.
-- New columns are appended at the end so CREATE OR REPLACE VIEW keeps existing grants.
-- NO supplier cost, kitchen price, invoice, or markup columns (Invariant 5).

CREATE OR REPLACE VIEW public.v_safe_delivery_items_bast WITH (security_barrier = true) AS
SELECT kdi.id AS delivery_item_id, kdi.delivery_id, kd.delivery_number, kd.delivery_date,
       kd.kitchen_id, k.name AS kitchen_name, kdi.item_id, i.name AS item_name, i.base_unit,
       kdi.qty_dispatched_kg, kdi.qty_accepted_kg, kdi.qty_shrinkage_kg, kdi.rejection_reason,
       spb.batch_code,
       k.kitchen_code,
       k.pic_name AS kitchen_pic_name,
       k.pic_phone AS kitchen_pic_phone,
       kd.status AS delivery_status
FROM public.kitchen_delivery_items kdi
JOIN public.kitchen_deliveries kd ON kd.id = kdi.delivery_id
JOIN public.kitchens k ON k.id = kd.kitchen_id
JOIN public.items i ON i.id = kdi.item_id
JOIN public.supplier_procurement_batches spb ON spb.id = kdi.supplier_batch_id;
