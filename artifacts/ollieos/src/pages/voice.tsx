import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  parseVoice,
  saveVoice,
  useListOrganisations,
  useListPeople,
  useListProjects,
  type VoiceItem,
  type VoiceSaveResult,
} from '@workspace/api-client-react';
import { formatShort } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { orgOptions, personOptions, projectOptions } from '@/components/dropdown-options';
import { IconLeft, IconMic } from '@/components/icons';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

/** Feature 09 rule 1: two minutes at most. */
const MAX_SECONDS = 120;

type Stage = 'idle' | 'recording' | 'reading' | 'review' | 'saving' | 'saved';

/* The browser's speech recognition (Chrome, Edge, Safari). Typed loosely: it is not in the DOM types everywhere. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
function recognitionClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const KIND_LABEL: Record<VoiceItem['kind'], string> = { task: 'Task', promise: 'Promise', fact: 'Fact' };
const KIND_TONE: Record<VoiceItem['kind'], string> = { task: 'inbox', promise: 'waiting', fact: 'backlog' };

/**
 * Voice capture (feature 09): speak, check what OllieOS found, save. Speech becomes text in the
 * browser; no audio is uploaded or kept. Without a microphone or speech recognition it offers a
 * text box. Nothing is saved until Save all: tasks go to the Inbox, facts to the Knowledge Inbox.
 */
