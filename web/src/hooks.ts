import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export interface FetchState<T> {
  data: T | undefined; loading: boolean; error: string | null;
  /** 重新加载（显示 loading） */
  reload: () => void;
  /** 后台静默刷新：不显示 loading、失败时保留现有数据，用于轮询 */
  reloadSilent: () => void;
}

/**
 * 加载数据。deps 必须是可序列化的基本类型（字符串 / 数字 / 布尔 / undefined）。
 * - reload / reloadSilent：保留上一次结果，避免界面闪烁；
 * - deps 变化：默认立刻清掉旧数据，避免把 A 的数字显示在 B 名下；
 *   keepPrevious 为 true 时（筛选条件类的 deps，且响应自带范围说明）加载期间保留旧数据，但新请求失败时仍会清掉。
 */
export function useFetch<T>(loader: () => Promise<T>, deps: unknown[], opts: { keepPrevious?: boolean } = {}): FetchState<T> {
  const key = JSON.stringify(deps.map((d) => d ?? null));
  const [result, setResult] = useState<{ key: string; data: T | undefined; error: string | null }>({ key, data: undefined, error: null });
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const busyRef = useRef(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    const mine = ++seq.current;
    busyRef.current = true;
    setBusy(true);
    loaderRef.current()
      .then((d) => { if (mine === seq.current) setResult({ key, data: d, error: null }); })
      .catch((e) => { if (mine === seq.current) setResult((prev) => ({ key, data: prev.key === key ? prev.data : undefined, error: errorMessage(e) })); })
      .finally(() => { if (mine === seq.current) { busyRef.current = false; setBusy(false); } });
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const reloadSilent = useCallback(() => {
    if (busyRef.current) return; // 正常加载进行中：它的结果更新，不需要再发一次
    const mine = ++seq.current;
    const forKey = keyRef.current;
    loaderRef.current()
      .then((d) => { if (mine === seq.current && forKey === keyRef.current) setResult({ key: forKey, data: d, error: null }); })
      .catch(() => undefined); // 轮询中的偶发失败不打断界面，下一轮再试
  }, []);

  const current = result.key === key;
  return {
    data: current || opts.keepPrevious ? result.data : undefined,
    loading: busy || !current,
    error: current ? result.error : null,
    reload, reloadSilent,
  };
}

export interface PagedState<T> {
  items: T[]; loading: boolean; loadingMore: boolean; error: string | null; hasMore: boolean;
  reload: () => void; loadMore: () => void;
}

/**
 * 按 offset 分页的列表 +“加载更多”。上一页取满（= pageSize）才认为可能还有下一页；
 * 翻页期间有新记录插入会让窗口错位，因此按 id 去重；一条新记录都没拿到时也停止继续加载。
 */
export function usePagedFetch<T>(loadPage: (offset: number, limit: number) => Promise<T[]>, deps: unknown[], pageSize: number, idOf: (item: T) => string | number): PagedState<T> {
  const key = JSON.stringify(deps.map((d) => d ?? null));
  const [state, setState] = useState<{ key: string; items: T[]; hasMore: boolean; error: string | null }>({ key, items: [], hasMore: false, error: null });
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;

  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true);
    setLoadingMore(false);
    loadRef.current(0, pageSize)
      .then((rows) => { if (mine === seq.current) setState({ key, items: rows, hasMore: rows.length >= pageSize, error: null }); })
      .catch((e) => { if (mine === seq.current) setState((prev) => ({ key, items: prev.key === key ? prev.items : [], hasMore: false, error: errorMessage(e) })); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [key, tick, pageSize]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const current = state.key === key;
  const offset = state.items.length;
  const loadMore = () => {
    if (!current || busy || loadingMore || !state.hasMore) return;
    const mine = ++seq.current;
    setLoadingMore(true);
    loadRef.current(offset, pageSize)
      .then((rows) => {
        if (mine !== seq.current) return;
        setState((prev) => {
          const seen = new Set(prev.items.map(idOf));
          const fresh = rows.filter((r) => !seen.has(idOf(r)));
          return { key, items: [...prev.items, ...fresh], hasMore: rows.length >= pageSize && fresh.length > 0, error: null };
        });
      })
      .catch((e) => { if (mine === seq.current) setState((prev) => ({ ...prev, error: errorMessage(e) })); })
      .finally(() => { if (mine === seq.current) setLoadingMore(false); });
  };

  return { items: current ? state.items : [], loading: busy || !current, loadingMore, error: current ? state.error : null, hasMore: current && state.hasMore, reload, loadMore };
}

/**
 * 条件轮询：active 为 true 期间每 intervalMs 调一次 fn；标签页隐藏时暂停，回到前台立即补一次。
 * active 持续超过 maxMs 后自动停止（防止状态卡住时无限轮询），active 变回 false 再变 true 会重新计时。
 */
export function usePolling(fn: () => void, active: boolean, intervalMs = 5000, maxMs = 15 * 60_000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const tickOnce = () => { if (Date.now() - startedAt > maxMs) stop(); else fnRef.current(); };
    const start = () => { if (!timer && Date.now() - startedAt <= maxMs) timer = setInterval(tickOnce, intervalMs); };
    const onVisibility = () => { if (document.hidden) stop(); else { tickOnce(); start(); } };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [active, intervalMs, maxMs]);
}
