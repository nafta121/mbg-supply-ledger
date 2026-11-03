import type { Item, Kitchen, ProfitLedgerEntry, ProfitSplitConfig } from '../../types/mbg';
import { parseShrinkReason } from '../courier-view';
import { DEFAULT_PAYMENT_INFO, idrToSen, roundKg, senToIdr } from '../financial-engine';
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
import type {
  AppSettingsRow,
  KitchenInvoiceRow,
  KitchenOrderItemRow,
  KitchenOrderRow,
  KitchenRow,
  ProductRow,
  ProfitLedgerRow,
  ProfitPayoutBatchRow,
  ProfitSplitConfigRow,
} from '../supabase-sync';

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
    ...DEFAULT_PAYMENT_INFO,
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

export function toSupabaseRows(data: MbgData): {
  kitchens: KitchenRow[];
  products: ProductRow[];
  orders: KitchenOrderRow[];
  orderItems: KitchenOrderItemRow[];
  invoices: KitchenInvoiceRow[];
  ledgerEntries: ProfitLedgerRow[];
  splitConfig: ProfitSplitConfigRow;
  appSettings: AppSettingsRow;
  payoutBatches: ProfitPayoutBatchRow[];
} {
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const deliveryById = new Map(data.deliveries.map((d) => [d.id, d]));
  const invoiceById = new Map(data.invoices.map((i) => [i.id, i]));

  const kitchens: KitchenRow[] = data.kitchens.map((k) => ({
    id: k.id,
    code: k.kitchen_code,
    name: k.name,
    address: k.address || '-',
    pic_name: k.pic_name,
    pic_phone: k.pic_phone,
    default_markup_per_kg: k.default_markup_per_kg,
    is_active: k.is_active,
    created_at: k.created_at,
  }));

  const products: ProductRow[] = data.items.map((i) => ({
    id: i.id,
    code: i.sku,
    name: i.name,
    category: i.category,
    default_kitchen_price_rp: i.default_kitchen_price_per_kg,
    default_margin_per_kg_rp: i.default_margin_per_kg,
    is_active: i.is_active,
    created_at: i.created_at,
  }));

  const orders: KitchenOrderRow[] = data.deliveries.map((d) => ({
    id: d.id,
    order_code: d.delivery_number,
    kitchen_id: d.kitchen_id,
    order_date: d.delivery_date,
    status: d.status,
    bast_signed_by_name: d.bast_signed_by_name,
    bast_verified_at: d.bast_verified_at,
    notes: d.notes,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));

  const orderItems: KitchenOrderItemRow[] = data.deliveryItems.map((di) => {
    const prod = itemById.get(di.item_id);
    const parsedReason = parseShrinkReason(di.rejection_reason);
    const isWeighed = di.weighed_at !== null;
    return {
      id: di.id,
      order_id: di.delivery_id,
      product_id: di.item_id,
      product_name_snapshot: prod?.name ?? di.item_id,
      qty_ordered_kg: roundKg(di.qty_dispatched_kg),
      qty_accepted_kg: isWeighed ? roundKg(di.qty_accepted_kg) : null,
      kitchen_unit_price_rp: di.kitchen_unit_price_snapshot,
      margin_per_kg_rp: di.margin_per_kg_snapshot,
      is_weighed: isWeighed,
      weighed_at: di.weighed_at,
      shrinkage_reason: parsedReason.reason,
      shrinkage_note: parsedReason.note || null,
      created_at: di.created_at,
      updated_at: di.updated_at,
    };
  });

  const supplierName = data.splitConfig.supplier_name ?? DEFAULT_PAYMENT_INFO.supplier_name;
  const bankName = data.splitConfig.payment_bank_name ?? DEFAULT_PAYMENT_INFO.payment_bank_name;
  const accountNumber = data.splitConfig.payment_account_number ?? DEFAULT_PAYMENT_INFO.payment_account_number;
  const accountHolder = data.splitConfig.payment_account_holder ?? DEFAULT_PAYMENT_INFO.payment_account_holder;

  const invoices: KitchenInvoiceRow[] = data.invoices.map((inv) => ({
    id: inv.id,
    invoice_code: inv.invoice_number,
    order_id: inv.delivery_id,
    kitchen_id: inv.kitchen_id,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date,
    total_amount_rp: inv.total_invoice_amount,
    amount_paid_rp: inv.amount_paid,
    status: inv.payment_status === 'PAID' ? 'PAID' : 'UNPAID',
    paid_at: inv.paid_at,
    supplier_name: inv.supplier_name ?? supplierName,
    payment_bank_name: inv.payment_bank_name ?? bankName,
    payment_account_number: inv.payment_account_number ?? accountNumber,
    payment_account_holder: inv.payment_account_holder ?? accountHolder,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
  }));

  const byDeliveryItem = new Map<string, { team?: ProfitLedgerEntry; coop?: ProfitLedgerEntry }>();
  for (const le of data.ledgerEntries) {
    const pair = byDeliveryItem.get(le.delivery_item_id) ?? {};
    if (le.beneficiary_type === 'TEAM') pair.team = le;
    else pair.coop = le;
    byDeliveryItem.set(le.delivery_item_id, pair);
  }

  const ledgerEntries: ProfitLedgerRow[] = [];
  for (const [deliveryItemId, pair] of byDeliveryItem.entries()) {
    const sample = pair.team ?? pair.coop;
    if (!sample) continue;
    const inv = invoiceById.get(sample.invoice_id);
    const deliv = inv ? deliveryById.get(inv.delivery_id) : undefined;
    const kitchenId = inv?.kitchen_id ?? deliv?.kitchen_id ?? data.kitchens[0]?.id ?? 'kitchen-01';
    const orderId = inv?.delivery_id ?? deliv?.id ?? null;
    const teamAmt = pair.team?.profit_amount ?? 0;
    const coopAmt = pair.coop?.profit_amount ?? 0;
    const gross = senToIdr(idrToSen(teamAmt) + idrToSen(coopAmt));
    const teamPaid = pair.team?.payout_status === 'PAID_OUT';
    const coopPaid = pair.coop?.payout_status === 'PAID_OUT';
    let combinedStatus: 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT' = 'LOCKED_UNPAID';
    if (teamPaid && coopPaid) {
      combinedStatus = 'PAID_OUT';
    } else if (
      pair.team?.payout_status === 'AVAILABLE_FOR_PAYOUT' ||
      pair.coop?.payout_status === 'AVAILABLE_FOR_PAYOUT' ||
      teamPaid ||
      coopPaid
    ) {
      combinedStatus = 'AVAILABLE_FOR_PAYOUT';
    }

    ledgerEntries.push({
      id: `ple-${deliveryItemId}`,
      invoice_id: sample.invoice_id,
      order_id: orderId,
      order_item_id: deliveryItemId,
      kitchen_id: kitchenId,
      gross_margin_rp: gross,
      team_share_pct: pair.team?.share_pct_snapshot ?? data.splitConfig.team_share_pct,
      coop_share_pct: pair.coop?.share_pct_snapshot ?? data.splitConfig.cooperative_share_pct,
      team_amount_rp: teamAmt,
      coop_amount_rp: coopAmt,
      status: combinedStatus,
      team_paid_out: teamPaid,
      coop_paid_out: coopPaid,
      team_payout_batch_id: pair.team?.payout_batch_id ?? null,
      coop_payout_batch_id: pair.coop?.payout_batch_id ?? null,
      team_paid_out_at: pair.team?.paid_out_at ?? null,
      coop_paid_out_at: pair.coop?.paid_out_at ?? null,
      unlocked_at: pair.team?.unlocked_at ?? pair.coop?.unlocked_at ?? null,
      paid_out_at: pair.team?.paid_out_at ?? pair.coop?.paid_out_at ?? null,
      created_at: sample.created_at,
      updated_at: sample.updated_at,
    });
  }

  const splitConfig: ProfitSplitConfigRow = {
    id: data.splitConfig.id,
    config_name: data.splitConfig.config_name,
    team_share_pct: data.splitConfig.team_share_pct,
    cooperative_share_pct: data.splitConfig.cooperative_share_pct,
    supplier_name: supplierName,
    payment_bank_name: bankName,
    payment_account_number: accountNumber,
    payment_account_holder: accountHolder,
    is_active: data.splitConfig.is_active,
    effective_from: data.splitConfig.effective_from,
    created_at: data.splitConfig.created_at,
  };

  const appSettings: AppSettingsRow = {
    id: 'default',
    team_share_pct: data.splitConfig.team_share_pct,
    coop_share_pct: data.splitConfig.cooperative_share_pct,
    supplier_name: supplierName,
    payment_bank_name: bankName,
    payment_account_number: accountNumber,
    payment_account_holder: accountHolder,
  };

  const payoutBatches: ProfitPayoutBatchRow[] = data.payoutBatches.map((pb) => ({
    id: pb.id,
    payout_reference: pb.payout_reference,
    beneficiary_type: pb.beneficiary_type,
    total_payout_amount: pb.total_payout_amount,
    transfer_proof_url: pb.transfer_proof_url,
    notes: pb.notes,
    disbursed_by: pb.disbursed_by,
    disbursed_at: pb.disbursed_at,
    created_at: pb.created_at,
  }));

  return {
    kitchens,
    products,
    orders,
    orderItems,
    invoices,
    ledgerEntries,
    splitConfig,
    appSettings,
    payoutBatches,
  };
}
