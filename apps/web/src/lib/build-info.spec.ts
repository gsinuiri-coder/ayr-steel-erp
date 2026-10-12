import { describe, expect, it } from 'vitest';
import { buildInfo } from './build-info';

describe('buildInfo (D-636)', () => {
  it('toma el sha y la fecha que fijó el build', () => {
    expect(
      buildInfo({ AYR_BUILD_SHA: 'abc1234def', AYR_BUILT_AT: '2026-10-12T20:00:00.000Z' }),
    ).toEqual({ sha: 'abc1234def', builtAt: '2026-10-12T20:00:00.000Z' });
  });

  it('en local, sin sha, dice «dev»', () => {
    expect(buildInfo({})).toEqual({ sha: 'dev', builtAt: null });
    expect(buildInfo({ AYR_BUILD_SHA: '' })).toEqual({ sha: 'dev', builtAt: null });
  });
});
