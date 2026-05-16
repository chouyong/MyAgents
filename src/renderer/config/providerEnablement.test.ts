import { describe, expect, it } from 'vitest';

import {
  applyProviderEnablementAndOrder,
  isProviderEnabled,
  normalizeDisabledProviderIds,
  normalizeProviderOrder,
  type Provider,
} from './types';

const makeProvider = (id: string): Provider => ({
  id,
  name: id,
  vendor: 'Test',
  cloudProvider: 'Test',
  type: 'api',
  primaryModel: `${id}-model`,
  isBuiltin: false,
  authType: 'api_key',
  config: { baseUrl: `https://${id}.example/v1` },
  models: [{ model: `${id}-model`, modelName: `${id} Model`, modelSeries: 'test' }],
});

describe('provider enablement and ordering helpers', () => {
  it('normalizes order by removing unknowns and appending new providers', () => {
    expect(normalizeProviderOrder(['alpha', 'beta', 'gamma'], [
      'missing',
      'gamma',
      'alpha',
      'gamma',
    ])).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('normalizes disabled ids by keeping only known unique providers', () => {
    expect(normalizeDisabledProviderIds(['alpha', 'beta'], [
      'missing',
      'alpha',
      'alpha',
    ])).toEqual(['alpha']);
  });

  it('applies enabled flags and configured order without mutating defaults', () => {
    const providers = ['alpha', 'beta', 'gamma'].map(makeProvider);
    const ordered = applyProviderEnablementAndOrder(providers, {
      providerOrder: ['gamma', 'alpha'],
      disabledProviderIds: ['alpha'],
    });

    expect(ordered.map(provider => provider.id)).toEqual(['gamma', 'alpha', 'beta']);
    expect(ordered.find(provider => provider.id === 'alpha')?.enabled).toBe(false);
    expect(isProviderEnabled(ordered.find(provider => provider.id === 'gamma'))).toBe(true);
    expect(providers.find(provider => provider.id === 'alpha')?.enabled).toBeUndefined();
  });
});
