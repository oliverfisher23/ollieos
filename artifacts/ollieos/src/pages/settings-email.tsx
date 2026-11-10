import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetWritingStyleQueryKey, readWritingStyle, saveWritingStyle, useGetWritingStyle } from '@workspace/api-client-react';
import { formatLong } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const NOTE_CHARS = 4000;

/** "How you write": the note every drafted email follows, read from Ollie's sent email. */
export default function EmailSettings() {
  const qc = useQueryClient();
  const style = useGetWritingStyle({
    query: { queryKey: getGetWritingStyleQueryKey(), refetchInterval: (q) => (q.state.data?.status === 'reading' ? 3_000 : false) },
  });
  const s = style.data;
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  // Fill the box from the saved note, and again once a read finishes.
  const savedNote = s?.note ?? '';
  const stamp = s ? `${s.readAt ?? ''}|${s.editedAt ?? ''}` : null;
  useEffect(() => {
    if (stamp !== null) setNote(savedNote);
  }, [stamp, savedNote]);

  const dirty = note !== null && note !== savedNote;
  const reading = s?.status === 'reading';

  const save = async () => {
    if (note === null) return;
    setSaving(true);
    try {
      const res = await saveWritingStyle({ note });
      qc.setQueryData(getGetWritingStyleQueryKey(), res);
      notify('Saved', 'New drafts follow this note.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const readAgain = async () => {
    setStarting(true);
    try {
      const res = await readWritingStyle();
      qc.setQueryData(getGetWritingStyleQueryKey(), res);
      notify('Reading your sent email', 'This takes a minute or two. The note here is replaced once it is done.');
    } catch (err) {
      reportApiError(err);
      notify('Could not start reading', errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="oo-panel flex flex-col gap-4 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="em-h" data-testid="page-settings-email">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 id="em-h" style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>Email</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          How you write: a note OllieOS follows in every reply and chase it drafts, so they sound like you. It is made by reading up to 200 emails you sent in the last 6 months, and costs under 50p each time. Edit it as you like.
        </p>
      </div>

      {style.isLoading ? (
        <Skel h={180} />
      ) : !s ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-style-error">
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load the note.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => style.refetch()} data-testid="button-retry-style">Try again</button>
        </div>
      ) : (
        <>
          <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} role="status" data-testid="text-style-status">
            {reading
              ? 'Reading your sent email now. This takes a minute or two.'
              : s.status === 'failed'
                ? `The last read did not finish. ${s.error ?? ''}`.trim()
                : s.readAt
                  ? `Made from ${s.emails} sent emails on ${formatLong(s.readAt)}.${s.editedAt ? ` You edited it on ${formatLong(s.editedAt)}.` : ''}`
                  : s.editedAt
                    ? `Written by you on ${formatLong(s.editedAt)}.`
                    : 'No note yet. Read your sent email to make one, or write your own.'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="style-note" className="oo-field-label">How you write</label>
            <textarea
              id="style-note"
              className="oo-input"
              rows={12}
              maxLength={NOTE_CHARS}
              value={note ?? ''}
              disabled={reading}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example: short and direct, first names, no pleasantries, signs off with just a name."
              style={{ resize: 'vertical', borderRadius: 'var(--oo-r-input-lg)', padding: '10px 12px', lineHeight: 1.55 }}
              data-testid="input-style-note"
            />
            <span className="oo-muted oo-num" style={{ fontSize: 12, alignSelf: 'flex-end' }}>{(note ?? '').length} of {NOTE_CHARS}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="oo-btn oo-btn-ink" disabled={!dirty || saving || reading} onClick={() => void save()} data-testid="button-style-save">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="oo-btn oo-btn-outline" disabled={reading || starting} onClick={() => void readAgain()} data-testid="button-style-read">
              {reading ? 'Reading…' : s.readAt ? 'Read again' : 'Read my sent email'}
            </button>
          </div>
          {dirty && !reading && <span className="oo-muted" style={{ fontSize: 12 }}>Read again replaces the note, including your edits.</span>}
        </>
      )}
    </section>
  );
}
