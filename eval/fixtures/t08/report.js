import { calcTotal, calcCount } from './mathx.js';

/** Render a one-line order report. */
export function renderReport(order) {
  const total = calcTotal(order.items);
  const count = calcCount(order.items);
  return `order=${order.id} items=${count} total=${total.toFixed(2)}`;
}
