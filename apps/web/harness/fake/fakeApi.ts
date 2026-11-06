/**
 * A fake ApiClient for the editor harness: an in-memory message bus in front of FakeServer, with
 * latency, a connection switch (to exercise reconnects) and a log of every message for e2e checks.
 */
import type { ClientMessage, Outline, ProjectInfo, Proposal, ServerMessage } from '@paper-copilot/core';
import type { ApiClient, ServerMessageOf } from '../../src/contracts';
import { FakeServer, type FakeServerOptions } from './fakeServer';

type Handler = (msg: ServerMessage) => void;

const unavailable = (what: string) => Promise.reject(new Error(`${what} is not available in the editor harness`));

export class FakeApi implements ApiClient {
  connected = true;
  latencyMs = 20;
  readonly server: FakeServer;
  readonly sent: ClientMessage[] = [];
  readonly delivered: ServerMessage[] = [];
  private handlers = new Map<string, Set<Handler>>();
  private connHandlers = new Set<(c: boolean) => void>();

  constructor(raw: string, opts: FakeServerOptions = {}) {
    this.server = new FakeServer(raw, (m) => this.deliver(m), opts);
  }

  /* ------------------------------------------------------------------ socket */

  ready(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onConnection((c) => {
        if (c) {
          off();
          resolve();
        }
      });
    });
  }

  send(msg: ClientMessage): void {
    this.sent.push(msg);
    if (!this.connected) return;
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (this.connected) this.server.handle(copy);
    }, this.latencyMs);
  }

  on<T extends ServerMessage['type']>(type: T, fn: (msg: ServerMessageOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = fn as unknown as Handler;
    set.add(h);
    return () => set!.delete(h);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connHandlers.add(fn);
    return () => this.connHandlers.delete(fn);
  }

  /** Server -> client, after the latency; dropped while disconnected. */
  deliver(msg: ServerMessage): void {
    if (!this.connected) return;
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (!this.connected) return;
      this.delivered.push(copy);
      for (const fn of [...(this.handlers.get(copy.type) ?? [])]) fn(copy);
    }, this.latencyMs);
  }

  /** Emit a message as if the server had sent it (harness buttons). */
  inject(msg: ServerMessage): void {
    this.deliver(msg);
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const fn of [...this.connHandlers]) fn(connected);
  }

  /* ------------------------------------------------------------------ REST */

  private later<T>(fn: () => T, ms = this.server.actionDelayMs): Promise<T> {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(structuredClone(fn()));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, ms),
    );
  }

  project(): Promise<ProjectInfo> {
    return this.later(
      (): ProjectInfo => ({
        config: {
          schemaVersion: 1,
          name: 'canto-demo',
          texRoot: '/fixtures/canto-demo/tex',
          mainFile: 'main.tex',
          repoDir: '/fixtures/canto-demo/repo',
          skillDir: '/.skill',
          bibFiles: ['refs.bib'],
          venue: 'aps',
          notesLanguage: 'zh',
          factGlobs: ['results/**/*.json'],
          readerGlobs: [],
          models: { ghost: 'claude-haiku-5-5', actions: 'claude-sonnet-5-5', drafter: 'claude-opus-5-5', reader: 'claude-sonnet-5-5' },
          sync: { mode: 'none', remote: null, branch: 'main' },
          maxBudgetUsd: 5,
          semanticLines: true,
        },
        files: ['main.tex'],
        fakeLlm: true,
        skill: { found: true, dir: '/.skill', version: 'harness', references: [] },
        stats: { units: this.server.units.length, proposed: this.server.units.filter((u) => u.state === 'proposed').length, facts: this.server.facts.length, placeholders: 1 },
      }),
      5,
    );
  }
  facts() {
    return this.later(() => ({ facts: this.server.facts, unresolved: [] }), 5);
  }
  outline(): Promise<Outline> {
    return this.later(() => this.server.outline, 5);
  }
  saveOutline(outline: Outline): Promise<Outline> {
    return this.later(() => (this.server.outline = outline), 5);
  }
  history(sentenceId: string) {
    return this.later(() => this.server.history(sentenceId), 120);
  }
  instruct(sentenceId: string, instruction: string, _lang: string | null): Promise<Proposal> {
    return this.later(() => this.server.instruct(sentenceId, instruction));
  }
  alternatives(sentenceId: string, n: number): Promise<Proposal[]> {
    return this.later(() => this.server.alternatives(sentenceId, n));
  }
  grammar(sentenceId: string): Promise<Proposal> {
    return this.later(() => this.server.grammar(sentenceId));
  }
  accept(sentenceId: string) {
    return this.later(() => this.server.accept(sentenceId), 60);
  }
  reject(sentenceId: string) {
    return this.later(() => this.server.reject(sentenceId), 60);
  }
  renderIntent(_file: string, _line: number, text: string, n: number): Promise<Proposal[]> {
    return this.later(() => this.server.renderIntent(text, n));
  }

  patchFact = () => unavailable('patchFact');
  rescanFacts = () => unavailable('rescanFacts');
  panels = () => Promise.resolve({ claims: [], figures: [], terminology: [], lit: [] });
  readRepo = () => unavailable('readRepo');
  framings = () => unavailable('framings');
  draft = () => unavailable('draft');
  referee = () => unavailable('referee');
  questions = () => Promise.resolve([]);
  compile = () => Promise.resolve();
  pdfUrl = (v: number) => `about:blank#pdf-${v}`;
  synctexForward = () => Promise.resolve(null);
  synctexInverse = () => Promise.resolve(null);
  pull = () => Promise.resolve([]);
  pushCheck = () => unavailable('pushCheck');
  push = () => unavailable('push');
  disclosure = () => unavailable('disclosure');
  styleDistance = () => unavailable('styleDistance');
  voice = () => Promise.resolve({ memo: '', corpus: [], editPairs: [] });
  setMemo = () => Promise.resolve();
  addCorpus = () => Promise.resolve([]);
  cost = () => unavailable('cost');
  dismissLint = () => unavailable('dismissLint');
}
