-- =============================================================================
-- Migration 0019: Auto-reconcile & purge orphaned profit_payout_batches
-- Ensures deleting any order/invoice (including paid & paid-out invoices)
-- automatically recalculates or deletes affected rows in profit_payout_batches.
-- =============================================================================

BEGIN;

-- Backfill any legacy profit_ledger_entries missing order_id
UPDATE public.profit_ledger_entries ple
SET order_id = ki.order_id
FROM public.kitchen_invoices ki
WHERE ple.invoice_id = ki.id
  AND ple.order_id IS NULL;

CREATE OR REPLACE FUNCTION public.fn_reconcile_payout_batches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Delete any payout batch that no longer has any paid-out ledger entries
    DELETE FROM public.profit_payout_batches b
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.profit_ledger_entries p
        WHERE (b.beneficiary_type = 'TEAM' AND p.team_payout_batch_id = b.id AND p.team_paid_out = TRUE)
           OR (b.beneficiary_type = 'COOPERATIVE' AND p.coop_payout_batch_id = b.id AND p.coop_paid_out = TRUE)
    );

    -- 2. Recalculate total_payout_amount and notes on remaining batches
    WITH batch_totals AS (
        SELECT
            b.id AS batch_id,
            b.beneficiary_type,
            COUNT(p.id)::int AS entry_cnt,
            COALESCE(ROUND(SUM(
                CASE
                    WHEN b.beneficiary_type = 'TEAM' THEN p.team_amount_rp
                    ELSE p.coop_amount_rp
                END
            ), 2), 0.00) AS total_rp
        FROM public.profit_payout_batches b
        JOIN public.profit_ledger_entries p
          ON (b.beneficiary_type = 'TEAM' AND p.team_payout_batch_id = b.id AND p.team_paid_out = TRUE)
          OR (b.beneficiary_type = 'COOPERATIVE' AND p.coop_payout_batch_id = b.id AND p.coop_paid_out = TRUE)
        GROUP BY b.id, b.beneficiary_type
    )
    UPDATE public.profit_payout_batches b
    SET
        total_payout_amount = bt.total_rp,
        notes = CASE
            WHEN b.beneficiary_type = 'TEAM' THEN 'Pencairan bagi hasil Tim (' || bt.entry_cnt || ' baris)'
            ELSE 'Pencairan bagi hasil Koperasi (' || bt.entry_cnt || ' baris)'
        END
    FROM batch_totals bt
    WHERE b.id = bt.batch_id
      AND (
          b.total_payout_amount IS DISTINCT FROM bt.total_rp
          OR b.notes IS DISTINCT FROM CASE
              WHEN b.beneficiary_type = 'TEAM' THEN 'Pencairan bagi hasil Tim (' || bt.entry_cnt || ' baris)'
              ELSE 'Pencairan bagi hasil Koperasi (' || bt.entry_cnt || ' baris)'
          END
      );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trg_profit_ledger_reconcile_payout_batches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.fn_reconcile_payout_batches();
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_profit_ledger_reconcile_payout_batches ON public.profit_ledger_entries;
CREATE TRIGGER trg_profit_ledger_reconcile_payout_batches
    AFTER DELETE OR UPDATE ON public.profit_ledger_entries
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.fn_trg_profit_ledger_reconcile_payout_batches();

-- Immediately clean up any orphaned payout batches in the database
SELECT public.fn_reconcile_payout_batches();

COMMIT;
