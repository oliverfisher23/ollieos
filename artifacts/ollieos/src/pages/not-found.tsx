import { Link } from 'wouter';

export default function NotFound() {
  return (
    <section className="oo-panel flex flex-col gap-4 px-5 py-10 sm:px-10" data-testid="page-not-found">
      <span className="oo-serif oo-muted" style={{ fontSize: 18 }}>Page not found</span>
      <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600 }}>Nothing lives here</h1>
      <div><Link href="/" className="oo-btn oo-btn-ink" data-testid="link-home">Back to Home</Link></div>
    </section>
  );
}
