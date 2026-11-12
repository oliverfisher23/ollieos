import { useState } from 'react';
import { Link, Redirect, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { getListNoiseRulesQueryKey, useListNoiseRules, updateNoiseRule, type NoiseRule } from '@workspace/api-client-react';
import { SOURCE_LABELS, formatShort } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { IconLeft, IconRight } from '@/components/icons';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';
import { useInvalidateTasks } from '@/lib/task-cache';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import ConnectorsSettings from './settings-connectors';
import EmailSettings from './settings-email';
import KnowledgeSettings from './settings-knowledge';
import PlanningSettings from './settings-planning';
import AgentsSettings from './settings-agents';

/** Sections that moved into Connectors. */
const MOVED: Record<string, string> = { 'ai-access': 'connectors', sweep: 'connectors' };

const SECTIONS = [
  { slug: 'connectors', label: 'Connectors', milestone: 8, line: '' },
  { slug: 'agents', label: 'Agents', milestone: 0, line: '' },
  { slug: 'email', label: 'Email', milestone: 0, line: '' },
  { slug: 'knowledge', label: 'Knowledge', milestone: 6, line: '' },
  { slug: 'noise-rules', label: 'Noise rules', milestone: 2, line: '' },
  { slug: 'planning', label: 'Planning', milestone: 0, line: '' },
  { slug: 'imports', label: 'Imports', milestone: 9, line: 'Import status for your tasks, Knowledge and memory, one line per kind.' },
  { slug: 'export', label: 'Export', milestone: 9, line: 'Download your tasks and Knowledge as CSV files.' },
];

export default function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const phone = useMedia(PHONE_QUERY);
  const current = SECTIONS.find((s) => s.slug === section);
  if (section && MOVED[section]) return <Redirect to={'/settings/' + MOVED[section]} replace />;

  // Phones (docs/mobile-plan.md, Part D): /settings is a list of sections, and each section is a page
  // of its own with a way back. Wider screens keep the side menu and open on Connectors.
  if (!section) {
    if (!phone) return <Redirect to="/settings/connectors" replace />;
    return (
      <section className="oo-panel flex flex-col gap-4 px-5 py-7 oo-fade-in" data-testid="page-settings-menu">
        <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>Settings</h1>
        <nav aria-label="Settings" className="oo-settings-list">
          {SECTIONS.map((s) => (
            <Link key={s.slug} href={'/settings/' + s.slug} data-testid={'link-settings-' + s.slug}>
              <span>{s.label}</span>
              <IconRight size={16} />
            </Link>
          ))}
        </nav>
      </section>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: phone ? 8 : 16, alignItems: 'flex-start' }} className="oo-fade-in">
      {phone ? (
        <Link href="/settings" className="oo-back" style={{ flexBasis: '100%' }} data-testid="link-settings-menu">
          <IconLeft size={14} />
          Settings
        </Link>
      ) : (
        <nav aria-label="Settings" className="oo-panel oo-side" style={{ flex: '1 1 220px', maxWidth: 260, minWidth: 0, boxSizing: 'border-box' }}>
          {SECTIONS.map((s) => (
            <Link key={s.slug} href={'/settings/' + s.slug} aria-current={s.slug === section ? 'page' : undefined} data-testid={'link-settings-' + s.slug}>
              {s.label}
            </Link>
          ))}
        </nav>
      )}
      <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!current ? (
          <section className="oo-panel flex flex-col gap-3 px-5 py-8 sm:px-8" data-testid="state-settings-missing">
            <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600 }}>Settings</h1>
            <p className="oo-soft" style={{ margin: 0 }}>That section does not exist. Pick one from the list.</p>
          </section>
        ) : current.slug === 'noise-rules' ? (
          <NoiseRules />
        ) : current.slug === 'connectors' ? (
          <ConnectorsSettings />
        ) : current.slug === 'email' ? (
          <EmailSettings />
        ) : current.slug === 'knowledge' ? (
          <KnowledgeSettings />
        ) : current.slug === 'agents' ? (
          <AgentsSettings />
        ) : current.slug === 'planning' ? (
          <PlanningSettings />
        ) : (
          <section className="oo-panel flex flex-col gap-3 px-5 py-8 sm:px-8" data-testid={'page-settings-' + current.slug}>
            <span className="oo-serif oo-muted" style={{ fontSize: 18 }}>Arrives in milestone {current.milestone}</span>
            <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>{current.label}</h1>
            <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>{current.line}</p>
          </section>
        )}
      </main>
    </div>
  );
}

