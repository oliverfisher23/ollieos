import { SOURCE_LABELS, SOURCE_MARKS, STATUS_LABELS, PRIORITY_LABELS } from '@workspace/shared';
import type { Priority, TaskSource, TaskStatus } from '@workspace/api-client-react';
import { initials, toneFor } from '@/lib/task-cache';

export function Logo({ size = 30, radius = 9 }: { size?: number; radius?: number }) {
  return (
    <span aria-hidden="true" className="oo-logo" style={{ width: size, height: size, borderRadius: radius }}>
      <svg viewBox="0 0 512 512" width={size} height={size} fill="none">
        <path d="M 382.9 196.8 A 140 140 0 1 1 315.2 129.1" stroke="currentColor" strokeWidth="56" strokeLinecap="round" />
        <circle cx="256" cy="256" r="46" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Grain() {
  return (
    <svg aria-hidden="true" className="oo-grain">
      <filter id="oo-grain-f">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#oo-grain-f)" />
    </svg>
  );
}

export function SourceMark({ source, size = 24 }: { source: TaskSource; size?: number }) {
  return (
    <span aria-hidden="true" className="oo-mark" data-src={source} style={{ width: size, height: size }}>
      {SOURCE_MARKS[source]}
    </span>
  );
}

export function SourceLabel({ source }: { source: TaskSource }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <SourceMark source={source} />
      {SOURCE_LABELS[source]}
    </span>
  );
}

export function StatusPill({ status, testId }: { status: TaskStatus; testId?: string }) {
  return <span className="oo-pill" data-tone={status} data-testid={testId}>{STATUS_LABELS[status]}</span>;
}

export function PriorityPill({ priority, testId }: { priority: Priority; testId?: string }) {
  return <span className="oo-pill" data-tone={priority === 'high' ? 'high' : undefined} data-testid={testId}>{PRIORITY_LABELS[priority]}</span>;
}

export function Avatar({ name, id, size = 28 }: { name: string; id: number | string; size?: number }) {
  return (
    <span aria-hidden="true" className="oo-avatar" data-tone={toneFor(id)} style={{ width: size, height: size, fontSize: size < 26 ? 10 : 11 }}>
      {initials(name)}
    </span>
  );
}

export function Skel({ h = 14, w = '100%', className = '' }: { h?: number; w?: number | string; className?: string }) {
  return <span aria-hidden="true" className={'oo-skel ' + className} style={{ display: 'block', height: h, width: w }} />;
}

/** "123 of 400" under a field with a length limit; turns red past the limit. */
export function CharCount({ n, max, id }: { n: number; max: number; id?: string }) {
  const over = n > max;
  return (
    <span id={id} className="oo-num" aria-live={over ? 'polite' : 'off'} style={{ fontSize: 12, alignSelf: 'flex-end', color: over ? 'var(--oo-danger)' : 'var(--oo-ink-faint)' }} data-testid="text-char-count">
      {over ? `${n - max} over the ${max} limit` : `${n} of ${max}`}
    </span>
  );
}
