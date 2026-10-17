-- Stage 7: Whole-kilogram weights (Invariant 1 — Kilogram Bulat).
-- Operational weights are whole kg (e.g. 50 kg, 49 kg, -3 kg susut). Columns stay
-- exact NUMERIC(10,3) (never FLOAT) so existing generated columns, triggers, and
-- views keep working; CHECK constraints reject any fractional kilogram input.
-- Derived columns (qty_shrinkage_kg, total_shrinkage_claim_kg) are differences of
-- whole numbers and therefore whole as well.
-- NOT VALID: enforced for all new/updated rows without failing on legacy rows;
-- run `VALIDATE CONSTRAINT` after any legacy data has been cleaned up.

ALTER TABLE public.supplier_procurement_batches
    ADD CONSTRAINT chk_spb_qty_procured_whole_kg
    CHECK (qty_procured_kg = TRUNC(qty_procured_kg)) NOT VALID;

ALTER TABLE public.kitchen_delivery_items
    ADD CONSTRAINT chk_kdi_qty_dispatched_whole_kg
    CHECK (qty_dispatched_kg = TRUNC(qty_dispatched_kg)) NOT VALID;

ALTER TABLE public.kitchen_delivery_items
    ADD CONSTRAINT chk_kdi_qty_accepted_whole_kg
    CHECK (qty_accepted_kg = TRUNC(qty_accepted_kg)) NOT VALID;

ALTER TABLE public.supplier_settlements
    ADD CONSTRAINT chk_ss_total_dispatched_whole_kg
    CHECK (total_dispatched_kg = TRUNC(total_dispatched_kg)) NOT VALID;

ALTER TABLE public.supplier_settlements
    ADD CONSTRAINT chk_ss_total_accepted_whole_kg
    CHECK (total_accepted_by_kitchens_kg = TRUNC(total_accepted_by_kitchens_kg)) NOT VALID;

ALTER TABLE public.profit_ledger_entries
    ADD CONSTRAINT chk_ple_qty_accepted_whole_kg
    CHECK (qty_accepted_kg = TRUNC(qty_accepted_kg)) NOT VALID;
