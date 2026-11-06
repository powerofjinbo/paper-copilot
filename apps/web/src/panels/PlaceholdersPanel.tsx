/** Every placeholder in the file (`[fact?: …]`, `[claim: …?]`, `[ref]`, `[baseline?]` …); click to reveal. */
import { useMemo } from 'react';
import { findPlaceholders, type PlaceholderKind, type SentenceUnit } from '@paper-copilot/core';
import { revealSentence } from '../components/actions';
import { useUnitText } from '../components/hooks';
import { EmptyState, Highlight, PanelHeader, PanelSection, StateTag, displayLatex } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useWorkspace } from '../state/store';

export function placeholderKind(p: string): PlaceholderKind {
  try {
    const k = findPlaceholders(p)[0]?.kind;
    if (k) return k;
  } catch {
    /* core helper unavailable: use the prefix rules below */
  }
  if (/^\[fact\?/i.test(p)) return 'fact';
  if (/^\[claim:/i.test(p)) return 'claim';
  if (/^\[(ref|cite\??)\]$/i.test(p)) return 'ref';
  return 'generic';
}

const ORDER: PlaceholderKind[] = ['fact', 'claim', 'ref', 'generic'];

export function PlaceholdersPanel() {
  const t = useT();
  const units = useWorkspace((s) => s.units);
  const textOf = useUnitText();
  const groups = useMemo(() => {
    const g = new Map<PlaceholderKind, Array<{ unit: SentenceUnit; text: string; key: string }>>();
    for (const u of units) {
      u.placeholders.forEach((p, i) => {
        const k = placeholderKind(p);
        const list = g.get(k) ?? [];
        list.push({ unit: u, text: p, key: `${u.id}:${i}` });
        g.set(k, list);
      });
    }
    return ORDER.filter((k) => g.has(k)).map((k) => ({ kind: k, items: g.get(k)! }));
  }, [units]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="panel">
      <PanelHeader title={t('ph.title')} subtitle={t('ph.intro')} actions={total ? <span className="count-pill">{t('ph.count', { n: total })}</span> : null} />
      <div className="panel-body">
        {total === 0 ? (
          <EmptyState>{t('ph.empty')}</EmptyState>
        ) : (
          groups.map((g) => (
            <PanelSection key={g.kind} title={t(`ph.kind.${g.kind}` as MsgKey)} count={g.items.length}>
              <ul className="plain-list">
                {g.items.map(({ unit, text, key }) => (
                  <li key={key}>
                    <button type="button" className="list-row" onClick={() => revealSentence(unit.id)}>
                      <span className="list-row-top">
                        <code className="ph-chip" title={text}>
                          {text}
                        </code>
                        <span className="muted tabular">{t('common.line', { n: unit.line })}</span>
                      </span>
                      <span className="list-row-text">
                        <Highlight text={displayLatex(textOf(unit))} needle={text} />
                      </span>
                      <span className="list-row-meta">
                        <StateTag state={unit.state} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </PanelSection>
          ))
        )}
      </div>
    </div>
  );
}
