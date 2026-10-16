# Domain Workflows & Formulas
## MBG Supply Chain, Invoicing & Profit-Sharing Ledger

This document details the daily operational workflow for managing supply chains across 20-30 Free Nutritious Meal (Makan Bergizi Gratis / MBG) Kitchens.

### Workflow 1: Supplier Batch Entry & Actual Costing
**Actor**: `ADMIN_FINANCE`
1. Admin records incoming raw materials from a specific supplier into a new Batch.
2. The exact price paid to the supplier for this batch is recorded as `supplier_actual_cost_per_kg`.
3. This establishes the baseline cost for profit calculations, tied strictly to `supplier_batch_id`. Average costing is strictly prohibited.

### Workflow 2: 20-30 Kitchen Matrix Allocation & Markup Setup
**Actor**: `ADMIN_FINANCE`
1. Admin allocates the purchased batch across 20-30 kitchens.
2. Admin sets the selling price to the kitchens (`kitchen_unit_price_per_kg`).
3. The system locks these prices into snapshots (`supplier_actual_cost_snapshot`, `kitchen_unit_price_snapshot`) for each delivery line item to ensure historical accuracy even if master prices change.

### Workflow 3: Field Delivery, Kitchen Weigh-In (BAST), & Supplier Shrinkage Claim
**Actor**: `FIELD_TEAM`
1. Field team delivers items to kitchens based on `qty_dispatched_kg`.
2. Kitchen staff weighs the received items. Field team inputs `qty_accepted_kg` in the mobile app and uploads photo evidence (scale/delivery note).
3. System automatically calculates `qty_shrinkage_kg = qty_dispatched_kg - qty_accepted_kg`.
4. Shrinkage automatically reduces the payable amount to the supplier. The supplier is only paid for `qty_accepted_kg`.

### Workflow 4: Kitchen Invoicing & Payment Reconciliation
**Actor**: `ADMIN_FINANCE`
1. Invoices are generated based on `qty_accepted_kg`.
   - Formula: `Invoice Total = qty_accepted_kg * kitchen_unit_price_snapshot`
2. Invoice status begins as `UNPAID` (or `DRAFT`/`ISSUED`).
3. Finance reconciles bank transfers and updates invoice status to `PAID`.

### Workflow 5: Profit-Sharing Ledger (Team vs Koperasi)
**Actor**: System (Automated) / `ADMIN_FINANCE` / `KOPERASI_VIEWER`
1. Profit is calculated on a cash-basis strictly upon kitchen acceptance.
   - `total_markup = qty_accepted_kg * (kitchen_unit_price_snapshot - supplier_actual_cost_snapshot)`
2. `total_markup` is split based on agreed percentages (e.g., Team 60%, Koperasi 40%).
3. **Cash-Basis Rule**: The calculated profit starts with status `LOCKED_UNPAID`. It is NOT available for withdrawal.
4. When the linked Kitchen Invoice status changes to `PAID`, a database trigger automatically updates the profit ledger status to `AVAILABLE_FOR_PAYOUT`.

#### Simulation Table Example

| Scenario | Dispatched | Accepted | Shrinkage | Supplier Cost | Kitchen Price | Supplier Payable | Kitchen Inv | Total Markup | Team (60%) | Kop. (40%) | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Normal | 10.000 kg | 10.000 kg | 0.000 kg | 10,000 | 12,000 | 100,000 | 120,000 | 20,000 | 12,000 | 8,000 | `AVAILABLE` (Inv PAID) |
| Shrinkage | 15.000 kg | 14.500 kg | 0.500 kg | 10,000 | 12,000 | 145,000 | 174,000 | 29,000 | 17,400 | 11,600 | `LOCKED` (Inv UNPAID)|
