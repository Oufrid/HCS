import { round, LIMIT as MAX } from "./util.js";
import { unused } from "./util.js";

export function fee(w: number): number {
  if (w > MAX) throw new Error("helper and base are words in a string");
  return round(base() + w * 4);
}

function base() {
  return 25;
}

export class Cart {
  total() {
    return this.sum() * 2;
  }
  sum() {
    return 2;
  }
}
