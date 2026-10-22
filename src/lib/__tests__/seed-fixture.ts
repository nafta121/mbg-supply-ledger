import type { Item, Kitchen, ProfitSplitConfig } from '../../types/mbg';
import {
  applyBastWeights,
  createKitchenOrder,
  type EngineCtx,
  type EngineResult,
  markInvoicePaid as markInvoicePaidEngine,
  type MbgData,
  type OrderLineInput,
  type UpdateBastInput,
} from '../order-engine';
import { BUSINESS_DATE, type MbgState } from '../mbg-store';

const KITCHEN_LOCATIONS: Array<{ name: string; pic: string; area: string }> = [
  { name: 'SPPG Dapur 01 - Tebet (Dapur A)', pic: 'Budi Santoso', area: 'Jl. Tebet Raya No. 12, Jakarta Selatan' },
  { name: 'SPPG Dapur 02 - Cawang (Dapur B)', pic: 'Siti Aminah', area: 'Jl. Dewi Sartika No. 45, Jakarta Timur' },
  { name: 'SPPG Dapur 03 - Kalibata (Dapur C)', pic: 'Hendra Wijaya', area: 'Jl. Raya Kalibata No. 8, Jakarta Selatan' },
  { name: 'SPPG Dapur 04 - Pasar Minggu (Dapur D)', pic: 'Rina Kusuma', area: 'Jl. Ragunan Raya No. 19, Jakarta Selatan' },
  { name: 'SPPG Dapur 05 - Pancoran (Dapur E)', pic: 'Agus Pratama', area: 'Jl. Pancoran Barat No. 3, Jakarta Selatan' },
  { name: 'SPPG Dapur 06 - Manggarai', pic: 'Dewi Sartika', area: 'Jl. Sultan Agung No. 21, Jakarta Selatan' },
  { name: 'SPPG Dapur 07 - Matraman', pic: 'Eko Nugroho', area: 'Jl. Matraman Raya No. 54, Jakarta Timur' },
  { name: 'SPPG Dapur 08 - Jatinegara', pic: 'Fajar Hidayat', area: 'Jl. Jatinegara Timur No. 77, Jakarta Timur' },
  { name: 'SPPG Dapur 09 - Kramat Jati', pic: 'Gita Permata', area: 'Jl. Raya Bogor KM 19, Jakarta Timur' },
  { name: 'SPPG Dapur 10 - Cililitan', pic: 'Hadi Sucipto', area: 'Jl. Mayjen Sutoyo No. 14, Jakarta Timur' },
  { name: 'SPPG Dapur 11 - Pejaten', pic: 'Indah Lestari', area: 'Jl. Pejaten Barat No. 30, Jakarta Selatan' },
  { name: 'SPPG Dapur 12 - Kemang', pic: 'Joko Susilo', area: 'Jl. Kemang Raya No. 62, Jakarta Selatan' },
  { name: 'SPPG Dapur 13 - Mampang', pic: 'Kartika Sari', area: 'Jl. Mampang Prapatan No. 88, Jakarta Selatan' },
  { name: 'SPPG Dapur 14 - Kuningan', pic: 'Lukman Hakim', area: 'Jl. HR Rasuna Said Kav. 10, Jakarta Selatan' },
  { name: 'SPPG Dapur 15 - Setiabudi', pic: 'Maya Anggraini', area: 'Jl. Setiabudi Utara No. 5, Jakarta Selatan' },
  { name: 'SPPG Dapur 16 - Cipete', pic: 'Nanda Putra', area: 'Jl. Cipete Raya No. 41, Jakarta Selatan' },
  { name: 'SPPG Dapur 17 - Fatmawati', pic: 'Oki Setiawan', area: 'Jl. RS Fatmawati No. 17, Jakarta Selatan' },
  { name: 'SPPG Dapur 18 - Cilandak', pic: 'Putri Maharani', area: 'Jl. Cilandak KKO No. 25, Jakarta Selatan' },
  { name: 'SPPG Dapur 19 - Jagakarsa', pic: 'Qori Rahman', area: 'Jl. Moh. Kahfi II No. 9, Jakarta Selatan' },
  { name: 'SPPG Dapur 20 - Lenteng Agung', pic: 'Rudi Hermawan', area: 'Jl. Raya Lenteng Agung No. 33, Jakarta Selatan' },
  { name: 'SPPG Dapur 21 - Duren Sawit', pic: 'Sari Wulandari', area: 'Jl. Kolonel Sugiono No. 50, Jakarta Timur' },
  { name: 'SPPG Dapur 22 - Pondok Bambu', pic: 'Taufik Hidayat', area: 'Jl. Pahlawan Revolusi No. 16, Jakarta Timur' },
  { name: 'SPPG Dapur 23 - Klender', pic: 'Umar Bakri', area: 'Jl. I Gusti Ngurah Rai No. 72, Jakarta Timur' },
  { name: 'SPPG Dapur 24 - Rawamangun', pic: 'Vina Panduwinata', area: 'Jl. Pemuda No. 29, Jakarta Timur' },
  { name: 'SPPG Dapur 25 - Pulogadung', pic: 'Wahyu Kurniawan', area: 'Jl. Perintis Kemerdekaan No. 64, Jakarta Timur' },
];

const SEED_ITEMS: Array<
  Pick<Item, 'id' | 'sku' | 'name' | 'category' | 'default_kitchen_price_per_kg' | 'default_margin_per_kg'>
