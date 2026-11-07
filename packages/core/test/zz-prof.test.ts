import { it } from 'vitest';
import { gateSentence } from '../src/gate/gate';
it('prof', () => {
  for (const n of [500, 1000, 2000]) {
    const t = '1\\% and '.repeat(n);
    const t0 = performance.now();
    gateSentence(t, { mode: 'draft', facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] });
    process.stderr.write(`T ${n} ` +  Math.round(performance.now() - t0) + "\n");
  }
});
