'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, getToken, setToken, type Me, type Status } from '../lib/api';

type DemoUser = { actor_id: string; display_name: string; tenant_id: string; roles: string[] };
type Session = { me: Me | null; status: Status | null; refresh: () => Promise<void>; logout: () => void };

const Ctx = createContext<Session>({ me: null, status: null, refresh: async () => undefined, logout: () => undefined });
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [ready, setReady] = useState(false);
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setStatus(null);
      return;
    }
    try {
      const [m, s] = await Promise.all([api<Me>('/api/me'), api<Status>('/api/status')]);
      setMe(m);
      setStatus(s);
    } catch (e) {
      // Only a rejected session logs out. A network blip or a request aborted by a
      // page reload must not throw the token away.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setToken(null);
        setMe(null);
        setStatus(null);
      }
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    if (!ready || me) return;
    api<DemoUser[]>('/api/auth/demo-users')
      .then(setUsers)
      .catch((e: Error) => setError(`Không tải được người dùng demo: ${e.message}. API có đang chạy ở mock mode không?`));
  }, [ready, me]);

  const login = async (actor_id: string) => {
    setError(null);
    try {
      const r = await api<{ token: string }>('/api/auth/mock-login', { method: 'POST', body: { actor_id } });
      setToken(r.token);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const logout = () => {
    setToken(null);
    setMe(null);
    setStatus(null);
  };

  if (!ready) return <main className="center muted">Đang tải…</main>;
  if (!me) {
    return (
      <main className="login">
        <h1>POD AI Ads Manager</h1>
        <p className="muted">Đăng nhập demo (chỉ có ở mock mode). Sản phẩm thật dùng IdP bên ngoài; xem docs/adr/0003-auth.md.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <ul className="users">
          {(users ?? []).map((u) => (
            <li key={u.actor_id}>
              <button onClick={() => void login(u.actor_id)} data-testid={`login-${u.actor_id}`}>
                {u.display_name}
                <span className="muted"> · {u.roles.join(', ')} · {u.tenant_id}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return <Ctx.Provider value={{ me, status, refresh, logout }}>{children}</Ctx.Provider>;
}
