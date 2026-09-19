import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

/** 加载数据；重新加载时保留上一次结果，避免界面闪烁。 */
export function useFetch<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    loader()
      .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (mine === seq.current) setError(errorMessage(e)); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
