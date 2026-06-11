import {
  fromMinor,
  multiplyMinor,
  sumMinor,
  toMinor,
} from 'src/pkg/utils/money';

describe('money utilities', () => {
  it('converts, sums, and multiplies minor units', () => {
    expect(toMinor(12.345)).toBe(1235);
    expect(fromMinor(1235)).toBe(12.35);
    expect(sumMinor([100, 250, -50])).toBe(300);
    expect(multiplyMinor(250, 3)).toBe(750);
  });
});
