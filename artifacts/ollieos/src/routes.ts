/**
 * Pages loaded on first visit, so a phone opening Home does not download Map, Settings or Ask
 * (docs/mobile-plan.md, Part B). Home stays in the main bundle. Tasks moved out on 12th November 2026,
 * when the first load passed its budget; Home starts downloading it in the background once Home is up.
 * A new page goes here, in App.tsx, and in preloadRoute below.
 */
import { lazyPage } from '@/lib/lazy-page';

const load = {
  tasks: () => import('@/pages/tasks'),
  triage: () => import('@/components/triage'),
  clearOut: () => import('@/components/clear-out'),
  commandBar: () => import('@/components/command-bar'),
  review: () => import('@/pages/review'),
  duplicates: () => import('@/pages/duplicates'),
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
  meeting: () => import('@/pages/meeting'),
  brief: () => import('@/pages/brief'),
  digest: () => import('@/pages/digest'),
  roundup: () => import('@/pages/roundup'),
  friday: () => import('@/pages/friday-update'),
  goals: () => import('@/pages/goals'),
  strategy: () => import('@/pages/strategy'),
  contacts: () => import('@/pages/contacts'),
  settings: () => import('@/pages/settings'),
  consent: () => import('@/pages/oauth-consent'),
};

export const TasksPage = lazyPage(load.tasks, 'default');
export const TriageDialog = lazyPage(load.triage, 'TriageDialog');
export const ClearOutDialog = lazyPage(load.clearOut, 'ClearOutDialog');
export const CommandBar = lazyPage(load.commandBar, 'CommandBar');
export const ReviewPage = lazyPage(load.review, 'default');
export const DuplicatesPage = lazyPage(load.duplicates, 'default');
export const MessagesPage = lazyPage(load.messages, 'default');
export const VoicePage = lazyPage(load.voice, 'default');
export const AskPage = lazyPage(load.ask, 'default');
export const KnowledgeInboxPage = lazyPage(load.inbox, 'default');
export const KnowledgeIndexPage = lazyPage(load.projects, 'KnowledgeIndexPage');
export const ProjectPage = lazyPage(load.projects, 'ProjectPage');
export const PersonPage = lazyPage(load.people, 'PersonPage');
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
export const MeetingPage = lazyPage(load.meeting, 'default');
export const BriefPage = lazyPage(load.brief, 'BriefPage');
export const NextBriefPage = lazyPage(load.brief, 'NextBriefPage');
export const DigestPage = lazyPage(load.digest, 'default');
export const RoundupPage = lazyPage(load.roundup, 'default');
export const FridayUpdatePage = lazyPage(load.friday, 'default');
export const GoalsPage = lazyPage(load.goals, 'default');
export const StrategyPage = lazyPage(load.strategy, 'default');
export const ContactsPage = lazyPage(load.contacts, 'default');
export const SettingsPage = lazyPage(load.settings, 'default');
export const OAuthConsentPage = lazyPage(load.consent, 'default');

/** The code a path needs, matched the same way as the routes in App.tsx. Home needs nothing. */
function loaderFor(path: string): (() => Promise<unknown>) | null {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const under = (prefix: string) => p === prefix || p.startsWith(prefix + '/');
  if (under('/tasks')) return load.tasks;
  if (p === '/triage') return load.triage;
  if (p === '/clear-out') return load.clearOut;
  if (under('/review')) return load.review;
  if (under('/duplicates')) return load.duplicates;
  if (under('/messages') || under('/email')) return load.messages;
  if (under('/voice')) return load.voice;
  if (under('/ask')) return load.ask;
  if (under('/knowledge/inbox')) return load.inbox;
  // The bare lists are now Contacts; person and organisation pages keep their own code.
  if (p === '/knowledge/people' || p === '/knowledge/organisations') return load.contacts;
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
  if (under('/digest/friday')) return load.friday;
  if (under('/digest')) return load.digest;
  if (under('/goals')) return load.goals;
  if (under('/strategy')) return load.strategy;
  if (p === '/contacts' || p === '/people') return load.contacts;
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
