// SPDX-License-Identifier: MPL-2.0
import { AnalyzerPreparationCoordinator } from './analyzer-preparation';

describe('AnalyzerPreparationCoordinator', () => {
  it('runs local index work with the prepared analyzer and reuses it', async () => {
    const analyzer = { engine: 'jieba' };
    const order: string[] = [];
    const coordinator = new AnalyzerPreparationCoordinator(async () => {
      order.push('load-analyzer');
      return analyzer;
    });

    const result = await coordinator.runLocal(async (prepared) => {
      order.push(`rebuild:${prepared.engine}`);
      return 'rebuilt';
    });
    await coordinator.prepare();

    expect(result).toBe('rebuilt');
    expect(order).toEqual(['load-analyzer', 'rebuild:jieba']);
  });
});
