Berdasarkan `AGENTS.md`, `.agents/rules/business-and-financial-invariants.md`, `docs/03-mobile-ux-and-batch-screens.md`, `src/types/mbg.ts`, dan `src/lib/financial-engine.ts`:

Kita sekarang berada di lingkungan Cloud VM GitHub Codespaces (`linux_amd64`). Silakan bangun aplikasi antarmuka pengguna (Mobile-First Web App Next.js) secara utuh, jalankan `npm install`, `npm test`, dan `npm run build` untuk memverifikasi tidak ada error, lalu lakukan `git add .`, `git commit`, dan `git push origin main`.

Ruang lingkup fitur yang wajib diimplementasikan:

1. **Interactive Local Store + Realistic MBG Seed Data (`src/lib/mbg-store.ts`):**
   - State management berbasis React Context + `localStorage` persistence dengan tombol **"Reset Data Simulasi"**.
   - Seed Data mencakup 25 Dapur MBG (SPPG Dapur 01 s/d 25), 3 Supplier, 5 komoditas bahan baku dalam satuan `kg` (presisi 3 desimal), serta transaksi simulasi sesuai `docs/01-domain-workflows-and-formulas.md` (termasuk kasus susut/reject di dapur yang 100% memotong tagihan supplier, invoice `PAID`, dan invoice `UNPAID`).

2. **Mobile App Shell & Role Switcher (`src/components/AppShell.tsx`):**
   - Desain mobile-first (`max-w-md mx-auto` dengan Bottom Navigation Bar 5 tab).
   - **Role Switcher Bar** di bagian atas layar untuk berpindah instan antara:
     * `OWNER_ADMIN` (Akses penuh harga beli aktual supplier, pengaturan markup, invoice, dan pencairan bagi hasil).
     * `FIELD_TEAM` (Mode Tim Lapangan/Kurir: HANYA menampilkan bobot `kg` dan input BAST timbangan terima dapur; seluruh harga beli supplier, harga jual, markup, dan tab keuangan WAJIB disembunyikan menggunakan `sanitizeDeliveryForFieldTeam`).
     * `COOPERATIVE_VIEWER` (Mode Koperasi: Read-only untuk memantau bobot diterima dapur, status pelunasan invoice `UNPAID` vs `PAID`, dan saldo hak bagi hasil Koperasi).

3. **Implementasikan 5 Layar Utama (`src/app/layout.tsx`, `src/app/page.tsx`, dan komponen modular):**
   - **Tab 1 (Batch Supplier & Harga Aktual):** Input barang masuk dari supplier (`qty_received_kg` & `supplier_actual_cost_per_kg`) + daftar sisa stok batch.
   - **Tab 2 (Matriks Alokasi 20–30 Dapur & Markup):** Grid cepat alokasi `qty_dispatched_kg` ke 20–30 dapur sekaligus dari batch supplier yang dipilih + set `kitchen_unit_price_per_kg` (markup Rp/kg).
   - **Tab 3 (Lapangan BAST & Timbang Terima):** Input `qty_accepted_kg`, tombol "Terima 100% Sesuai Kirim", kalkulasi otomatis `qty_shrinkage_kg = qty_dispatched_kg - qty_accepted_kg` dengan badge peringatan bahwa susut 100% memotong tagihan Supplier.
   - **Tab 4 (Invoice Dapur, Cetak PDF, & Settlement Supplier):** Daftar Invoice Dapur dengan tombol **"Tandai Lunas (PAID)"**, daftar Tagihan Bersih Supplier (setelah dipotong susut dapur), serta fitur **Print PDF (`window.print()` dengan `@media print`) & Salin Ringkasan WhatsApp** untuk: (a) Invoice Dapur (tanpa harga modal), (b) Surat Jalan/BAST (tanpa harga), dan (c) Nota Potongan Susut Supplier.
   - **Tab 5 (Ledger Bagi Hasil Cash-Basis Tim vs Koperasi):** Pengaturan persentase bagi hasil (`Tim %` vs `Koperasi %`), pemisahan tegas antara kartu **"Saldo Tertahan (LOCKED_UNPAID - Menunggu Dapur Bayar)"** vs **"Saldo Siap Cair (AVAILABLE_FOR_PAYOUT - Invoice Sudah PAID)"**, dan tombol **"Cairkan Dana (Payout)"**.

4. **Verifikasi & Push:**
   - Jalankan `npm install`, `npm test`, `npm run typecheck`, dan `npm run build`.
   - Setelah lulus 100%, jalankan `git add . && git commit -m "feat: complete MBG mobile UI, PDF print views, and cash-basis profit ledger" && git push origin main`.
