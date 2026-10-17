-- =============================================================================
-- Migration 0008: Dynamic Invoice Bank Account Configuration & Snapshot
-- =============================================================================
-- Adds configurable payment bank account fields to `app_settings`,
-- `profit_split_configs`, and `kitchen_invoices`:
--   - payment_bank_name TEXT NOT NULL DEFAULT 'BRI'
--   - payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000'
--   - payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG'
-- =============================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
  ADD COLUMN IF NOT EXISTS payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000',
  ADD COLUMN IF NOT EXISTS payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG';

ALTER TABLE public.profit_split_configs
  ADD COLUMN IF NOT EXISTS payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
  ADD COLUMN IF NOT EXISTS payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000',
  ADD COLUMN IF NOT EXISTS payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG';

ALTER TABLE public.kitchen_invoices
  ADD COLUMN IF NOT EXISTS payment_bank_name TEXT NOT NULL DEFAULT 'BRI',
  ADD COLUMN IF NOT EXISTS payment_account_number TEXT NOT NULL DEFAULT '0000-0000-0000-000',
  ADD COLUMN IF NOT EXISTS payment_account_holder TEXT NOT NULL DEFAULT 'Bendahara Supplier MBG';
