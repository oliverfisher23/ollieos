import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocation } from 'wouter';
import {
  createDecision,
  createNote,
  createOrganisation,
  createPerson,
  createProject,
  useListOrganisations,
  useListPeople,
  useListProjects,
} from '@workspace/api-client-react';
import { todayLondon } from '@workspace/shared';
import { useKnowledgeWrite } from '@/lib/knowledge';

export type CreateKind = 'project' | 'person' | 'organisation' | 'decision' | 'note';

const TITLES: Record<CreateKind, string> = {
  project: 'New project',
  person: 'New person',
  organisation: 'New organisation',
  decision: 'New decision',
  note: 'New note',
};

type Values = Record<string, string>;

export function CreateDialog({ kind, onClose, presetProjectId }: { kind: CreateKind; onClose: () => void; presetProjectId?: number }) {
  const [, navigate] = useLocation();
  const write = useKnowledgeWrite();
  const [v, setV] = useState<Values>({ decidedAt: todayLondon(), projectId: presetProjectId ? String(presetProjectId) : '' });
  const [confidential, setConfidential] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const val = (k: string) => (v[k] ?? '').trim() || null;

  const needsProjects = kind === 'decision' || kind === 'note';
  const projects = useListProjects(undefined, { query: { enabled: needsProjects } as never });
  const people = useListPeople({ query: { enabled: kind === 'note' } as never });
  const orgs = useListOrganisations({ query: { enabled: kind === 'person' || kind === 'note' } as never });

  const valid =
    kind === 'decision' ? !!val('text') && !!val('projectId') :
    kind === 'note' ? !!val('body') && !!val('attach') :
    !!val('name');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    let path: string | null = null;
    if (kind === 'project') {
      const p = await write(() => createProject({ name: val('name')!, area: val('area'), status: val('status'), summary: val('summary'), confidential }), { done: 'Project created', fail: 'Could not create that project' });
      if (p) path = '/knowledge/projects/' + p.slug;
    } else if (kind === 'person') {
      const p = await write(
        () => createPerson({ name: val('name')!, organisationId: val('organisationId') ? Number(val('organisationId')) : null, role: val('role'), email: val('email'), confidential }),
        { done: 'Person added', fail: 'Could not add that person' },
      );
      if (p) path = '/knowledge/people/' + p.slug;
    } else if (kind === 'organisation') {
      const o = await write(() => createOrganisation({ name: val('name')!, type: val('type'), confidential }), { done: 'Organisation added', fail: 'Could not add that organisation' });
      if (o) path = '/knowledge/organisations/' + o.slug;
    } else if (kind === 'decision') {
      const d = await write(
        () => createDecision({ projectId: Number(val('projectId')), text: val('text')!, decidedAt: val('decidedAt') ?? todayLondon(), decidedBy: val('decidedBy'), confidential: confidential || null }),
        { done: 'Decision recorded', fail: 'Could not record that decision' },
      );
      if (d) path = '/knowledge/decisions/' + d.id;
    } else {
      const [type, id] = (val('attach') ?? '').split(':');
      const n = await write(
        () => createNote({ entityType: type as 'project' | 'person' | 'organisation', entityId: Number(id), title: val('title'), body: val('body')!, confidential: confidential || null }),
        { done: 'Note saved', fail: 'Could not save that note' },
      );
      if (n) path = '/knowledge/notes/' + n.id;
    }
    setBusy(false);
    if (path) {
      onClose();
      navigate(path);
    }
  };

  const field = (k: string, label: string, opts: { required?: boolean; placeholder?: string; type?: string } = {}) => (
    <label>
      <span>{label}{opts.required ? '' : <span className="oo-muted"> (optional)</span>}</span>
      <input className="oo-input" type={opts.type ?? 'text'} value={v[k] ?? ''} onChange={set(k)} placeholder={opts.placeholder} required={opts.required} data-testid={`input-new-${kind}-${k}`} />
    </label>
  );

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" aria-describedby={undefined} data-testid={'dialog-new-' + kind}>
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{TITLES[kind]}</Dialog.Title>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {kind === 'project' && (
                <>
                  {field('name', 'Name', { required: true, placeholder: 'RAF Micro Internship' })}
                  {field('area', 'Area', { placeholder: 'Defence' })}
                  {field('status', 'Status', { placeholder: 'Proposal sent' })}
                  <label>
                    <span>Summary <span className="oo-muted">(optional)</span></span>
                    <textarea className="oo-textarea" rows={3} value={v.summary ?? ''} onChange={set('summary')} data-testid="input-new-project-summary" />
                  </label>
                </>
              )}
              {kind === 'person' && (
                <>
                  {field('name', 'Name', { required: true })}
                  <label>
                    <span>Organisation <span className="oo-muted">(optional)</span></span>
                    <select className="oo-input" value={v.organisationId ?? ''} onChange={set('organisationId')} data-testid="select-new-person-organisation">
                      <option value="">None</option>
                      {(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                  {field('role', 'Role')}
                  {field('email', 'Email', { type: 'email' })}
                </>
              )}
              {kind === 'organisation' && (
                <>
                  {field('name', 'Name', { required: true })}
                  {field('type', 'Type', { placeholder: 'Client, partner, supplier…' })}
                </>
              )}
              {kind === 'decision' && (
                <>
                  <label>
                    <span>Project</span>
                    <select className="oo-input" value={v.projectId ?? ''} onChange={set('projectId')} required data-testid="select-new-decision-project">
                      <option value="">Choose a project…</option>
                      {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>What was decided</span>
                    <textarea className="oo-textarea" rows={3} value={v.text ?? ''} onChange={set('text')} required data-testid="input-new-decision-text" />
                  </label>
                  {field('decidedAt', 'Decided on', { type: 'date', required: true })}
                  {field('decidedBy', 'Decided by', { placeholder: 'Ollie and Paul' })}
                </>
              )}
              {kind === 'note' && (
                <>
                  <label>
                    <span>About</span>
                    <select className="oo-input" value={v.attach ?? ''} onChange={set('attach')} required data-testid="select-new-note-attach">
                      <option value="">Choose what this note is about…</option>
                      <optgroup label="Projects">{(projects.data ?? []).map((p) => <option key={'p' + p.id} value={'project:' + p.id}>{p.name}</option>)}</optgroup>
                      <optgroup label="People">{(people.data ?? []).map((p) => <option key={'u' + p.id} value={'person:' + p.id}>{p.name}</option>)}</optgroup>
                      <optgroup label="Organisations">{(orgs.data ?? []).map((o) => <option key={'o' + o.id} value={'organisation:' + o.id}>{o.name}</option>)}</optgroup>
                    </select>
                  </label>
                  {field('title', 'Title')}
                  <label>
                    <span>Note</span>
                    <textarea className="oo-textarea" rows={5} value={v.body ?? ''} onChange={set('body')} required data-testid="input-new-note-body" />
                  </label>
                </>
              )}
              <label style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>
                  Confidential
                  <span className="oo-muted" style={{ display: 'block', fontSize: 12 }}>
                    {kind === 'decision' || kind === 'note' ? 'Otherwise it follows what it belongs to.' : 'Hidden from AI unless you approve a request.'}
                  </span>
                </span>
                <button type="button" role="switch" className="oo-switch" data-tone="danger" aria-checked={confidential} aria-label="Confidential" onClick={() => setConfidential((c) => !c)} data-testid={`switch-new-${kind}-confidential`} />
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid={`button-cancel-new-${kind}`}>Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!valid || busy} data-testid={`button-create-${kind}`}>
                  {busy ? 'Saving…' : kind === 'decision' ? 'Record decision' : kind === 'note' ? 'Save note' : 'Create'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
