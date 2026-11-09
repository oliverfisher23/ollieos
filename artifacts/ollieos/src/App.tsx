import { type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DarkShell } from '@/components/dark-shell';
import { LightShell } from '@/components/light-shell';
import NotFound from '@/pages/not-found';
import HomePage from '@/pages/home';
import TasksPage from '@/pages/tasks';
import Placeholder from '@/pages/placeholder';
import { NotAuthorised, SignIn, Splash } from '@/pages/auth-screens';
import { AuthProvider } from '@/lib/auth-context';
import { isForbiddenError, reportApiError, useForbidden } from '@/lib/forbidden';

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportApiError }),
  mutationCache: new MutationCache({ onError: reportApiError }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !isForbiddenError(err) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const KnowledgePage = () => (
  <Placeholder title="Knowledge" milestone={3} line="Projects, notes and the context Claude reads from will live here, with clear control over what it can see." />
);
const PeoplePage = () => (
  <Placeholder title="People" milestone={3} line="Everyone you work with, what you owe them and what they owe you, gathered on one page each." />
);
const SettingsPage = () => (
  <Placeholder title="Settings" milestone={4} line="AI access, the sweep schedule and your noise rules will be set from here." />
);

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/tasks" component={TasksPage} />
        <Route path="/knowledge" component={KnowledgePage} />
        <Route path="/people" component={PeoplePage} />
        <Route path="/settings" component={SettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  if (location === '/') return <DarkShell>{children}</DarkShell>;
  return <LightShell>{children}</LightShell>;
}

function Gate() {
  const auth = useAuth();
  const [location] = useLocation();
  const forbidden = useForbidden();

  if (location === '/not-authorised' || forbidden) return <NotAuthorised onLogout={auth.logout} />;
  if (auth.isLoading) return <Splash />;
  if (!auth.isAuthenticated) return <SignIn onLogin={auth.login} />;

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
