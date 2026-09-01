/** Sum an array of numbers passed as strings or numbers. */
export function sum(values) {
  let total = 0;
  for (const v of values) {
    total += v; // BUG: string concatenation when v is a string
  }
  return total;
}
