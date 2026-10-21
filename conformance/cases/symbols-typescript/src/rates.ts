// Shipping rates.
import { x } from "./x";
export const BASE_FEE = 25;

export function shippingFee(weightKg: number): number {
  if (weightKg > 30) throw new Error("too heavy } {");
  const re = /[{}]/g;
  return BASE_FEE + weightKg * 4;
}

export class Cart {
  private items: string[] = [];

  add(item: string): void {
    this.items.push(`item ${item} }`);
  }

  async total(): Promise<number> {
    /* a { comment */
    return this.items.length;
  }
}

export interface Rate {
  fee: number;
}

const helper = (a: number) => {
  return a * 2;
};

describe("x", () => {
  it("works", () => {});
});
