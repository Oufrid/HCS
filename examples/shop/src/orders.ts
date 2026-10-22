import { applyCode, shippingFee } from "./pricing";

export interface Line {
  sku: string;
  unitPrice: number;
  quantity: number;
  weightKg: number;
}

export interface Order {
  id: string;
  lines: Line[];
  code?: string;
  status: "pending" | "paid" | "shipped" | "delivered" | "refunded";
  deliveredAt?: string;
}

/** Total in cents: discounted subtotal plus shipping, computed on the subtotal before the discount. */
export function orderTotal(order: Order): number {
  const subtotal = order.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const weight = order.lines.reduce((s, l) => s + l.weightKg * l.quantity, 0);
  return applyCode(subtotal, order.code) + shippingFee(weight, subtotal);
}

/** Orders move forward only: pending -> paid -> shipped -> delivered; refunds only after payment. */
const NEXT: Record<Order["status"], Order["status"][]> = {
  pending: ["paid"],
  paid: ["shipped", "refunded"],
  shipped: ["delivered"],
  delivered: ["refunded"],
  refunded: [],
};

export function transition(order: Order, to: Order["status"]): Order {
  if (!NEXT[order.status].includes(to)) throw new Error(`cannot go from ${order.status} to ${to}`);
  return { ...order, status: to, deliveredAt: to === "delivered" ? new Date().toISOString() : order.deliveredAt };
}
