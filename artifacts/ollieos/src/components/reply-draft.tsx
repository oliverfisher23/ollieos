import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  checkReplyDraft,
  type DraftIssue,
  getGetReplyDraftQueryKey,
  getGetTaskQueryKey,
  getListEmailDraftsQueryKey,
  briefReplyDraft,
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
 * "Draft reply" on an email task. AI writes the reply from the thread and what OllieOS knows,
 * steered by what Ollie says it should say; he can ask for changes, edit it, and save it as a draft
 * in the Gmail thread. OllieOS never sends email.
 */
export function ReplyDraftCard({ taskId, chase = false }: { taskId: number; /** A follow-up from Waiting for a reply: written straight away when there is none yet */ chase?: boolean }) {
  const autoWrite = chase;
  const qc = useQueryClient();
  // A briefed draft is written in the background: look again every few seconds until it is ready.
  const saved = useGetReplyDraft(taskId, {
    query: { queryKey: getGetReplyDraftQueryKey(taskId), refetchInterval: (q) => (q.state.data?.draft?.state === 'writing' ? 3_000 : false) },
  });
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [writing, setWriting] = useState<false | 'new' | 'change'>(false);
  /** Ollie's steer: what the reply should say, or what to change in it */
  const [ask, setAsk] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Part L: lines that break a rule, from Check */
  const [issues, setIssues] = useState<DraftIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    if (!fields?.body.trim()) return;
    setChecking(true);
    try {
      setIssues((await checkReplyDraft(taskId, { body: fields.body })).issues);
    } catch (err) {
      reportApiError(err);
      notify('Could not check it', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };
  const fixAll = () => {
    if (!fields || !issues) return;
    let body = fields.body;
    for (const i of issues) if (body.includes(i.line)) body = body.replace(i.line, i.fix);
    setFields({ ...fields, body });
    setIssues([]);
    notify('Fixed', 'Only the flagged lines changed. Check them before you save.');
  };

  // Start from the draft saved earlier, if there is one, and pick up a background draft once written.
  useEffect(() => {
    const d = saved.data?.draft;
    if (d && (!draft || (draft.state !== 'ready' && (d.state !== draft.state || d.updatedAt !== draft.updatedAt)))) {
      setDraft(d);
      setFields(fieldsOf(d));
      if (draft && draft.state === 'writing' && d.state !== 'writing') {
        qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
      }
    }
  }, [saved.data, draft, qc, taskId]);

  // Chase from Waiting for a reply: start writing as soon as it is clear there is no draft yet.
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!autoWrite || autoStarted || saved.isLoading || !saved.data || saved.data.draft) return;
    setAutoStarted(true);
    void write();
    // write only reads state set here, so running it once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoWrite, autoStarted, saved.isLoading, saved.data]);

  const dirty = !!draft && !!fields && !same(fields, fieldsOf(draft));
  const background = draft?.state === 'writing' ? 'writing' : draft?.state === 'failed' ? 'failed' : null;

  /** Try again on a briefed draft that could not be written */
  const retry = async () => {
    if (!draft?.brief) return;
    setError(null);
    try {
      const d = await briefReplyDraft(taskId, { brief: draft.brief });
      setDraft(d);
      qc.setQueryData(getGetReplyDraftQueryKey(taskId), { draft: d });
      qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
    } catch (err) {
      reportApiError(err);
      setError(errorMessage(err, 'The draft could not be started just now. Try again in a moment.'));
    }
  };

  const take = (d: ReplyDraft) => {
    setDraft(d);
    setFields(fieldsOf(d));
    qc.setQueryData(getGetReplyDraftQueryKey(taskId), { draft: d });
    qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
    qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
  };

  /** A fresh draft, or with `change`, the current one changed as Ollie asked. */
  const write = async (change = false) => {
    setConfirmRewrite(false);
    setWriting(change ? 'change' : 'new');
    setError(null);
    try {
      take(await writeReplyDraft(taskId, { instructions: ask.trim() || undefined, current: change && fields ? fields.body : undefined }));
      setAsk('');
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
            <span className="oo-muted" style={{ fontSize: 13 }}>
              {writing === 'change' ? 'Changing the draft…' : chase ? 'Reading the thread and writing a follow-up…' : 'Reading the thread and writing a reply…'}
            </span>
            <Skel h={14} w="90%" /><Skel h={14} w="80%" /><Skel h={14} w="55%" />
          </div>
        ) : background === 'writing' ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="state-reply-background">
            <span className="oo-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Writing from your brief{draft?.brief ? `: ${draft.brief}` : ''}. Once written it is saved to Gmail as a draft. You can leave this page.
            </span>
            <Skel h={14} w="90%" /><Skel h={14} w="80%" /><Skel h={14} w="55%" />
          </div>
        ) : !draft || !fields || background === 'failed' ? (
          <>
            {background === 'failed' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="state-reply-failed">
                <span style={{ fontSize: 13, lineHeight: 1.5 }} role="alert">
                  {draft?.error ?? 'The draft could not be written.'}{draft?.brief ? ` Your brief was: ${draft.brief}` : ''}
                </span>
                {draft?.brief && (
                  <div><button type="button" className="oo-btn oo-btn-ink" onClick={() => void retry()} data-testid="button-reply-retry">Try again</button></div>
                )}
              </div>
            )}
            <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Writes a {chase ? 'follow-up' : 'reply'} from the email thread, what OllieOS knows about the people and work involved, and your rules. You edit it and save it to Gmail. Nothing is sent.
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor={'rd-ask-' + taskId} className="oo-field-label">What should it say? Optional</label>
              <textarea id={'rd-ask-' + taskId} rows={2} className="oo-input" value={ask} onChange={(e) => setAsk(e.target.value)} maxLength={2000}
                placeholder={chase ? 'For example: keep it light, mention the Friday deadline' : 'For example: yes to Tuesday, ask for the budget first'}
                style={{ resize: 'vertical', borderRadius: 'var(--oo-r-input-lg)', padding: '10px 12px', lineHeight: 1.5 }} data-testid="input-reply-ask" />
            </div>
            <div><button type="button" className={background === 'failed' ? 'oo-btn oo-btn-outline' : 'oo-btn oo-btn-ink'} onClick={() => void write()} data-testid="button-draft-reply">{chase ? 'Draft chase email' : 'Draft reply'}</button></div>
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

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (ask.trim()) void write(true);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <label htmlFor={'rd-change-' + taskId} className="oo-field-label">Ask for changes</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input id={'rd-change-' + taskId} className="oo-input" style={{ flex: '1 1 220px', minWidth: 0 }} value={ask} onChange={(e) => setAsk(e.target.value)} maxLength={2000}
                  placeholder="For example: shorter, warmer, say no politely" data-testid="input-reply-change" />
                <button type="submit" className="oo-btn oo-btn-outline" disabled={!ask.trim() || saving} data-testid="button-reply-change">Change it</button>
              </div>
            </form>

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

            {issues && (
              <div className="oo-source" style={{ gap: 8 }} role="status" data-testid="card-draft-issues">
                {issues.length === 0 ? (
                  <span style={{ fontSize: 13 }}>No rule is broken.</span>
                ) : (
                  <>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{issues.length === 1 ? '1 line breaks a rule' : `${issues.length} lines break a rule`}</span>
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.5 }}>
                      {issues.map((i, n) => (
                        <li key={n}>
                          <span className="oo-muted">{i.ruleTitle}: </span>"{i.line}" <span className="oo-soft">becomes</span> "{i.fix}"
                        </li>
                      ))}
                    </ul>
                    <div><button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={fixAll} data-testid="button-fix-draft">Fix these</button></div>
                  </>
                )}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {draft.canSaveToGmail && (
                <button type="button" className="oo-btn oo-btn-ink" disabled={saving || !fields.body.trim() || (!!draft.savedAt && !dirty)} onClick={save} data-testid="button-save-gmail">
                  {saving ? 'Saving…' : draft.gmailUrl ? 'Update Gmail draft' : 'Save to Gmail'}
                </button>
              )}
              <button type="button" className="oo-btn oo-btn-outline" onClick={copy} data-testid="button-copy-reply">Copy</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={checking || !fields.body.trim()} onClick={() => void check()} data-testid="button-check-draft">{checking ? 'Checking…' : 'Check'}</button>
              {confirmRewrite ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  Replace your edits?
                  <button type="button" className="oo-btn oo-btn-outline" onClick={() => void write()} data-testid="button-rewrite-confirm">Write again</button>
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
