import { toMs, toSeconds } from 'src/pkg/utils/time.utils';

describe('time utilities', () => {
  it('converts supported units', () => {
    expect(toMs(2, 's')).toBe(2_000);
    expect(toMs(2, 'm')).toBe(120_000);
    expect(toMs(2, 'h')).toBe(7_200_000);
    expect(toMs(2, 'd')).toBe(172_800_000);
    expect(toSeconds(2, 'm')).toBe(120);
  });
});
