-- =====================================================================
-- Migration 0013: Database-Level Delete Guards for Paid Orders & Payouts
--                 + Server-Side PIN Verification RPC
-- =====================================================================

BEGIN;

-- 1. Trigger function: Prevent deleting a kitchen_order if its invoice is PAID
--    or if any of its profit_ledger_entries have already been paid out.
CREATE OR REPLACE FUNCTION public.fn_guard_kitchen_order_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'BAST_LOCKED' THEN
    RAISE EXCEPTION 'Order % sudah dikunci (invoice lunas) dan tidak dapat dihapus.', OLD.order_code;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.kitchen_invoices ki
    WHERE ki.order_id = OLD.id
      AND ki.status = 'PAID'
  ) THEN
    RAISE EXCEPTION 'Invoice dapur untuk order % sudah lunas — order tidak dapat dihapus.', OLD.order_code;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_ledger_entries ple
    WHERE ple.order_id = OLD.id
      AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
  ) THEN
    RAISE EXCEPTION 'Sebagian bagi hasil untuk order % sudah dicairkan — order tidak dapat dihapus.', OLD.order_code;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_kitchen_order_delete ON public.kitchen_orders;
CREATE TRIGGER trg_guard_kitchen_order_delete
  BEFORE DELETE ON public.kitchen_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_kitchen_order_delete();

-- 2. Trigger function: Prevent deleting a kitchen_order_item if its parent invoice
--    is PAID or if its ledger entry has already been paid out.
CREATE OR REPLACE FUNCTION public.fn_guard_kitchen_order_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.kitchen_invoices ki
    WHERE ki.order_id = OLD.order_id
      AND ki.status = 'PAID'
  ) THEN
    RAISE EXCEPTION 'Invoice dapur sudah lunas — baris barang tidak dapat dihapus.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_ledger_entries ple
    WHERE ple.order_item_id = OLD.id
      AND (ple.team_paid_out = TRUE OR ple.coop_paid_out = TRUE)
  ) THEN
    RAISE EXCEPTION 'Bagi hasil baris barang ini sudah dicairkan — tidak dapat dihapus.';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_kitchen_order_item_delete ON public.kitchen_order_items;
CREATE TRIGGER trg_guard_kitchen_order_item_delete
  BEFORE DELETE ON public.kitchen_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_kitchen_order_item_delete();

-- 3. Server-side PIN verification RPC so the client can verify role PINs
--    directly against app_settings in PostgreSQL.
CREATE OR REPLACE FUNCTION public.rpc_verify_role_pin(
  p_role TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_pin TEXT := '1122';
  v_coop_pin TEXT := '3344';
  v_matched BOOLEAN := FALSE;
BEGIN
  SELECT COALESCE(admin_pin, '1122'), COALESCE(coop_pin, '3344')
    INTO v_admin_pin, v_coop_pin
  FROM public.app_settings
  WHERE id = 'default'
  LIMIT 1;

  IF UPPER(TRIM(COALESCE(p_role, ''))) = 'OWNER_ADMIN' THEN
    v_matched := (TRIM(COALESCE(p_pin, '')) = v_admin_pin);
  ELSIF UPPER(TRIM(COALESCE(p_role, ''))) = 'COOPERATIVE_VIEWER' THEN
    v_matched := (TRIM(COALESCE(p_pin, '')) = v_coop_pin);
  END IF;

  RETURN jsonb_build_object(
    'ok', v_matched,
    'role', UPPER(TRIM(COALESCE(p_role, '')))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_verify_role_pin(TEXT, TEXT) TO anon, authenticated, service_role;

COMMIT;
