import { createContext, useContext, type ReactNode } from 'react';
import type { AuthUser } from '@workspace/replit-auth-web';

interface Ctx {
  user: AuthUser | null;
  logout: () => void;
}

const AuthCtx = createContext<Ctx>({ user: null, logout: () => {} });

export function AuthProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useSession() {
  return useContext(AuthCtx);
}
