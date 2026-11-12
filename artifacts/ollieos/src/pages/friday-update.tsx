import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  draftFridayUpdate,
  getGetFridayUpdateQueryKey,
  redraftFridayUpdateSection,
  saveFridayUpdateText,
  useGetFridayUpdate,
  type FridayUpdate,
  type FridayUpdateRedraftInputSection,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDayMonth, formatTime } from '@workspace/shared';
import { IconLeft } from '@/components/icons';
import { PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { copyText } from '@/lib/knowledge';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const H2 = { margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' } as const;

const SECTIONS: { key: FridayUpdateRedraftInputSection; title: string }[] = [
  { key: 'wins', title: '🏆 Wins' },
  { key: 'blockers', title: '🚧 Blockers' },
  { key: 'ai', title: '🤖 AI & Automation' },
  { key: 'quarterly', title: '🎯 Quarterly Actions' },
];

function basisLine(u: FridayUpdate): string {
  const b = u.basis;
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
  const parts = [n(b.done, 'task done', 'tasks done'), n(b.decisions, 'decision', 'decisions'), n(b.meetings, 'meeting', 'meetings'), n(b.waiting + b.overdue, 'stuck item', 'stuck items'), n(b.goals, 'goal', 'goals')];
  return `Drafted from ${parts.join(', ')}.${b.hidden ? ` ${n(b.hidden, 'item', 'items')} hidden from AI ${b.hidden === 1 ? 'was' : 'were'} left out.` : ''}`;
}

/**
 * Section 23: the Friday update. OllieOS drafts Ollie's weekly leadership update from the week it
 * saw; he redrafts a section, edits the post and copies it into Slack. OllieOS never posts it.
 */
export default function FridayUpdatePage() {
  const q = useGetFridayUpdate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState('');
  const u = q.data?.update ?? null;
  const shown = u ? (u.editedText ?? u.text) : '';
  useEffect(() => setText(shown), [shown]);
  const edited = !!u && text.trim() !== shown.trim();

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: getGetFridayUpdateQueryKey() });
      notify(done);
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (await copyText(text)) notify('Copied', 'Paste it into Slack.');
    else notify('Could not copy', 'Your browser blocked the clipboard.');
  };

  return (
    <div className="oo-fade-in" style={{ width: '100%', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-friday-update">
      <Link href="/" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-home"><IconLeft size={14} />Home</Link>
      <article className="oo-panel" style={{ padding: '36px 40px', display: 'flex', flexDirection: 'column', gap: 24 }} data-testid="article-friday-update">
        {q.isLoading ? (
          <PageSkeleton />
        ) : !q.data ? (
          <PageProblem notFound={false} what="Friday update" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
        ) : (
          <>
            <header style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p className="oo-serif oo-muted" style={{ margin: 0, fontSize: 18 }} data-testid="text-friday-week">Week ending {formatDayMonth(q.data.weekEnding)}</p>
              <h1 className="oo-h1" style={{ margin: 0 }}>Friday update</h1>
              <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '62ch' }}>
                Your leadership update for Slack, drafted from what OllieOS saw this week. Edit it, then copy it into Slack. OllieOS never posts it.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className={u ? 'oo-btn oo-btn-outline' : 'oo-btn oo-btn-ink'}
                  disabled={!!busy}
                  onClick={() => void run('draft', () => draftFridayUpdate(), u ? 'Drafted again' : 'Drafted')}
                  data-testid="button-friday-draft"
                >
                  {busy === 'draft' ? 'Drafting…' : u ? 'Draft it all again' : 'Draft this week’s update'}
                </button>
                {u && (
                  <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-friday-basis">
                    {basisLine(u)} Last drafted {formatDayMonth(u.updatedAt)}, {formatTime(u.updatedAt)}.
                  </span>
                )}
              </div>
            </header>

            {!u ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-friday-empty">
                Nothing drafted yet. On Fridays it is drafted for you after 09:00; you can draft it any time.
              </p>
            ) : (
              <>
                {SECTIONS.map((s) => (
                  <section key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'section-friday-' + s.key}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <h2 style={H2}>{s.title}</h2>
                      <button
                        type="button"
                        className="oo-btn oo-btn-quiet oo-btn-sm"
                        disabled={!!busy}
                        onClick={() => void run(s.key, () => redraftFridayUpdateSection({ section: s.key }), `${s.title.slice(3)} drafted again`)}
                        data-testid={'button-friday-redraft-' + s.key}
                      >
                        {busy === s.key ? 'Drafting…' : 'Draft again'}
                      </button>
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 15 }}>
                      {u.sections[s.key].map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </section>
                ))}

                <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h2 style={H2}>The post</h2>
                  {u.editedText && <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Your edits are kept. Drafting a section again replaces them with the new draft.</p>}
                  <label className="oo-sr" htmlFor="friday-post">The post</label>
                  <textarea id="friday-post" className="oo-textarea" rows={18} value={text} onChange={(e) => setText(e.target.value)} style={{ fontSize: 14 }} data-testid="input-friday-post" />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button type="button" className="oo-btn oo-btn-ink" onClick={() => void copy()} data-testid="button-friday-copy">Copy for Slack</button>
                    {edited && (
                      <button
                        type="button"
                        className="oo-btn oo-btn-outline"
                        disabled={!!busy}
                        onClick={() => void run('save', () => saveFridayUpdateText({ weekEnding: u.weekEnding, editedText: text }), 'Edits saved')}
                        data-testid="button-friday-save"
                      >
                        Save my edits
                      </button>
                    )}
                    {u.editedText && (
                      <button
                        type="button"
                        className="oo-btn oo-btn-quiet"
                        disabled={!!busy}
                        onClick={() => void run('reset', () => saveFridayUpdateText({ weekEnding: u.weekEnding, editedText: null }), 'Back to the draft')}
                        data-testid="button-friday-reset"
                      >
                        Go back to the draft
                      </button>
                    )}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </article>
    </div>
  );
}
