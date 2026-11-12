import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { startEarlyLoads } from '@/lib/query-client';

import './index.css';

// Path inside the app, as the router sees it (BASE_URL is "/" unless the app is served under a prefix).
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const path = window.location.pathname.startsWith(base) ? window.location.pathname.slice(base.length) || '/' : window.location.pathname;
startEarlyLoads(path);

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