export default function VoicePage() {
  const [, navigate] = useLocation();
  const invalidate = useInvalidateTasks();
  const Rec = typeof window === 'undefined' ? null : recognitionClass();
  const [typing, setTyping] = useState(!Rec);
  const [stage, setStage] = useState<Stage>('idle');
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [items, setItems] = useState<VoiceItem[]>([]);
  const [usedAi, setUsedAi] = useState(true);
  const [saved, setSaved] = useState<VoiceSaveResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const textRef = useRef('');

  const transcript = (typing ? typed : finalText).trim();

  // The timer, and the two-minute stop.
  useEffect(() => {
    if (stage !== 'recording') return undefined;
    const started = Date.now();
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) rec.current?.stop();
    }, 250);
    return () => clearInterval(id);
  }, [stage]);
  useEffect(() => () => rec.current?.abort(), []);

  const read = async (text: string) => {
    if (!text.trim()) {
      setStage('idle');
      setProblem('Nothing was heard. Try again, or type it.');
      return;
    }
    setStage('reading');
    try {
      const r = await parseVoice({ transcript: text.trim() });
      setItems(r.items);
      setUsedAi(r.usedAi);
      setStage('review');
    } catch (err) {
      reportApiError(err);
      setStage('idle');
      setProblem(errorMessage(err));
    }
  };

  const start = () => {
    if (!Rec) return setTyping(true);
    setProblem(null);
    setFinalText('');
    setInterim('');
    textRef.current = '';
    setSeconds(0);
    const r = new Rec();
    r.lang = 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) textRef.current = (textRef.current + ' ' + res[0].transcript).trim();
        else live += res[0].transcript;
      }
      setFinalText(textRef.current);
      setInterim(live);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        setTyping(true);
        setProblem('OllieOS cannot use the microphone here, so type it instead.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') setProblem('Speech recognition stopped: ' + e.error);
    };
    r.onend = () => {
      rec.current = null;
      setInterim('');
      void read(textRef.current);
    };
    rec.current = r;
    r.start();
    setStage('recording');
  };

  const stop = () => rec.current?.stop();

  const discard = () => {
    rec.current?.abort();
    setItems([]);
    setFinalText('');
    setTyped('');
    setStage('idle');
    notify('Discarded', 'Nothing was saved.');
  };

  const save = async () => {
    setStage('saving');
    try {
      const r = await saveVoice({ transcript, items });
      setSaved(r);
      setStage('saved');
      await invalidate();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
      setStage('review');
    }
  };

  const update = (i: number, patch: Partial<VoiceItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const remove = (i: number) => setItems((xs) => xs.filter((_, j) => j !== i));
  const factsMissing = items.some((i) => i.kind === 'fact' && !i.about);

  return (
    <div className="oo-fade-in oo-voice" data-testid="page-voice">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button type="button" className="oo-tri-back" onClick={() => navigate('/')} data-testid="button-voice-back"><IconLeft size={18} />Home</button>
        {stage === 'recording' && <span className="oo-num" style={{ fontSize: 14 }} data-testid="text-voice-timer">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} / 2:00</span>}
      </div>

      {(stage === 'idle' || stage === 'recording' || stage === 'reading') && (
        <section className="oo-voice-main" aria-live="polite">
          <h1 className="oo-serif" style={{ margin: 0, fontSize: 30, fontWeight: 400, textAlign: 'center' }}>
            {stage === 'reading' ? 'Reading what you said…' : 'Say a task, a note, or what just happened.'}
          </h1>
          {problem && <p style={{ margin: 0, fontSize: 14, textAlign: 'center' }} data-testid="text-voice-problem">{problem}</p>}

          {typing ? (
            <form
              style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}
              onSubmit={(e) => {
                e.preventDefault();
                void read(typed);
              }}
            >
              <label htmlFor="voice-text" className="oo-sr">What happened</label>
              <textarea id="voice-text" className="oo-voice-text" rows={5} maxLength={4000} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Chase Sam on the contract on Wednesday. Sam said they renew in March." data-testid="input-voice-text" />
              <button type="submit" className="oo-btn oo-btn-white" disabled={!typed.trim() || stage === 'reading'} data-testid="button-voice-read">Read it</button>
              {Rec && <button type="button" className="oo-btn oo-btn-ghost" onClick={() => setTyping(false)}>Speak instead</button>}
            </form>
          ) : (
            <>
              <p className="oo-voice-live" data-testid="text-voice-transcript">
                {finalText} <span style={{ opacity: 0.6 }}>{interim}</span>
              </p>
              {stage === 'recording' && (
                <span className="oo-voice-wave" aria-hidden="true">
                  {Array.from({ length: 9 }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 5) * 0.12}s` }} />)}
                </span>
              )}
              <button
                type="button"
                className="oo-voice-mic"
                data-recording={stage === 'recording' ? 'true' : undefined}
                aria-label={stage === 'recording' ? 'Stop recording' : 'Start recording'}
                disabled={stage === 'reading'}
                onClick={stage === 'recording' ? stop : start}
                data-testid="button-voice-mic"
              >
                {stage === 'recording' ? <span className="oo-voice-stop" /> : <IconMic size={34} />}
              </button>
              {stage === 'idle' && <button type="button" className="oo-btn oo-btn-ghost" onClick={() => setTyping(true)} data-testid="button-voice-type">Type instead</button>}
            </>
          )}
          <p style={{ margin: 0, fontSize: 12, color: 'var(--oo-text-on-dark-3)', textAlign: 'center' }}>Your browser turns speech into text. No audio is uploaded or kept.</p>
        </section>
      )}

      {(stage === 'review' || stage === 'saving') && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="What OllieOS found">
          <p style={{ margin: 0, fontSize: 14, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-voice-said">“{transcript}”</p>
          {!usedAi && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-voice-no-ai">
              You named something hidden from AI, so OllieOS split this without AI, one task per sentence. Check each card.
            </p>
          )}
          {items.length === 0 && <p style={{ margin: 0, fontSize: 15 }}>OllieOS found nothing to save. Try again, or discard.</p>}
          {items.map((it, i) => <VoiceCard key={i} item={it} onChange={(p) => update(i, p)} onRemove={() => remove(i)} index={i} />)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 }}>
            <button type="button" className="oo-btn oo-btn-ghost" onClick={discard} disabled={stage === 'saving'} data-testid="button-voice-discard">Discard</button>
            <button type="button" className="oo-btn oo-btn-white" onClick={() => void save()} disabled={stage === 'saving' || !items.length || factsMissing} data-testid="button-voice-save">
              {stage === 'saving' ? 'Saving…' : items.length === 2 ? 'Save both' : 'Save all'}
            </button>
          </div>
          {factsMissing && <p style={{ margin: 0, fontSize: 13, color: 'var(--oo-text-on-dark-2)' }}>Choose what each fact is about, or remove it.</p>}
        </section>
      )}

      {stage === 'saved' && saved && (
        <section className="oo-voice-main" data-testid="state-voice-saved">
          <h1 className="oo-serif" style={{ margin: 0, fontSize: 34, fontWeight: 400 }}>Saved.</h1>
          <p style={{ margin: 0, fontSize: 15, textAlign: 'center' }} data-testid="text-voice-saved">
            {[
              saved.tasks.length ? `${saved.tasks.length} ${saved.tasks.length === 1 ? 'item' : 'items'} to your Inbox` : null,
              saved.facts.length ? `${saved.facts.length} ${saved.facts.length === 1 ? 'fact' : 'facts'} to the Knowledge Inbox for approval` : null,
            ].filter(Boolean).join(', ')}
            .
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {saved.tasks.length > 0 && <Link href="/tasks?tab=inbox" className="oo-btn oo-btn-white">Open Inbox</Link>}
            {saved.facts.length > 0 && <Link href="/knowledge/inbox" className="oo-btn oo-btn-ghost">Knowledge Inbox</Link>}
            <button type="button" className="oo-btn oo-btn-ghost" onClick={() => { setSaved(null); setItems([]); setFinalText(''); setTyped(''); setStage('idle'); }} data-testid="button-voice-again">Say something else</button>
          </div>
        </section>
      )}
    </div>
  );
}

function VoiceCard({ item, index, onChange, onRemove }: { item: VoiceItem; index: number; onChange: (p: Partial<VoiceItem>) => void; onRemove: () => void }) {
  const projects = useListProjects();
  const people = useListPeople();
  const orgs = useListOrganisations();
  const aboutOptions = [
    ...projectOptions(projects.data).map((o) => ({ ...o, value: 'project:' + o.value, label: o.label + ' (project)' })),
    ...personOptions(people.data).map((o) => ({ ...o, value: 'person:' + o.value })),
    ...orgOptions(orgs.data).map((o) => ({ ...o, value: 'organisation:' + o.value, label: o.label + ' (organisation)' })),
  ];
  const nameOf = (v: string) => aboutOptions.find((o) => o.value === v)?.label.replace(/ \((project|organisation)\)$/, '') ?? '';
  return (
    <article className="oo-voice-card" data-testid={'card-voice-' + index}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Dropdown
          value={item.kind}
          onChange={(v) => onChange({ kind: v as VoiceItem['kind'], ...(v === 'fact' ? { dueDate: null } : { about: null }) })}
          options={[{ value: 'task', label: 'Task' }, { value: 'promise', label: 'Promise' }, { value: 'fact', label: 'Fact' }]}
          ariaLabel="Kind"
          variant="compact"
          testId={'select-voice-kind-' + index}
        />
        <span className="oo-pill" data-tone={KIND_TONE[item.kind]}>{item.kind === 'fact' ? 'Knowledge Inbox' : 'Inbox'}</span>
        <button type="button" className="oo-btn oo-btn-quiet" onClick={onRemove} aria-label="Remove this item" data-testid={'button-voice-remove-' + index}>Remove</button>
      </div>
      <label className="oo-sr" htmlFor={'voice-item-' + index}>{KIND_LABEL[item.kind]}</label>
      <textarea id={'voice-item-' + index} className="oo-voice-item-text" rows={2} maxLength={300} value={item.text} onChange={(e) => onChange({ text: e.target.value })} data-testid={'input-voice-item-' + index} />
      {item.kind === 'fact' ? (
        <Dropdown
          value={item.about ? `${item.about.type}:${item.about.id}` : ''}
          onChange={(v) => {
            if (!v) return onChange({ about: null });
            const [type, id] = v.split(':');
            onChange({ about: { type: type as 'project' | 'person' | 'organisation', id: Number(id), name: nameOf(v) } });
          }}
          options={aboutOptions}
          placeholder="What is it about?"
          searchable
          ariaLabel="What the fact is about"
          testId={'select-voice-about-' + index}
        />
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <span className="oo-muted">Due</span>
            <input type="date" className="oo-input" value={item.dueDate ?? ''} onChange={(e) => onChange({ dueDate: e.target.value || null })} style={{ minHeight: 36 }} data-testid={'input-voice-due-' + index} />
          </label>
          {item.dueDate && <span className="oo-muted" style={{ fontSize: 12 }}>{formatShort(item.dueDate)}</span>}
          <Dropdown value={item.projectId ? String(item.projectId) : ''} onChange={(v) => onChange({ projectId: v ? Number(v) : null })} options={[{ value: '', label: 'No project' }, ...projectOptions(projects.data)]} ariaLabel="Project" variant="compact" searchable testId={'select-voice-project-' + index} />
          <Dropdown value={item.personId ? String(item.personId) : ''} onChange={(v) => onChange({ personId: v ? Number(v) : null })} options={[{ value: '', label: 'No one' }, ...personOptions(people.data)]} ariaLabel="Person" variant="compact" searchable testId={'select-voice-person-' + index} />
        </div>
      )}
    </article>
  );
}

