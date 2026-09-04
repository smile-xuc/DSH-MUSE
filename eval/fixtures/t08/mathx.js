/** mathx — tiny aggregation helpers. */
export function calcTotal(items) {
  return items.reduce((acc, it) => acc + it.price * it.qty, 0);
}

export function calcCount(items) {
  return items.reduce((acc, it) => acc + it.qty, 0);
}
