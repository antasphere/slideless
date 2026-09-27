import { describe, expect, it } from 'vitest';
import { READMISSION_POLL_MS, readmissionPollInterval } from './readmission-poll';

describe('readmissionPollInterval', () => {
  it('polls every ten seconds while an organization is denied and the tab is visible', () => {
    expect(READMISSION_POLL_MS).toBe(10_000);
    expect(readmissionPollInterval(1, 'visible')).toBe(10_000);
    expect(readmissionPollInterval(3, 'visible')).toBe(10_000);
  });

  it('does not poll when nothing is denied', () => {
    expect(readmissionPollInterval(0, 'visible')).toBeNull();
  });

  it('stops while the tab is hidden', () => {
    expect(readmissionPollInterval(1, 'hidden')).toBeNull();
  });
});
