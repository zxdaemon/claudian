import { nextBackoffDelaySeconds } from '@/core/execution/autoResumeBackoff';

describe('nextBackoffDelaySeconds', () => {
  it('returns 30/60/120 for first three consecutive failures', () => {
    expect(nextBackoffDelaySeconds(0)).toBe(30);
    expect(nextBackoffDelaySeconds(1)).toBe(60);
    expect(nextBackoffDelaySeconds(2)).toBe(120);
  });

  it('returns null at or beyond the attempt cap', () => {
    expect(nextBackoffDelaySeconds(3)).toBeNull();
    expect(nextBackoffDelaySeconds(10)).toBeNull();
  });

  it('returns null for invalid inputs', () => {
    expect(nextBackoffDelaySeconds(-1)).toBeNull();
    expect(nextBackoffDelaySeconds(0.5)).toBeNull();
    expect(nextBackoffDelaySeconds(NaN)).toBeNull();
  });
});