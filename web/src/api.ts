export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, opts: { body?: unknown; query?: Query; noRedirect?: boolean } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(withQuery(`/api${path}`, opts.query), {
      method,
      credentials: 'include',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, '无法连接到服务器，请检查网络');
  }
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; message?: string; code?: string };
    if (res.status === 401 && !opts.noRedirect && !location.pathname.startsWith('/login')) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.assign(`/login?redirect=${back}`);
    }
    throw new ApiError(res.status, payload.error ?? payload.message ?? `请求失败（${res.status}）`, payload.code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, noRedirect = false) => request<T>('GET', path, { query, noRedirect }),
  post: <T>(path: string, body: unknown = {}, query?: Query, noRedirect = false) => request<T>('POST', path, { body, query, noRedirect }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
};

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
