import { Suspense, lazy, type ReactNode } from 'react';
import type { AgendaHandle } from '@/components/agenda-ideas';
import { Skel } from '@/components/bits';

// The rich text editor is large, so it loads only on the pages that show an agenda.
const MeetingAgenda = lazy(() => import('@/components/meeting-agenda').then((m) => ({ default: m.MeetingAgenda })));

export function LazyMeetingAgenda({ eventId, ideas }: { eventId: number; ideas?: (agenda: AgendaHandle) => ReactNode }) {
  return (
    <Suspense fallback={<section style={{ background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)', padding: '26px 30px' }}><Skel h={180} /></section>}>
      <MeetingAgenda eventId={eventId} ideas={ideas} />
    </Suspense>
  );
}
