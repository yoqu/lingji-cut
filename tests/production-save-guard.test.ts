import { describe, expect, it } from 'vitest';
import {
  getProductionSaveGuard,
  registerProductionSaveGuard,
} from '../src/lib/production-save-guard';

describe('production save guard', () => {
  it('keeps the newest task guard when an older task finishes late', () => {
    const releaseOld = registerProductionSaveGuard({
      expectedDirectorRevision: 1,
      expectedTaskId: 'old-task',
    });
    const releaseCurrent = registerProductionSaveGuard({
      expectedDirectorRevision: 2,
      expectedTaskId: 'current-task',
    });

    releaseOld();
    expect(getProductionSaveGuard()).toEqual({
      expectedDirectorRevision: 2,
      expectedTaskId: 'current-task',
    });

    releaseCurrent();
    expect(getProductionSaveGuard()).toBeUndefined();
  });
});