> = [
  { id: 'item-wortel', sku: 'SYR-WRT-KG', name: 'Wortel', category: 'Sayuran Segar', default_kitchen_price_per_kg: 14000, default_margin_per_kg: 2000 },
  { id: 'item-kubis', sku: 'SYR-KBS-KG', name: 'Kubis', category: 'Sayuran Segar', default_kitchen_price_per_kg: 10000, default_margin_per_kg: 1500 },
  { id: 'item-ayam', sku: 'AYM-FIL-KG', name: 'Daging Ayam Fillet', category: 'Protein Hewani', default_kitchen_price_per_kg: 40000, default_margin_per_kg: 4000 },
  { id: 'item-telur', sku: 'TLR-AYM-KG', name: 'Telur Ayam', category: 'Protein Hewani', default_kitchen_price_per_kg: 30500, default_margin_per_kg: 3000 },
  { id: 'item-beras', sku: 'BRS-PRM-KG', name: 'Beras', category: 'Karbohidrat Utama', default_kitchen_price_per_kg: 15000, default_margin_per_kg: 1500 },
];

function unwrap<T extends MbgData>(res: EngineResult<T>, step: string): T {
  if (!res.ok) throw new Error(`Seed gagal (${step}): ${res.error}`);
  return res.data;
}

export function createInitialSeedState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';
  let n = 0;
  const ctx: EngineCtx = {
    nowIso,
    today: BUSINESS_DATE,
    uid: (prefix) => `${prefix}-${String(++n).padStart(2, '0')}`,
  };

  const kitchens: Kitchen[] = KITCHEN_LOCATIONS.map((loc, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    return {
      id: `kitchen-${num}`,
      kitchen_code: `DPR-${num}`,
      name: loc.name,
      address: loc.area,
      pic_name: loc.pic,
      pic_phone: `0812-9000-00${num}`,
      default_markup_per_kg: 0,
      is_active: true,
      created_at: nowIso,
    };
  });

  const items: Item[] = SEED_ITEMS.map((it) => ({
    ...it,
    base_unit: 'kg',
    is_active: true,
    created_at: nowIso,
  }));

  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    admin_pin: '1122',
    coop_pin: '3344',
    payment_bank_name: 'BRI',
    payment_account_number: '0000-0000-0000-000',
    payment_account_holder: 'Bendahara Supplier MBG',
    is_active: true,
    effective_from: BUSINESS_DATE,
    created_at: nowIso,
  };

  let data: MbgData = {
    kitchens,
    items,
    deliveries: [],
    deliveryItems: [],
    invoices: [],
    splitConfig,
    ledgerEntries: [],
    payoutBatches: [],
  };

  const line = (item_id: string, qty: number): OrderLineInput => {
    const it = items.find((i) => i.id === item_id)!;
    return {
      item_id,
      qty_ordered_kg: qty,
      kitchen_unit_price_rp: it.default_kitchen_price_per_kg,
      margin_per_kg_rp: it.default_margin_per_kg,
    };
  };
  const order = (kitchenIdx: number, lines: OrderLineInput[]) => {
    const res = createKitchenOrder(data, { kitchen_id: kitchens[kitchenIdx]!.id, lines }, ctx);
    data = unwrap(res, `order ${kitchenIdx + 1}`);
    if (!res.ok || !res.delivery_id) throw new Error('Seed gagal: order tanpa id');
    return res.delivery_id;
  };
  const weigh = (deliveryId: string, weights: Array<[string, number, string | null]>) => {
    const inputs: UpdateBastInput[] = weights.map(([itemId, kg, reason]) => {
      const di = data.deliveryItems.find((d) => d.delivery_id === deliveryId && d.item_id === itemId)!;
      return { delivery_item_id: di.id, qty_accepted_kg: kg, rejection_reason: reason };
    });
    data = unwrap(applyBastWeights(data, inputs, '2026-10-16T09:00:00.000Z'), 'timbang');
  };
  const pay = (deliveryId: string) => {
    const inv = data.invoices.find((i) => i.delivery_id === deliveryId)!;
    data = unwrap(markInvoicePaidEngine(data, inv.id, '2026-10-16T15:00:00.000Z'), 'lunas');
  };

  const o1 = order(0, [line('item-wortel', 35), line('item-kubis', 25)]);
  weigh(o1, [
    ['item-wortel', 35, null],
    ['item-kubis', 25, null],
  ]);
  pay(o1);

  const o2 = order(1, [line('item-ayam', 50), line('item-telur', 20)]);
  weigh(o2, [
    ['item-ayam', 49, 'Susut — susut air/perjalanan'],
    ['item-telur', 20, null],
  ]);
  pay(o2);

  const o3 = order(2, [line('item-wortel', 35), line('item-beras', 50)]);
  weigh(o3, [
    ['item-wortel', 33, 'Barang Rusak/Reject — wortel patah/busuk'],
    ['item-beras', 50, null],
  ]);

  order(3, [line('item-wortel', 35), line('item-kubis', 50), line('item-ayam', 50)]);

  const o5 = order(4, [line('item-ayam', 50), line('item-telur', 25)]);
  weigh(o5, [['item-ayam', 50, null]]);

  return { activeRole: 'OWNER_ADMIN', activeTab: 'orders', ...data };
}
