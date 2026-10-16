import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MBG B2B Supply Chain, Invoicing & Profit-Sharing Ledger',
  description:
    'Sistem Pengadaan Batch Supplier, Matriks Alokasi 25 Dapur MBG/SPPG, BAST Susut Supplier, Invoice Dapur, dan Ledger Bagi Hasil Cash-Basis Tim vs Koperasi',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
