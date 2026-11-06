-- =============================================================================
-- Migration: 0018_allow_admin_delete_paid_invoice.sql
-- Purpose  : Allow Admin (via PIN-verified Worker / service_role) to delete
--            orders and invoices even after they are marked PAID or after
--            profit shares have been disbursed. Direct client writes remain
--            revoked by 0017_security_and_scale_hardening.sql.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_guard_kitchen_order_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_guard_kitchen_order_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN OLD;
END;
$$;

COMMIT;
