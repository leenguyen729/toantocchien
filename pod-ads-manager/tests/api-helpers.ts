import { buildApp } from '../apps/api/src/app';
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;
import { makeSystem } from './helpers';

export async function makeApi(opts: Parameters<typeof makeSystem>[0] = {}) {
  const ctx = await makeSystem(opts);
  const app = await buildApp({ sys: ctx.sys, mockTools: true });
  const login = async (actor_id: string): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/mock-login', payload: { actor_id } });
    if (r.statusCode !== 200) throw new Error(`login ${actor_id}: ${r.body}`);
    return r.json().token as string;
  };
  const call = (app2: FastifyInstance, token: string | null) => async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await app2.inject({ method, url, payload: payload as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { ...ctx, app, login, as: async (actor: string) => call(app, await login(actor)), anon: call(app, null) };
}
