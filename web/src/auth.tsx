import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiError, onUnauthorized } from './api';
import { roles } from './permissions';
const sessionSchema = z.object({
  user: z.object({
    id: z.string(),
    tenant_id: z.string(),
    full_name: z.string(),
    email: z.string(),
    role: z.enum(roles),
    active: z.literal(true),
  }),
  expiresAt: z.number(),
});
export type Session = z.infer<typeof sessionSchema>;
type Status = 'loading' | 'ready' | 'error';
type Auth = {
  session: Session | null;
  status: Status;
  expired: boolean;
  logoutError: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
};
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [status, setStatus] = useState<Status>('loading'),
    [expired, setExpired] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const cache = useQueryClient(),
    generation = useRef(0);
  function clear(expiry: boolean) {
    generation.current++;
    setSession(null);
    setStatus('ready');
    setExpired(expiry);
    cache.clear();
  }
  async function load() {
    const current = ++generation.current;
    setStatus('loading');
    try {
      const value = sessionSchema.parse(await api('/auth/session', {}, true));
      if (current !== generation.current) return;
      if (value.expiresAt <= Date.now()) {
        clear(true);
        return;
      }
      setSession(value);
      setStatus('ready');
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) clear(false);
      else setStatus('error');
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, []); // Startup only; requests carry generation guards.
  useEffect(() => onUnauthorized(() => clear(true)), [cache]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => clear(true),
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    const check = () => {
      if (session && session.expiresAt <= Date.now()) clear(true);
    };
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    return () => {
      window.removeEventListener('pageshow', check);
      window.removeEventListener('focus', check);
    };
  }, [session]);
  async function login(email: string, password: string) {
    const tenantId = import.meta.env.VITE_TENANT_ID;
    if (!z.uuid().safeParse(tenantId).success) throw new ApiError(503);
    await api(
      '/auth/session',
      { method: 'POST', body: JSON.stringify({ tenantId, email, password }) },
      true,
    );
    const value = sessionSchema.parse(await api('/auth/session', {}, true));
    generation.current++;
    cache.clear();
    setSession(value);
    setStatus('ready');
    setExpired(false);
  }
  async function logout() {
    clear(false);
    try {
      await api('/auth/session', { method: 'DELETE' }, true);
      setLogoutError('');
    } catch {
      setLogoutError(
        'Signed out locally. Server sign-out could not be confirmed. Retry sign-out before leaving this shared browser.',
      );
    }
  }
  return (
    <Context.Provider
      value={{
        session,
        status,
        expired,
        logoutError,
        login,
        logout,
        retry: () => void load(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider required');
  return value;
}
