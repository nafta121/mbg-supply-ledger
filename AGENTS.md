# AGENTS.md - Agent Instructions for Jules

This file contains technical guidelines and business invariants for Jules (or any AI agent) to strictly follow on all Pull Requests and code changes.

## Tech Stack & Conventions
- **Language**: TypeScript (`strict: true`)
- **Framework**: Next.js App Router (Mobile-First PWA)
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)

## Commands
Before completing any task, ensure the following commands run successfully in the Cloud VM:
- `npm run build`
- `npm run lint`
- `npm run test`

## 5 Core Business Invariants (Strict Rules - DO NOT VIOLATE)

### 1. Units & Numeric Precision
- All raw material quantities MUST use the base unit of Kilogram (`kg`) with 3 decimal places precision.
  - In Database: `NUMERIC(10,3)`
  - In Code Calculations: Use integer in grams (multiply by 1000) or decimal libraries. Never use standard `float` for weight or money.
- All monetary values MUST be in Indonesian Rupiah (IDR).
  - In Database: `NUMERIC(15,2)`
  - In Code: Integer (since IDR has no fractional cents practically, but DB stores 2 decimals for accounting standard).

### 2. 100% Shrinkage/Reject Borne by Supplier
- If there is a discrepancy between dispatched weight (`qty_dispatched_kg`) and net accepted weight at the kitchen (`qty_accepted_kg`), this difference (`qty_shrinkage_kg`) reduces the payout to the Supplier.
- `Kitchen Invoice` (Billed to Kitchen) = `qty_accepted_kg * kitchen_unit_price_snapshot`
- `Supplier Net Payable` (Owed to Supplier) = `qty_accepted_kg * supplier_actual_cost_snapshot`

### 3. Actual Supplier Batch Costing & Immutable Snapshot
- Purchase price MUST use the actual cost from the supplier per procurement batch (`supplier_batch_id`), NEVER an average price.
- Every delivery line item/invoice to the kitchen MUST store a permanent snapshot of `supplier_actual_cost_snapshot` and `kitchen_unit_price_snapshot` at the time the transaction is created.

### 4. Cash-Basis Profit Sharing (Team vs Koperasi)
- `total_markup = qty_accepted_kg * (kitchen_unit_price_snapshot - supplier_actual_cost_snapshot)`
- `total_markup` is divided between the Team (`team_share_pct`) and Koperasi (`koperasi_share_pct`).
- Profit sharing balance status MUST be `LOCKED_UNPAID` as long as the Kitchen Invoice status is `DRAFT`, `ISSUED`, or `PARTIAL`.
- Profit sharing balance can ONLY become `AVAILABLE_FOR_PAYOUT` when the Kitchen Invoice status is updated to `PAID`.

### 5. Strict RBAC (Cost Price Protection)
- **FIELD_TEAM**: Can only access quantity data (`kg`), kitchen list, and kitchen acceptance weigh-in forms (BAST). Fields like `supplier_actual_cost`, `markup`, and `profit_share` MUST be hidden from API responses and UI for this role.
- **KOPERASI_VIEWER**: Read-only access to quantity summaries, invoice statuses (`UNPAID`/`PAID`), and Koperasi profit-sharing rights.
- **ADMIN_FINANCE**: Full access to all data and actions.
