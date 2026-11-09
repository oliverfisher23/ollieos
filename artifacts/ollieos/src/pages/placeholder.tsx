import { Link } from 'wouter';

export default function Placeholder({ title, milestone, line }: { title: string; milestone: number; line: string }) {
  return (
    <section className="oo-panel oo-fade-in flex flex-col gap-5 px-5 py-8 sm:px-10 sm:py-10" data-testid={'page-' + title.toLowerCase()}>
      <span className="oo-serif oo-muted" style={{ fontSize: 18 }}>Arrives in milestone {milestone}</span>
      <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.015em' }}>{title}</h1>
      <p className="oo-soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.6, maxWidth: 560 }}>{line}</p>
      <div className="oo-stat" style={{ alignItems: 'flex-start', maxWidth: 560, padding: '18px 20px', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>Nothing to see here yet</span>
        <span className="oo-muted" style={{ fontSize: 13 }}>Your tasks are ready to use in the meantime.</span>
      </div>
      <div><Link href="/tasks" className="oo-btn oo-btn-ink" data-testid="link-go-tasks">Go to Tasks</Link></div>
    </section>
  );
}
