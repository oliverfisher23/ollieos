import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListAgentsQueryKey,
  getListReaderLessonsQueryKey,
  learnReaderLessons,
  setReaderLessonStatus,
  tryReaderLesson,
  useListReaderLessons,
  type ReaderLesson,
} from '@workspace/api-client-react';
import { formatShort } from '@workspace/shared';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const ABOUT: Record<ReaderLesson['about'], string> = { tasks: 'Inbox items', knowledge: 'Knowledge cards' };

/**
 * Section 24: lessons for the Gmail, Slack and Granola readers, learned from your corrections by the
 * reader coach and the card coach. A proposed lesson does nothing until you turn it on; Try runs the
 * reader's test cases with and without it first.
 */
export function ReaderLessons() {
  const q = useListReaderLessons({ query: { staleTime: 30_000 } });
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const lessons = q.data?.lessons ?? [];
  const proposed = lessons.filter((l) => l.status === 'proposed');
  const on = lessons.filter((l) => l.status === 'on');
  const off = lessons.filter((l) => l.status === 'off');

  const run = async (key: string, fn: () => Promise<unknown>, done?: (r: unknown) => string | null) => {
    setBusy(key);
    try {
      const r = await fn();
      await qc.invalidateQueries({ queryKey: getListReaderLessonsQueryKey() });
      await qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      const msg = done?.(r);
      if (msg) notify(msg);
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const learn = () =>
    run('learn', () => learnReaderLessons(), (r) => {
      const res = r as Awaited<ReturnType<typeof learnReaderLessons>>;
      const n = res.results.reduce((a, x) => a + x.proposed, 0);
      return res.failed ? 'Some coaches could not run. They try again after the next check.' : n ? `${n} new ${n === 1 ? 'lesson' : 'lessons'} to look at` : 'No new lessons. Nothing you corrected three or more times the same way.';
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-reader-lessons">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Lessons for the readers</h2>
        <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={!!busy} onClick={() => void learn()} data-testid="button-lessons-learn">
          {busy === 'learn' ? 'Learning…' : 'Learn from my corrections now'}
        </button>
      </div>
      <p className="oo-soft" style={{ margin: 0, fontSize: 13, maxWidth: '64ch', lineHeight: 1.5 }}>
        The reader coach and card coach look at what you corrected (items sent to Noise, dropped, renamed or reprioritised, and cards you rejected) and propose a lesson when you have made the same correction three or more times. Nothing changes until you turn a lesson on. Try runs the reader's test cases with and without it first.
      </p>
      {q.isLoading ? null : !q.data ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load the lessons.</p>
      ) : (
        <>
          {proposed.length === 0 && on.length === 0 && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-lessons-empty">
              No lessons yet. They are learned once a week{q.data.lastRun.tasks ? `, last on ${formatShort(q.data.lastRun.tasks)}` : ''}, and sooner while you work through the Knowledge Inbox.
            </p>
          )}
          {proposed.length > 0 && <h3 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600 }}>Waiting for you ({proposed.length})</h3>}
          {proposed.map((l) => (
            <LessonCard key={l.id} l={l} busy={busy} actions={[
              { key: 'on', label: 'Turn on', ink: true, fn: () => run(`on${l.id}`, () => setReaderLessonStatus(l.id, { status: 'on' }), () => `Turned on for the ${l.readerName}`) },
              { key: 'try', label: busy === `try${l.id}` ? 'Trying…' : 'Try against test cases', fn: () => run(`try${l.id}`, () => tryReaderLesson(l.id)) },
              { key: 'no', label: 'Not this one', fn: () => run(`no${l.id}`, () => setReaderLessonStatus(l.id, { status: 'rejected' }), () => 'Not proposed again') },
            ]} />
          ))}
          {on.length > 0 && <h3 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600 }}>On</h3>}
          {on.map((l) => (
            <LessonCard key={l.id} l={l} busy={busy} actions={[{ key: 'off', label: 'Turn off', fn: () => run(`off${l.id}`, () => setReaderLessonStatus(l.id, { status: 'off' }), () => 'Turned off') }]} />
          ))}
          {off.length > 0 && (
            <details>
              <summary className="oo-soft" style={{ fontSize: 13, cursor: 'pointer' }}>{off.length} turned off</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                {off.map((l) => (
                  <LessonCard key={l.id} l={l} busy={busy} actions={[{ key: 'on', label: 'Turn on again', fn: () => run(`on${l.id}`, () => setReaderLessonStatus(l.id, { status: 'on' }), () => 'Turned on') }]} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function LessonCard({ l, busy, actions }: { l: ReaderLesson; busy: string | null; actions: { key: string; label: string; ink?: boolean; fn: () => void }[] }) {
  const t = l.lastTry;
  return (
    <article className="oo-kcard" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'card-lesson-' + l.id}>
      <div className="oo-muted" style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <span className="oo-pill">{l.readerName}</span>
        <span className="oo-pill">{ABOUT[l.about]}</span>
        <span>{l.learnedByName}, {formatShort(l.createdAt)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 15 }}>{l.text}</p>
      <p className="oo-soft" style={{ margin: 0, fontSize: 13 }}>
        {l.why}. From {l.evidence} corrections{l.examples.length ? `, such as ${l.examples.join('; ')}` : ''}.
      </p>
      {t && (
        <p style={{ margin: 0, fontSize: 13 }} data-testid={'text-lesson-try-' + l.id}>
          Test cases: <strong className="oo-num">{t.passed} of {t.total}</strong> pass with it
          {t.without != null ? <>, against <span className="oo-num">{t.without}</span> without it{t.passed < t.without ? '. It makes things worse.' : t.passed > t.without ? '. It helps.' : '.'}</> : '.'}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {actions.map((a) => (
          <button key={a.key} type="button" className={a.ink ? 'oo-btn oo-btn-ink oo-btn-sm' : 'oo-btn oo-btn-outline oo-btn-sm'} disabled={!!busy} onClick={a.fn} data-testid={`button-lesson-${a.key}-${l.id}`}>
            {a.label}
          </button>
        ))}
      </div>
    </article>
  );
}
