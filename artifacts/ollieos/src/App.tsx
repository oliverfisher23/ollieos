import { Suspense, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import { ErrorBoundary } from '@/components/error-boundary';
import { PageLoading } from '@/components/page-loading';
import { Toaster } from '@/components/ui/toaster';
import { DarkShell } from '@/components/dark-shell';
import { LightShell } from '@/components/light-shell';
import NotFound from '@/pages/not-found';
import HomePage from '@/pages/home';
import TasksPage from '@/pages/tasks';
import {
  AskPage,
  BriefPage,
  ClearOutDialog,
  ContactsPage,
  DecisionPage,
  DecisionsListPage,
  DigestPage,
  GoalsPage,
  KnowledgeIndexPage,
  KnowledgeInboxPage,
  LibraryPage,
  MapPage,
  MeetingsPage,
  MessagesPage,
  NextBriefPage,
  NotePage,
  NotesListPage,
  OAuthConsentPage,
  OrganisationPage,
  PersonPage,
  PlaybookPage,
  ProductPage,
  ProductsListPage,
  ProjectPage,
  ReviewPage,
  RoundupPage,
  FridayUpdatePage,
  SessionsPage,
  SettingsPage,
  StrategyPage,
  TriageDialog,
  VoicePage,
} from '@/routes';
import { NotAuthorised, SignIn, Splash } from '@/pages/auth-screens';
import { AuthProvider } from '@/lib/auth-context';
import { useForbidden } from '@/lib/forbidden';
import { queryClient } from '@/lib/query-client';
import { contactsPathFor } from '@/lib/contacts-path';

/** The Email page is now Messages; old links keep their tab and the item they opened. */
function EmailRedirect() {
  const search = useSearch();
  return <Redirect to={'/messages' + (search ? '?' + search : '')} replace />;
}

/** People, and the People and Organisations lists, are now Contacts; old links land on the matching view. */
function ToContacts() {
  const [location] = useLocation();
  return <Redirect to={contactsPathFor(location, window.location.search)} replace />;
}

function TriagePage() {
  const [, navigate] = useLocation();
  return (
    <>
      <HomePage />
      <Suspense fallback={null}>
        <TriageDialog onClose={() => navigate('/')} />
      </Suspense>
    </>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Suspense fallback={<PageLoading />}>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/triage" component={TriagePage} />
          <Route path="/clear-out" component={ClearOutPage} />
          <Route path="/tasks" component={TasksPage} />
          <Route path="/voice" component={VoicePage} />
          <Route path="/review" component={ReviewPage} />
          <Route path="/messages" component={MessagesPage} />
          <Route path="/email" component={EmailRedirect} />
          <Route path="/ask" component={AskPage} />
          <Route path="/ask/:threadId" component={AskPage} />
          <Route path="/knowledge/inbox" component={KnowledgeInboxPage} />
          <Route path="/knowledge" component={KnowledgeIndexPage} />
          <Route path="/knowledge/projects/:slug" component={ProjectPage} />
          <Route path="/knowledge/people" component={ToContacts} />
          <Route path="/knowledge/people/:slug" component={PersonPage} />
          <Route path="/knowledge/organisations" component={ToContacts} />
          <Route path="/knowledge/organisations/:slug" component={OrganisationPage} />
          <Route path="/knowledge/decisions" component={DecisionsListPage} />
          <Route path="/knowledge/decisions/:id" component={DecisionPage} />
          <Route path="/knowledge/notes" component={NotesListPage} />
          <Route path="/knowledge/notes/:id" component={NotePage} />
          <Route path="/knowledge/library" component={LibraryPage} />
          <Route path="/knowledge/playbooks/:id" component={PlaybookPage} />
          <Route path="/knowledge/products" component={ProductsListPage} />
          <Route path="/knowledge/products/:slug" component={ProductPage} />
          <Route path="/knowledge/sessions" component={SessionsPage} />
          <Route path="/knowledge/map" component={MapPage} />
          <Route path="/meetings" component={MeetingsPage} />
          <Route path="/briefs/next" component={NextBriefPage} />
          <Route path="/briefs/:eventId">{(p) => <BriefPage key={p.eventId} eventId={p.eventId} />}</Route>
          <Route path="/digest">{() => <DigestPage />}</Route>
          <Route path="/digest/week">{() => <RoundupPage />}</Route>
          <Route path="/digest/friday">{() => <FridayUpdatePage />}</Route>
          <Route path="/digest/:date">{(p) => <DigestPage key={p.date} date={p.date} />}</Route>
          <Route path="/goals" component={GoalsPage} />
          <Route path="/strategy" component={StrategyPage} />
          <Route path="/contacts" component={ContactsPage} />
          <Route path="/people" component={ToContacts} />
          <Route path="/people/:slug">{(p) => <Redirect to={'/knowledge/people/' + p.slug} replace />}</Route>
          <Route path="/settings" component={SettingsPage} />
          <Route path="/settings/:section" component={SettingsPage} />
          <Route path="/oauth/consent" component={OAuthConsentPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </RoutedErrorBoundary>
  );
}

/** Over Home, like Triage. Started from the Backlog tab, closing goes back there. */
function ClearOutPage() {
  const [, navigate] = useLocation();
  const fromBacklog = new URLSearchParams(window.location.search).get('from') === 'backlog';
  return (
    <>
      <HomePage />
      <Suspense fallback={null}>
        <ClearOutDialog onClose={() => navigate(fromBacklog ? '/tasks?tab=backlog' : '/')} />
      </Suspense>
    </>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  // Opening or closing Triage keeps Home mounted underneath.
  return <ErrorBoundary resetKey={location === '/triage' || location === '/clear-out' ? '/' : location}>{children}</ErrorBoundary>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  if (location === '/' || location === '/triage' || location === '/clear-out' || location === '/ask' || location.startsWith('/ask/') || location === '/voice') return <DarkShell>{children}</DarkShell>;
  return <LightShell>{children}</LightShell>;
}

/** Signs in and comes back to this page, so a Claude connection request survives the sign-in. */
function loginHere() {
  const here = window.location.pathname + window.location.search;
  window.location.href = '/api/login?returnTo=' + encodeURIComponent(here);
}

function Gate() {
  const auth = useAuth();
  const [location] = useLocation();
  const forbidden = useForbidden();

  if (location === '/not-authorised' || forbidden) return <NotAuthorised onLogout={auth.logout} />;
  if (auth.isLoading) return <Splash />;
  if (!auth.isAuthenticated) return <SignIn onLogin={() => loginHere()} />;

  return (
    <AuthProvider value={{ user: auth.user, logout: auth.logout }}>
      <Shell>
        <Router />
      </Shell>
    </AuthProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Gate />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