function NoiseRules() {
  const rules = useListNoiseRules();
  const list = rules.data ?? [];
  const on = list.filter((r) => r.enabled).length;
  const hits = list.reduce((n, r) => n + r.hitCount, 0);

  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="nr-h">
        <h1 id="nr-h" style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>Noise rules</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          New items that match a rule skip the Inbox and go straight to Noise. Rules only apply to new items from the sweep, never to anything already captured.
          Add one by choosing "Always ignore items like this" when you move something to Noise.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" style={{ marginTop: 14 }}>
          {[
            ['Rules', rules.data ? list.length : undefined, 'total'],
            ['Switched on', rules.data ? on : undefined, 'on'],
            ['Items caught', rules.data ? hits : undefined, 'hits'],
          ].map(([label, value, id]) => (
            <div key={id as string} className="oo-stat" style={{ alignItems: 'flex-start', padding: 18, gap: 8 }} data-testid={'stat-rules-' + id}>
              <span style={{ fontSize: 13 }}>{label}</span>
              {value === undefined ? <Skel h={32} w={40} /> : <span className="oo-num" style={{ fontSize: 32, fontWeight: 500 }}>{value}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="nr-list-h">
        <h2 id="nr-list-h" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>All rules</h2>
        {rules.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
            {[0, 1, 2].map((i) => <Skel key={i} h={18} w={i % 2 ? '70%' : '85%'} />)}
          </div>
        ) : rules.error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-rules-error">
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load your noise rules.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => rules.refetch()} data-testid="button-retry-rules">Try again</button>
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: '18px 0', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="state-rules-empty">
            <p className="oo-serif" style={{ margin: 0, fontSize: 20 }}>No rules yet.</p>
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>When you move an item to Noise, you can choose to always ignore items like it.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="oo-table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th scope="col">Rule</th><th scope="col">Source</th><th scope="col">Caught</th>
                  <th scope="col">Last caught</th><th scope="col">Added</th><th scope="col">On</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => <RuleRow key={r.id} rule={r} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function RuleRow({ rule }: { rule: NoiseRule }) {
  const invalidate = useInvalidateTasks();
  const qc = useQueryClient();
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? rule.enabled;

  const toggle = async () => {
    const next = !enabled;
    setPending(next);
    try {
      const updated = await updateNoiseRule(rule.id, { enabled: next });
      qc.setQueryData<NoiseRule[]>(getListNoiseRulesQueryKey(), (list) => list?.map((r) => (r.id === updated.id ? updated : r)));
      invalidate();
      notify(next ? 'Rule switched on' : 'Rule switched off', rule.label);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <tr data-testid={'row-rule-' + rule.id}>
      <td style={{ fontWeight: 500, color: enabled ? undefined : 'var(--oo-ink-muted)' }}>{rule.label}</td>
      <td className="oo-soft">{rule.source ? SOURCE_LABELS[rule.source] : 'Any'}</td>
      <td className="oo-num" data-testid={'text-rule-hits-' + rule.id}>{rule.hitCount}</td>
      <td className="oo-num oo-soft">{rule.lastHitAt ? formatShort(rule.lastHitAt) : 'Not yet'}</td>
      <td className="oo-num oo-soft">{formatShort(rule.createdAt)}</td>
      <td>
        <button type="button" role="switch" className="oo-switch" aria-checked={enabled} disabled={pending !== null}
          aria-label={'Use rule: ' + rule.label} onClick={toggle} data-testid={'switch-rule-' + rule.id} />
      </td>
    </tr>
  );
}
