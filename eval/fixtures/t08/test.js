import { renderReport } from './report.js';

const order = { id: 'A-1', items: [{ price: 2.5, qty: 4 }, { price: 1, qty: 2 }] };
const got = renderReport(order);
const want = 'order=A-1 items=6 total=12.00';
if (got !== want) {
  console.error(`FAIL: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  process.exit(1);
}
console.log('ok');
