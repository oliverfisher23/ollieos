/**
 * Pages loaded on first visit, so a phone opening Home does not download Map, Settings or Ask
 * (docs/mobile-plan.md, Part B). Home and Tasks stay in the main bundle: they are opened most.
 * A new page goes here, in App.tsx, and in preloadRoute below.
 */
import { lazyPage } from '@/lib/lazy-page';

const load = {
  triage: () => import('@/components/triage'),
  clearOut: () => import('@/components/clear-out'),
  review: () => import('@/pages/review'),
  messages: () => import('@/pages/messages'),
  voice: () => import('@/pages/voice'),
  ask: () => import('@/pages/ask'),
  inbox: () => import('@/pages/knowledge/inbox'),
  projects: () => import('@/pages/knowledge/projects'),
  people: () => import('@/pages/knowledge/people'),
  organisations: () => import('@/pages/knowledge/organisations'),
  records: () => import('@/pages/knowledge/records'),
  library: () => import('@/pages/knowledge/library'),
  playbooks: () => import('@/pages/knowledge/playbooks'),
  products: () => import('@/pages/knowledge/products'),
  sessions: () => import('@/pages/knowledge/sessions'),
  map: () => import('@/pages/knowledge/map'),
  meetings: () => import('@/pages/meetings'),
  brief: () => import('@/pages/brief'),
  digest: () => import('@/pages/digest'),
  roundup: () => import('@/pages/roundup'),
  goals: () => import('@/pages/goals'),
  strategy: () => import('@/pages/strategy'),
  cadence: () => import('@/pages/people-cadence'),
  settings: () => import('@/pages/settings'),
  consent: () => import('@/pages/oauth-consent'),
};

export const TriageDialog = lazyPage(load.triage, 'TriageDialog');
export const ClearOutDialog = lazyPage(load.clearOut, 'ClearOutDialog');
export const ReviewPage = lazyPage(load.review, 'default');
export const MessagesPage = lazyPage(load.messages, 'default');
export const VoicePage = lazyPage(load.voice, 'default');
export const AskPage = lazyPage(load.ask, 'default');
export const KnowledgeInboxPage = lazyPage(load.inbox, 'default');
export const KnowledgeIndexPage = lazyPage(load.projects, 'KnowledgeIndexPage');
export const ProjectPage = lazyPage(load.projects, 'ProjectPage');
export const PeopleListPage = lazyPage(load.people, 'PeopleListPage');
export const PersonPage = lazyPage(load.people, 'PersonPage');
export const OrganisationsListPage = lazyPage(load.organisations, 'OrganisationsListPage');
export const OrganisationPage = lazyPage(load.organisations, 'OrganisationPage');
export const DecisionsListPage = lazyPage(load.records, 'DecisionsListPage');
export const DecisionPage = lazyPage(load.records, 'DecisionPage');
export const NotesListPage = lazyPage(load.records, 'NotesListPage');
export const NotePage = lazyPage(load.records, 'NotePage');
export const LibraryPage = lazyPage(load.library, 'default');
export const PlaybookPage = lazyPage(load.playbooks, 'PlaybookPage');
export const ProductsListPage = lazyPage(load.products, 'ProductsListPage');
export const ProductPage = lazyPage(load.products, 'ProductPage');
export const SessionsPage = lazyPage(load.sessions, 'default');
export const MapPage = lazyPage(load.map, 'default');
export const MeetingsPage = lazyPage(load.meetings, 'default');
export const BriefPage = lazyPage(load.brief, 'BriefPage');
export const NextBriefPage = lazyPage(load.brief, 'NextBriefPage');
export const DigestPage = lazyPage(load.digest, 'default');
export const RoundupPage = lazyPage(load.roundup, 'default');
export const GoalsPage = lazyPage(load.goals, 'default');
export const StrategyPage = lazyPage(load.strategy, 'default');
export const PeopleCadencePage = lazyPage(load.cadence, 'default');
export const SettingsPage = lazyPage(load.settings, 'default');
export const OAuthConsentPage = lazyPage(load.consent, 'default');

/** The code a path needs, matched the same way as the routes in App.tsx. Home and Tasks need nothing. */
function loaderFor(path: string): (() => Promise<unknown>) | null {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const under = (prefix: string) => p === prefix || p.startsWith(prefix + '/');
  if (p === '/triage') return load.triage;
  if (p === '/clear-out') return load.clearOut;
  if (under('/review')) return load.review;
  if (under('/messages') || under('/email')) return load.messages;
  if (under('/voice')) return load.voice;
  if (under('/ask')) return load.ask;
  if (under('/knowledge/inbox')) return load.inbox;
  if (under('/knowledge/people')) return load.people;
  if (under('/knowledge/organisations')) return load.organisations;
  if (under('/knowledge/decisions') || under('/knowledge/notes')) return load.records;
  if (under('/knowledge/library')) return load.library;
  if (under('/knowledge/playbooks')) return load.playbooks;
  if (under('/knowledge/products')) return load.products;
  if (under('/knowledge/sessions')) return load.sessions;
  if (under('/knowledge/map')) return load.map;
  if (under('/knowledge')) return load.projects;
  if (under('/meetings')) return load.meetings;
  if (under('/briefs')) return load.brief;
  if (under('/digest/week')) return load.roundup;
  if (under('/digest')) return load.digest;
  if (under('/goals')) return load.goals;
  if (under('/strategy')) return load.strategy;
  if (p === '/people') return load.cadence;
  if (under('/people')) return load.people;
  if (under('/settings')) return load.settings;
  if (under('/oauth/consent')) return load.consent;
  return null;
}

/** Starts downloading a page's code without waiting for it. Failures are left for the page itself to report. */
export function preloadRoute(path: string): void {
  const loader = loaderFor(path);
  if (loader) loader().catch(() => {});
}
