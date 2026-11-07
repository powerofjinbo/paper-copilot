import { readFileSync, readdirSync } from 'node:fs';
import { ChangeSet } from '@codemirror/state';
import { it } from 'vitest';
import { SyncCore, textOf } from '../../src/editor/sync/syncCore';
import { diffChangesOf } from '../../src/editor/safe';
const DIR = '/tmp/claude-0/-home-user/ee5dec42-8975-54cc-ab2d-58a63ecab31c/scratchpad/fuzz/';
const OUT: unknown[] = [];
import { writeFileSync } from 'node:fs';
it('replay', { timeout: 120000 }, () => {
  for (const f of readdirSync(DIR).filter((x) => x.startsWith('reconcile-'))) {
    const d = JSON.parse(readFileSync(DIR + f, 'utf8'));
    const b = d.before;
    const core = new SyncCore('main.tex');
    core.initialized = true;
    core.log = b.log.map((e: any) => ({ baseVersion: e.baseVersion, changes: ChangeSet.fromJSON(e.changes), annotation: null, sent: e.sent }));
    core.ackedVersion = b.ackedVersion;
    core.localVersion = b.log.length ? b.log[b.log.length - 1].baseVersion + 1 : b.ackedVersion;
    core.unitsVersion = b.ackedVersion;
    core.ackedText = textOf(b.ackedText);
    core.diskText = textOf(b.diskText);
    const local = b.localText as string;
    const toks = (s: string) => new Set(s.match(/zq[ab]\d+x\d+q/g) ?? []);
    const res = core.reconcile(b.snapshot, local, { reconnect: b.reconnect, connected: true, diff: diffChangesOf, oneInFlight: true });
    const after = res.remote ? res.remote.apply(textOf(local)).toString() : local;
    const lt = toks(local), st = toks(b.snapshot.text), at = toks(after);
    const lost = [...new Set([...lt, ...st])].filter((t) => !at.has(t));
    // which pending entries did the reconnect heuristic treat as applied?
    const t0 = Date.now(); const d2 = diffChangesOf(b.ackedText, b.snapshot.text); OUT.push('difftime', Date.now() - t0, 'len', local.length, 'after', after.length, 'snap', b.snapshot.text.length, 'acked', b.ackedText.length, 'sample', JSON.stringify(after.slice(0, 200)), 'localsample', JSON.stringify(local.slice(0,200)));
    OUT.push(f, res.mode, 'pending', b.log.filter((e: any) => e.baseVersion >= b.ackedVersion).length, 'snapV', b.snapshot.version, 'acked', b.ackedVersion, 'lost', JSON.stringify(lost), 'conflicts', res.conflicts.length, 'logAfter', core.log.length);
  }
  writeFileSync(DIR + '../replay.out', OUT.map(String).join('\n'));
});
