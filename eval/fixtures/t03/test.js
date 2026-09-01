import { sum } from './sum.js';
const cases = [
  [[1, 2, 3], 6],
  [['1', '2', '3'], 6],
  [[], 0],
  [['4', 5], 9],
];
for (const [input, expected] of cases) {
  const got = sum(input);
  if (got !== expected) {
    console.error(`FAIL sum(${JSON.stringify(input)}) = ${got}, expected ${expected}`);
    process.exit(1);
  }
}
console.log('all tests passed');
