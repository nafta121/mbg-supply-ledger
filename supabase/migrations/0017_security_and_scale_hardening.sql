-- =============================================================================
-- Migration: 0017_security_and_scale_hardening.sql
-- Purpose  : Lock down direct PostgREST client writes and mutating RPC execution
--            for `PUBLIC`, `anon`, and `authenticated` roles so all mutations and
--            PIN checks must pass through the Cloudflare Hyperdrive Worker
--            (`postgres` / `service_role`), while preserving `SELECT` access for
--            Supabase Realtime and read fallback.
-- =============================================================================

BEGIN;

-- 1. Revoke direct table writes from PostgREST client roles while keeping SELECT
REVOKE INSERT, UPDATE, DELETE ON
  public.kitchens,
  public.products,
  public.kitchen_orders,
  public.kitchen_order_items
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON
  public.kitchens,
  public.products,
  public.kitchen_orders,
  public.kitchen_order_items
TO anon, authenticated;

-- 2. Revoke direct RPC execution from PUBLIC, anon, authenticated
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_kitchen_order(TEXT, DATE, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_update_kitchen_order(TEXT, TEXT, DATE, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_mark_invoice_paid(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_execute_profit_payout(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_update_app_settings(NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_courier_weighing(TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_verify_role_pin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 3. Grant RPC execution exclusively to server/Hyperdrive roles
GRANT EXECUTE ON FUNCTION public.rpc_upsert_kitchen_order(TEXT, DATE, JSONB, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_kitchen_order(TEXT, TEXT, DATE, JSONB) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_mark_invoice_paid(TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_execute_profit_payout(TEXT, TEXT[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_app_settings(NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.submit_courier_weighing(TEXT, NUMERIC, TEXT, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_verify_role_pin(TEXT, TEXT) TO postgres, service_role;

COMMIT;
