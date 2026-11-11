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
import { todayLondon, type BusinessFunction } from '@workspace/shared';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { InternalSwitch } from './org-options';
import { Dropdown } from '@/components/dropdown';
import { FUNCTION_OPTIONS, orgOptions, personOptions, projectOptions } from '@/components/dropdown-options';

export type CreateKind = 'project' | 'person' | 'organisation' | 'decision' | 'note';

const TITLES: Record<CreateKind, string> = {
  project: 'New project',
  person: 'New person',
  organisation: 'New organisation',
  decision: 'New decision',
  note: 'New note',
};

type Values = Record<string, string>;

/**
 * `stay` keeps Ollie on the page he is on after creating (adding a colleague from an organisation's
 * page), instead of opening the new item.
 */
export function CreateDialog({
  kind,
  onClose,
  presetProjectId,
  presetOrganisationId,
  presetInternal,
  stay,
}: {
  kind: CreateKind;
  onClose: () => void;
  presetProjectId?: number;
  presetOrganisationId?: number;
  presetInternal?: boolean;
  stay?: boolean;
}) {
  const [, navigate] = useLocation();
  const write = useKnowledgeWrite();
  const [v, setV] = useState<Values>({
    decidedAt: todayLondon(),
    projectId: presetProjectId ? String(presetProjectId) : '',
    organisationId: presetOrganisationId ? String(presetOrganisationId) : '',
  });
  const [internal, setInternal] = useState(!!presetInternal);
  const [confidential, setConfidential] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const pick = (k: string) => (value: string) => setV((cur) => ({ ...cur, [k]: value }));
  const val = (k: string) => (v[k] ?? '').trim() || null;

  const needsProjects = kind === 'decision' || kind === 'note';
  const projects = useListProjects(undefined, { query: { enabled: needsProjects } as never });
  const people = useListPeople({ query: { enabled: kind === 'note' } as never });
  const orgs = useListOrganisations({ query: { enabled: kind === 'person' || kind === 'note' } as never });

  const valid =
    kind === 'decision' ? !!val('text') :
    kind === 'note' ? !!val('body') && !!val('attach') :
    !!val('name');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    let path: string | null = null;
    if (kind === 'project') {
      const p = await write(() => createProject({ name: val('name')!, area: val('area'), status: val('status'), summary: val('summary'), function: (val('function') ?? null) as BusinessFunction | null, confidential }), { done: 'Project created', fail: 'Could not create that project' });
      if (p) path = '/knowledge/projects/' + p.slug;
    } else if (kind === 'person') {
      const p = await write(
        () => createPerson({ name: val('name')!, organisationId: val('organisationId') ? Number(val('organisationId')) : null, role: val('role'), email: val('email'), confidential }),
        { done: 'Person added', fail: 'Could not add that person' },
      );
      if (p) path = '/knowledge/people/' + p.slug;
    } else if (kind === 'organisation') {
      const o = await write(() => createOrganisation({ name: val('name')!, type: val('type'), internal, confidential }), { done: 'Organisation added', fail: 'Could not add that organisation' });
      if (o) path = '/knowledge/organisations/' + o.slug;
    } else if (kind === 'decision') {
      const d = await write(
        () => createDecision({ projectId: val('projectId') ? Number(val('projectId')) : null, text: val('text')!, decidedAt: val('decidedAt') ?? todayLondon(), decidedBy: val('decidedBy'), confidential: confidential || null }),
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
      if (!stay) navigate(path);
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
                  {field('name', 'Name', { required: true, placeholder: 'What you call this project' })}
                  <div className="oo-dd-field">
                    <label htmlFor="new-project-function">Function <span className="oo-muted">(optional)</span></label>
                    <Dropdown id="new-project-function" value={v.function ?? ''} onChange={pick('function')} testId="select-new-project-function" options={FUNCTION_OPTIONS} />
                  </div>
                  {field('area', 'Area', { placeholder: 'Sector or team' })}
                  {field('status', 'Status', { placeholder: 'Where it stands' })}
                  <label>
                    <span>Summary <span className="oo-muted">(optional)</span></span>
                    <textarea className="oo-textarea" rows={3} value={v.summary ?? ''} onChange={set('summary')} data-testid="input-new-project-summary" />
                  </label>
                </>
              )}
              {kind === 'person' && (
                <>
                  {field('name', 'Name', { required: true })}
                  <div className="oo-dd-field">
                    <label htmlFor="new-person-org">Organisation <span className="oo-muted">(optional)</span></label>
                    <Dropdown id="new-person-org" value={v.organisationId ?? ''} onChange={pick('organisationId')} testId="select-new-person-organisation" searchPlaceholder="Search organisations"
                      options={[{ value: '', label: 'None' }, ...orgOptions(orgs.data)]} />
                  </div>
                  {field('role', 'Role')}
                  {field('email', 'Email', { type: 'email' })}
                </>
              )}
              {kind === 'organisation' && (
                <>
                  {field('name', 'Name', { required: true })}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span>External or internal</span>
                    <InternalSwitch value={internal} onChange={setInternal} testId="seg-new-organisation-internal" />
                    <span className="oo-muted" style={{ fontSize: 13 }}>
                      {internal ? 'Your own company. People here are your colleagues.' : 'A client, partner or supplier.'}
                    </span>
                  </div>
                  {field('type', 'Type', { placeholder: internal ? 'Your company' : 'Client, partner, supplier…' })}
                </>
              )}
              {kind === 'decision' && (
                <>
                  <div className="oo-dd-field">
                    <label htmlFor="new-decision-project">Project (optional)</label>
                    <Dropdown id="new-decision-project" value={v.projectId ?? ''} onChange={pick('projectId')} placeholder="No project" testId="select-new-decision-project" searchPlaceholder="Search projects"
                      options={[{ value: '', label: 'No project' }, ...projectOptions(projects.data)]} />
                  </div>
                  <label>
                    <span>What was decided</span>
                    <textarea className="oo-textarea" rows={3} value={v.text ?? ''} onChange={set('text')} required data-testid="input-new-decision-text" />
                  </label>
                  {field('decidedAt', 'Decided on', { type: 'date', required: true })}
                  {field('decidedBy', 'Decided by', { placeholder: 'Who made the call' })}
                </>
              )}
              {kind === 'note' && (
                <>
                  <div className="oo-dd-field">
                    <label htmlFor="new-note-attach">About</label>
                    <Dropdown id="new-note-attach" value={v.attach ?? ''} onChange={pick('attach')} placeholder="Choose what this note is about…" testId="select-new-note-attach" searchPlaceholder="Search projects, people and organisations"
                      options={[
                        ...projectOptions(projects.data).map((o) => ({ ...o, value: 'project:' + o.value, group: 'Projects' })),
                        ...personOptions(people.data).map((o) => ({ ...o, value: 'person:' + o.value, group: 'People' })),
                        ...(orgs.data ?? []).map((o) => ({ value: 'organisation:' + o.id, label: o.name, group: 'Organisations' })),
                      ]} />
                  </div>
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
