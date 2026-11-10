import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetReplyDraftQueryKey,
  getGetTaskQueryKey,
  getListEmailDraftsQueryKey,
  saveReplyDraftToGmail,
  useGetReplyDraft,
  writeReplyDraft,
  type ReplyDraft,
} from '@workspace/api-client-react';
import { formatShort, formatTime } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { copyText } from '@/lib/knowledge';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

interface Fields {
  to: string;
  cc: string;
  subject: string;
  body: string;
}

const fieldsOf = (d: ReplyDraft): Fields => ({ to: d.to, cc: d.cc, subject: d.subject, body: d.body });
const same = (a: Fields, b: Fields) => a.to === b.to && a.cc === b.cc && a.subject === b.subject && a.body === b.body;

/**
 * "Draft reply" on an email task. AI writes the reply from the thread and what OllieOS knows;
 * Ollie edits it and saves it as a draft in the Gmail thread. OllieOS never sends email.
 */
export function ReplyDraftCard({ taskId, chase = false }: { taskId: number; /** A follow-up from No reply yet: written straight away when there is none yet */ chase?: boolean }) {
  const autoWrite = chase;
  const qc = useQueryClient();
  const saved = useGetReplyDraft(taskId);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [writing, setWriting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from the draft saved earlier, if there is one.
  useEffect(() => {
    const d = saved.data?.draft;
    if (d && !draft) {
      setDraft(d);
      setFields(fieldsOf(d));
    }
  }, [saved.data, draft]);

  // Chase from No reply yet: start writing as soon as it is clear there is no draft yet.
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!autoWrite || autoStarted || saved.isLoading || !saved.data || saved.data.draft) return;
    setAutoStarted(true);
    void write();
    // write only reads state set here, so running it once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoWrite, autoStarted, saved.isLoading, saved.data]);

  const dirty = !!draft && !!fields && !same(fields, fieldsOf(draft));

  const take = (d: ReplyDraft) => {
    setDraft(d);
    setFields(fieldsOf(d));
    qc.setQueryData(getGetReplyDraftQueryKey(taskId), { draft: d });
    qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
    qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
  };

  const write = async () => {
    setConfirmRewrite(false);
    setWriting(true);
    setError(null);
    try {
      take(await writeReplyDraft(taskId));
    } catch (err) {
      reportApiError(err);
      setError(errorMessage(err, 'The reply could not be written just now. Try again in a moment.'));
    } finally {
      setWriting(false);
    }
  };

  const save = async () => {
    if (!fields) return;
    setSaving(true);
    try {
      take(await saveReplyDraftToGmail(taskId, fields));
      notify('Saved to Gmail', 'The draft is in the email thread. Nothing was sent.');
    } catch (err) {
      reportApiError(err);
      notify('Could not save to Gmail', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!fields) return;
    if (await copyText(fields.body)) notify('Reply copied', 'Paste it into your email.');
    else notify('Could not copy', 'Your browser blocked the clipboard.');
  };

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setFields((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="card-reply-draft">
      <span className="oo-field-label">{chase ? 'Chase email' : 'Reply'}</span>
      <div className="oo-source" style={{ gap: 12 }}>
        {saved.isLoading ? (
          <Skel h={36} w={140} />
        ) : writing ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="state-reply-writing">
            <span className="oo-muted" style={{ fontSize: 13 }}>{chase ? 'Reading the thread and writing a follow-up…' : 'Reading the thread and writing a reply…'}</span>
            <Skel h={14} w="90%" /><Skel h={14} w="80%" /><Skel h={14} w="55%" />
          </div>
        ) : !draft || !fields ? (
          <>
            <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Writes a {chase ? 'follow-up' : 'reply'} from the email thread, what OllieOS knows about the people and work involved, and your playbooks. You edit it and save it to Gmail. Nothing is sent.
            </span>
            <div><button type="button" className="oo-btn oo-btn-ink" onClick={write} data-testid="button-draft-reply">{chase ? 'Draft chase email' : 'Draft reply'}</button></div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="rd-to" className="oo-field-label">To</label>
              <input id="rd-to" className="oo-input" value={fields.to} onChange={set('to')} data-testid="input-reply-to" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="rd-cc" className="oo-field-label">Cc</label>
              <input id="rd-cc" className="oo-input" value={fields.cc} onChange={set('cc')} data-testid="input-reply-cc" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="rd-subject" className="oo-field-label">Subject</label>
              <input id="rd-subject" className="oo-input" value={fields.subject} onChange={set('subject')} data-testid="input-reply-subject" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="rd-body" className="oo-field-label">Message</label>
              <textarea id="rd-body" rows={10} className="oo-input" value={fields.body} onChange={set('body')}
                style={{ resize: 'vertical', borderRadius: 'var(--oo-r-input-lg)', padding: '10px 12px', lineHeight: 1.55 }} data-testid="input-reply-body" />
            </div>

            <p className="oo-muted" style={{ margin: 0, fontSize: 12 }} role="status" data-testid="text-reply-status">
              {!draft.canSaveToGmail
                ? 'OllieOS cannot find this email in Gmail, so copy the reply instead.'
                : dirty && draft.savedAt
                  ? 'Edited since it was saved to Gmail.'
                  : draft.savedAt
                    ? `Saved to Gmail on ${formatShort(draft.savedAt)} at ${formatTime(draft.savedAt)}. Nothing was sent.`
                    : 'Not in Gmail yet. Saving makes a draft in the thread; it is never sent.'}
              {draft.gmailUrl && !dirty && (
                <> <a className="oo-link" href={draft.gmailUrl} target="_blank" rel="noreferrer" data-testid="link-reply-gmail">Open in Gmail</a></>
              )}
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {draft.canSaveToGmail && (
                <button type="button" className="oo-btn oo-btn-ink" disabled={saving || !fields.body.trim() || (!!draft.savedAt && !dirty)} onClick={save} data-testid="button-save-gmail">
                  {saving ? 'Saving…' : draft.gmailUrl ? 'Update Gmail draft' : 'Save to Gmail'}
                </button>
              )}
              <button type="button" className="oo-btn oo-btn-outline" onClick={copy} data-testid="button-copy-reply">Copy</button>
              {confirmRewrite ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  Replace your edits?
                  <button type="button" className="oo-btn oo-btn-outline" onClick={write} data-testid="button-rewrite-confirm">Write again</button>
                  <button type="button" className="oo-btn oo-btn-outline" onClick={() => setConfirmRewrite(false)} data-testid="button-rewrite-cancel">Keep editing</button>
                </span>
              ) : (
                <button type="button" className="oo-btn oo-btn-outline" disabled={saving}
                  onClick={() => (dirty ? setConfirmRewrite(true) : void write())} data-testid="button-rewrite-reply">Write again</button>
              )}
            </div>
          </>
        )}
        {error && !writing && (
          <p role="alert" style={{ margin: 0, fontSize: 13 }} data-testid="text-reply-error">{error}</p>
        )}
      </div>
    </div>
  );
}
