Berdasarkan `AGENTS.md`, `.agents/rules/business-and-financial-invariants.md`, `.agents/rules/cloud-ci-cd-execution.md`, `docs/03-mobile-ux-and-batch-screens.md`, `src/types/mbg.ts`, dan `src/lib/financial-engine.ts`:

PATUHI ATURAN `.agents/rules/cloud-ci-cd-execution.md`: DILARANG menjalankan `npm install`, `npm test`, atau `npm run build` di lokal. Cukup tulis seluruh file kode dan konfigurasi (`package.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`), lalu lakukan `git add .`, `git commit`, dan `git push origin main`.

Bangun aplikasi antarmuka pengguna (Mobile-First Web App) yang utuh dan interaktif:

1. **Interactive Local Store + Realistic MBG Seed Data (`src/lib/mbg-store.ts`):**
   - State management berbasis React Context + `localStorage` persistence dengan tombol **"Reset Data Simulasi"**.
   - Seed Data mencakup 25 Dapur MBG (SPPG 01 s/d 25), 3 Supplier, 5 komoditas bahan baku dalam satuan `kg` (presisi 3 desimal), serta transaksi simulasi (ada susut di dapur yang 100% memotong tagihan supplier, invoice `PAID`, dan invoice `UNPAID`).

2. **Mobile App Shell & Role Switcher (`src/components/AppShell.tsx`):**
   - Desain mobile-first (`max-w-md mx-auto` dengan Bottom Navigation Bar 5 tab).
   - **Role Switcher Bar** di bagian atas layar untuk berpindah instan antara:
     * `OWNER_ADMIN` (Akses penuh harga beli aktual supplier, markup, invoice, dan pencairan bagi hasil).
     * `FIELD_TEAM` (Mode Lapangan: HANYA menampilkan bobot `kg` dan input BAST timbangan terima dapur; seluruh harga modal, markup, dan tab keuangan WAJIB disembunyikan).
     * `COOPERATIVE_VIEWER` (Read-only untuk melihat bobot terima dapur, status invoice `UNPAID` vs `PAID`, dan hak bagi hasil Koperasi).

3. **5 Layar Utama (`src/app/layout.tsx`, `src/app/page.tsx`, dan komponen modular):**
   - **Tab 1 (Batch Supplier):** Input barang masuk dari supplier (`qty_received_kg` & `supplier_actual_cost_per_kg`) + sisa stok batch.
   - **Tab 2 (Matriks Alokasi 20–30 Dapur & Markup):** Grid cepat alokasi `qty_dispatched_kg` ke 20–30 dapur dari batch supplier + set `kitchen_unit_price_per_kg`.
   - **Tab 3 (Lapangan BAST & Timbang Terima):** Input `qty_accepted_kg`, tombol "Terima 100%", kalkulasi otomatis `qty_shrinkage_kg` sebagai potongan 100% ke Supplier.
   - **Tab 4 (Invoice Dapur, Cetak PDF, & Settlement Supplier):** Daftar Invoice Dapur dengan tombol **"Tandai Lunas (PAID)"**, daftar Tagihan Bersih Supplier (setelah dipotong susut), serta fitur **Print PDF (`window.print()`) & Share WA** untuk Invoice Dapur, Surat Jalan BAST, dan Nota Potongan Susut Supplier.
   - **Tab 5 (Ledger Bagi Hasil Cash-Basis Tim vs Koperasi):** Pemisahan tegas antara kartu **"Saldo Tertahan (LOCKED_UNPAID - Invoice Belum Lunas)"** vs **"Saldo Siap Cair (AVAILABLE_FOR_PAYOUT - Invoice Sudah PAID)"** beserta tombol **"Cairkan Dana"**.

4. **Akhiri dengan Git Commit & Push ke GitHub:**
   - Jalankan `git add . && git commit -m "feat: build mobile UI screens, print views, and cloud CI" && git push origin main`.
