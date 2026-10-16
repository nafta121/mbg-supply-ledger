-- Migration: 0001_initial_schema
-- Description: Core schema for MBG Supply Chain

CREATE TYPE user_role AS ENUM ('FIELD_TEAM', 'KOPERASI_VIEWER', 'ADMIN_FINANCE');
CREATE TYPE invoice_status AS ENUM ('DRAFT', 'ISSUED', 'PARTIAL', 'PAID');
CREATE TYPE payout_status AS ENUM ('LOCKED_UNPAID', 'AVAILABLE_FOR_PAYOUT', 'PAID_OUT');

CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'FIELD_TEAM',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kitchens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    contact_info TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    item_id UUID NOT NULL REFERENCES items(id),
    batch_date DATE NOT NULL,
    qty_purchased_kg NUMERIC(10,3) NOT NULL,
    supplier_actual_cost_per_kg NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kitchen_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kitchen_id UUID NOT NULL REFERENCES kitchens(id),
    invoice_date DATE NOT NULL,
    payment_status invoice_status NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kitchen_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kitchen_id UUID NOT NULL REFERENCES kitchens(id),
    invoice_id UUID REFERENCES kitchen_invoices(id),
    delivery_date DATE NOT NULL,
    bast_photo_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kitchen_delivery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID NOT NULL REFERENCES kitchen_deliveries(id),
    supplier_batch_id UUID NOT NULL REFERENCES supplier_batches(id),
    qty_dispatched_kg NUMERIC(10,3) NOT NULL,
    qty_accepted_kg NUMERIC(10,3),
    qty_shrinkage_kg NUMERIC(10,3) GENERATED ALWAYS AS (qty_dispatched_kg - COALESCE(qty_accepted_kg, qty_dispatched_kg)) STORED,
    supplier_actual_cost_snapshot NUMERIC(15,2) NOT NULL,
    kitchen_unit_price_snapshot NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    settlement_date DATE NOT NULL,
    total_payable NUMERIC(15,2) NOT NULL,
    status payout_status NOT NULL DEFAULT 'LOCKED_UNPAID',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE profit_split_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_share_pct NUMERIC(5,2) NOT NULL,
    koperasi_share_pct NUMERIC(5,2) NOT NULL,
    active_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sum_must_be_100 CHECK (team_share_pct + koperasi_share_pct = 100)
);

CREATE TABLE profit_ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_item_id UUID NOT NULL REFERENCES kitchen_delivery_items(id),
    invoice_id UUID NOT NULL REFERENCES kitchen_invoices(id),
    total_markup NUMERIC(15,2) NOT NULL,
    team_share_amount NUMERIC(15,2) NOT NULL,
    koperasi_share_amount NUMERIC(15,2) NOT NULL,
    status payout_status NOT NULL DEFAULT 'LOCKED_UNPAID',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to update profit ledger status when invoice becomes PAID
CREATE OR REPLACE FUNCTION update_profit_ledger_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_status = 'PAID' AND OLD.payment_status != 'PAID' THEN
        UPDATE profit_ledger_entries
        SET status = 'AVAILABLE_FOR_PAYOUT'
        WHERE invoice_id = NEW.id;
    ELSIF NEW.payment_status != 'PAID' AND OLD.payment_status = 'PAID' THEN
        UPDATE profit_ledger_entries
        SET status = 'LOCKED_UNPAID'
        WHERE invoice_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_profit_ledger_status
AFTER UPDATE OF payment_status ON kitchen_invoices
FOR EACH ROW
EXECUTE FUNCTION update_profit_ledger_status();

-- RLS Policies
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchens ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_split_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_ledger_entries ENABLE ROW LEVEL SECURITY;

-- FIELD_TEAM policies (restrictive)
CREATE POLICY "Field team can view kitchens" ON kitchens FOR SELECT TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'FIELD_TEAM' );
CREATE POLICY "Field team can view deliveries" ON kitchen_deliveries FOR SELECT TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'FIELD_TEAM' );
CREATE POLICY "Field team can update accepted qty" ON kitchen_delivery_items FOR UPDATE TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'FIELD_TEAM' );
-- Notice: No select policy for supplier_batches, profit_ledger_entries, etc. for FIELD_TEAM

-- KOPERASI_VIEWER policies (read-only for summaries)
CREATE POLICY "Koperasi viewer can view invoices" ON kitchen_invoices FOR SELECT TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'KOPERASI_VIEWER' );
CREATE POLICY "Koperasi viewer can view profit ledger" ON profit_ledger_entries FOR SELECT TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'KOPERASI_VIEWER' );

-- ADMIN_FINANCE policies (full access)
CREATE POLICY "Admin finance all access kitchens" ON kitchens FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access suppliers" ON suppliers FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access items" ON items FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access supplier_batches" ON supplier_batches FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access kitchen_invoices" ON kitchen_invoices FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access kitchen_deliveries" ON kitchen_deliveries FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access kitchen_delivery_items" ON kitchen_delivery_items FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access supplier_settlements" ON supplier_settlements FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access profit_split_rules" ON profit_split_rules FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );
CREATE POLICY "Admin finance all access profit_ledger_entries" ON profit_ledger_entries FOR ALL TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'ADMIN_FINANCE' );


-- Fix for profiles RLS
CREATE POLICY "Users can read own profile" ON profiles FOR SELECT TO authenticated USING (id = auth.uid());

-- FIELD_TEAM needs select to see what they are updating
CREATE POLICY "Field team can view delivery items" ON kitchen_delivery_items FOR SELECT TO authenticated USING ( (SELECT role FROM profiles WHERE id = auth.uid()) = 'FIELD_TEAM' );
