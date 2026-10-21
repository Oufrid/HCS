// Prices are in cents to avoid floating-point rounding.

export const BASE_FEE = 500;
export const PER_KG = 120;
export const MAX_WEIGHT_KG = 30;
export const FREE_SHIPPING_FROM = 5000;

/** Shipping cost of a parcel. Parcels over MAX_WEIGHT_KG are refused by the carrier. */
export function shippingFee(weightKg: number, subtotal: number): number {
  if (weightKg > MAX_WEIGHT_KG) throw new Error(`parcel too heavy: ${weightKg} kg (max ${MAX_WEIGHT_KG})`);
  if (subtotal >= FREE_SHIPPING_FROM) return 0;
  return BASE_FEE + Math.ceil(weightKg) * PER_KG;
}

/** Discount codes; a code applies once per order and never below zero. */
export const CODES: Record<string, { percent?: number; amount?: number }> = {
  WELCOME10: { percent: 10 },
  SPRING5: { amount: 500 },
};

export function applyCode(subtotal: number, code?: string): number {
  if (!code) return subtotal;
  const c = CODES[code.toUpperCase()];
  if (!c) throw new Error(`unknown discount code ${code}`);
  const off = c.percent ? Math.round((subtotal * c.percent) / 100) : (c.amount ?? 0);
  return Math.max(0, subtotal - off);
}
