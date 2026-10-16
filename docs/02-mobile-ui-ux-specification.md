# Mobile UI/UX Specifications
## MBG Supply Chain Mobile-First PWA

This document outlines the ergonomic mobile screens designed for rapid field and administrative operations.

### Screen 1: Supplier Batch & Actual Cost Entry
- **Access**: `ADMIN_FINANCE`
- **Purpose**: Record incoming goods and exact cost per batch.
- **UX Features**:
  - Simple form: Select Item, Select Supplier, Input Total Kg, Input Total Cost.
  - Auto-calculates Cost per Kg (`supplier_actual_cost_per_kg`).
  - "Save Batch" button.

### Screen 2: 20-30 Kitchen Matrix Allocation & Markup Setup
- **Access**: `ADMIN_FINANCE`
- **Purpose**: Fast allocation of a batch to multiple kitchens.
- **UX Features**:
  - A responsive data grid optimized for mobile scrolling or tablet landscape.
  - Columns: Kitchen Name, Allocation (kg), Selling Price (Rp/kg).
  - "Apply to All" button for selling price to quickly set uniform pricing.
  - Visual indicator of remaining unallocated batch weight.
  - Batch save without page reloads.

### Screen 3: Field BAST & Weigh-In Screen
- **Access**: `FIELD_TEAM`, `ADMIN_FINANCE`
- **Purpose**: On-site confirmation of received goods by kitchen staff.
- **UX Features**:
  - **Crucial**: Cost and profit data are STRICTLY HIDDEN.
  - Large, thumb-friendly numeric keypad for inputting `qty_accepted_kg` (supports 3 decimals).
  - Real-time display of calculated `qty_shrinkage_kg`.
  - Camera integration: Large button to snap/upload photo of the digital scale and signed delivery note (Surat Jalan).
  - Big "Confirm Receipt" swipe-to-submit button to prevent accidental clicks.

### Screen 4: Kitchen Invoice & Payment Status Manager
- **Access**: `ADMIN_FINANCE`
- **Purpose**: Manage billing and payment reconciliation.
- **UX Features**:
  - Tabbed view: `UNPAID` | `PARTIAL` | `PAID`.
  - List of invoices showing Kitchen Name, Total Amount, Due Date.
  - Actions: Generate PDF, "Send via WhatsApp" deep link.
  - "Mark as PAID" action button (prompts for confirmation and payment reference).

### Screen 5: Supplier Net Settlement Screen
- **Access**: `ADMIN_FINANCE`
- **Purpose**: View how much is owed to suppliers after kitchen shrinkage deductions.
- **UX Features**:
  - Grouped by Supplier -> Batch.
  - Shows Dispatched Kg, Accepted Kg, Shrinkage Kg.
  - Clearly displays `Supplier Net Payable = Accepted Kg * Supplier Actual Cost`.
  - Export to Excel/CSV for bank transfer list.

### Screen 6: Cash-Basis Profit Split Dashboard
- **Access**: `ADMIN_FINANCE`, `KOPERASI_VIEWER`
- **Purpose**: Transparent view of profit sharing based on cash-basis rules.
- **UX Features**:
  - Two main cards at the top:
    1. **Locked Balance** (Amber/Warning color): Total profit from `UNPAID` invoices.
    2. **Available Payout** (Green/Success color): Total profit ready for withdrawal from `PAID` invoices.
  - Detailed list view below showing breakdown per invoice.
  - Tabs to switch view between "Team Share" and "Koperasi Share".
