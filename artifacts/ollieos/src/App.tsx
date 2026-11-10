import { type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DarkShell } from '@/components/dark-shell';
import { LightShell } from '@/components/light-shell';
import NotFound from '@/pages/not-found';
import HomePage from '@/pages/home';
import TasksPage from '@/pages/tasks';
import AskPage from '@/pages/ask';
import { KnowledgeIndexPage, ProjectPage } from '@/pages/knowledge/projects';
import { PeopleListPage, PersonPage } from '@/pages/knowledge/people';
import { OrganisationPage, OrganisationsListPage } from '@/pages/knowledge/organisations';
import { DecisionPage, DecisionsListPage, NotePage, NotesListPage } from '@/pages/knowledge/records';
import KnowledgeInboxPage from '@/pages/knowledge/inbox';
import SettingsPage from '@/pages/settings';
import OAuthConsentPage from '@/pages/oauth-consent';
import { TriageDialog } from '@/components/triage';
import { NotAuthorised, SignIn, Splash } from '@/pages/auth-screens';
import { AuthProvider } from '@/lib/auth-context';
import { isForbiddenError, reportApiError, useForbidden } from '@/lib/forbidden';

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportApiError }),
  mutationCache: new MutationCache({ onError: reportApiError }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !isForbiddenError(err) && (err as { status?: number } | null)?.status !== 404 && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function TriagePage() {
  const [, navigate] = useLocation();
  return (
    <>
      <HomePage />
      <TriageDialog onClose={() => navigate('/')} />
    </>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/triage" component={TriagePage} />
        <Route path="/tasks" component={TasksPage} />
        <Route path="/ask" component={AskPage} />
        <Route path="/ask/:threadId" component={AskPage} />
        <Route path="/knowledge/inbox" component={KnowledgeInboxPage} />
        <Route path="/knowledge" component={KnowledgeIndexPage} />
        <Route path="/knowledge/projects/:slug" component={ProjectPage} />
        <Route path="/knowledge/people" component={PeopleListPage} />
        <Route path="/knowledge/people/:slug" component={PersonPage} />
        <Route path="/knowledge/organisations" component={OrganisationsListPage} />
        <Route path="/knowledge/organisations/:slug" component={OrganisationPage} />
        <Route path="/knowledge/decisions" component={DecisionsListPage} />
        <Route path="/knowledge/decisions/:id" component={DecisionPage} />
        <Route path="/knowledge/notes" component={NotesListPage} />
        <Route path="/knowledge/notes/:id" component={NotePage} />
        <Route path="/people">{() => <Redirect to="/knowledge/people" replace />}</Route>
        <Route path="/people/:slug">{(p) => <Redirect to={'/knowledge/people/' + p.slug} replace />}</Route>
        <Route path="/settings">{() => <Redirect to="/settings/noise-rules" replace />}</Route>
        <Route path="/settings/:section" component={SettingsPage} />
        <Route path="/oauth/consent" component={OAuthConsentPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  // Opening or closing Triage keeps Home mounted underneath.
  return <ErrorBoundary resetKey={location === '/triage' ? '/' : location}>{children}</ErrorBoundary>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  if (location === '/' || location === '/triage' || location === '/ask' || location.startsWith('/ask/')) return <DarkShell>{children}</DarkShell>;
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
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Gate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
