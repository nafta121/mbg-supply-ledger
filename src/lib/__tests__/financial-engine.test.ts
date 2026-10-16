import {
    calculateSupplierSettlement,
    calculateKitchenInvoice,
    calculateProfitSplit,
    getProfitLedgerStatus
} from '../financial-engine';

describe('MBG Financial Engine', () => {
    describe('calculateSupplierSettlement', () => {
        it('calculates settlement correctly for exact kg', () => {
            // 10kg at Rp 10,000/kg
            expect(calculateSupplierSettlement(10000, 10000)).toBe(100000);
        });

        it('calculates settlement correctly with shrinkage (decimal kg)', () => {
            // 12.450kg accepted at Rp 15,000/kg
            expect(calculateSupplierSettlement(12450, 15000)).toBe(186750);
        });
    });

    describe('calculateKitchenInvoice', () => {
        it('calculates invoice amount correctly', () => {
            // 12.450kg accepted at Rp 18,000/kg selling price
            expect(calculateKitchenInvoice(12450, 18000)).toBe(224100);
        });
    });

    describe('calculateProfitSplit', () => {
        it('splits profit correctly (60/40)', () => {
            // 10kg, Cost: 10,000, Price: 12,000, Total Markup = 20,000
            const result = calculateProfitSplit(10000, 10000, 12000, 60, 40);
            expect(result.totalMarkup).toBe(20000);
            expect(result.teamShareAmount).toBe(12000);
            expect(result.koperasiShareAmount).toBe(8000);
        });

        it('handles decimal weight shrinkage scenarios gracefully', () => {
            // 14.500kg, Cost: 10,000, Price: 12,000, Total Markup = 29,000
            const result = calculateProfitSplit(14500, 10000, 12000, 60, 40);
            expect(result.totalMarkup).toBe(29000);
            expect(result.teamShareAmount).toBe(17400);
            expect(result.koperasiShareAmount).toBe(11600);
        });

        it('throws if percentages do not equal 100', () => {
            expect(() => {
                calculateProfitSplit(10000, 10000, 12000, 50, 40);
            }).toThrow("Profit split percentages must add up to 100");
        });
    });

    describe('getProfitLedgerStatus', () => {
        it('returns LOCKED_UNPAID for DRAFT', () => {
            expect(getProfitLedgerStatus('DRAFT')).toBe('LOCKED_UNPAID');
        });

        it('returns LOCKED_UNPAID for UNPAID/PARTIAL', () => {
            expect(getProfitLedgerStatus('ISSUED')).toBe('LOCKED_UNPAID');
            expect(getProfitLedgerStatus('PARTIAL')).toBe('LOCKED_UNPAID');
        });

        it('returns AVAILABLE_FOR_PAYOUT only for PAID', () => {
            expect(getProfitLedgerStatus('PAID')).toBe('AVAILABLE_FOR_PAYOUT');
        });
    });
});
