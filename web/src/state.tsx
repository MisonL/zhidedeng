import { createContext, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { CurrentUser, Model, Station, VendorWithModels } from '@zhidedeng/shared';
import { api, ApiError } from './api';
import { loginPath } from './format';
import { useAsync } from './hooks';
import type { AsyncState } from './hooks';

// useMemo 的依赖必须是稳定引用；`?? []` 每次渲染都会新建数组，
// 那样数据没到时缓存照样失效。提到模块级避免这件事。
const EMPTY_VENDORS: VendorWithModels[] = [];
const EMPTY_STATIONS: Station[] = [];

/** data：undefined 表示还在确认，null 表示未登录。 */
interface MeContextValue extends AsyncState<CurrentUser | null> {
  setMe: (me: CurrentUser) => void;
  refreshMe: () => Promise<void>;
  signIn: (me: CurrentUser) => void;
  signOut: () => Promise<void>;
  // 登录身份每变一次加一，页面据此重新取数（投票、收藏状态都跟账号走）。
  epoch: number;
}

interface Catalog {
  vendors: VendorWithModels[];
  stations: Station[];
}

interface CatalogContextValue extends AsyncState<Catalog> {
  vendorBySlug: Map<string, VendorWithModels>;
  modelBySlug: Map<string, Model>;
  stationBySlug: Map<string, Station>;
}

const MeContext = createContext<MeContextValue | null>(null);
const CatalogContext = createContext<CatalogContextValue | null>(null);
const ToastContext = createContext<((message: string) => void) | null>(null);

export const useMe = () => useContext(MeContext)!;
export const useCatalog = () => useContext(CatalogContext)!;
export const useToast = () => useContext(ToastContext)!;

/** 写操作前调用：确定未登录时跳登录页并返回 false，登录后回到当前页。还在确认身份时放行，服务端会把关。 */
export function useRequireLogin() {
  const me = useMe();
  const navigate = useNavigate();
  const here = useHere();
  return () => {
    if (me.data !== null) return true;
    navigate(loginPath(here));
    return false;
  };
}

export function useHere() {
  const { pathname, search } = useLocation();
  return pathname + search;
}

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const nextId = useRef(0);

  const toast = (message: string) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, message }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4000);
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts">
        {toasts.map((item) => <div key={item.id} className="toast" role="alert">{item.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

function fetchMe(signal?: AbortSignal) {
  return api.getMe(signal).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') return null;
    throw error;
  });
}

function MeProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { setData, ...state } = useAsync(fetchMe, []);
  const latestRefresh = useRef(0);
  const [epoch, setEpoch] = useState(0);

  /** 不经过加载态，已显示的内容保持挂载；失败时保留旧数据并提示。 */
  async function refreshMe() {
    const refresh = ++latestRefresh.current;
    try {
      const me = await fetchMe();
      if (refresh === latestRefresh.current) setData(me);
    } catch (error) {
      toast((error as Error).message);
    }
  }

  function signIn(me: CurrentUser) {
    setData(me);
    setEpoch((value) => value + 1);
  }

  async function signOut() {
    await api.logout();
    setData(null);
    setEpoch((value) => value + 1);
  }

  return <MeContext.Provider value={{ ...state, setMe: setData, refreshMe, signIn, signOut, epoch }}>{children}</MeContext.Provider>;
}

/** 厂商与站点目录：导航、卡片标签和倍率高亮都依赖它把 slug 解析成名称。 */
function CatalogProvider({ children }: { children: ReactNode }) {
  const state = useAsync(async (signal): Promise<Catalog> => {
    const [vendors, stations] = await Promise.all([
      api.getVendors(signal),
      api.getStations({ pageSize: 50 }, signal),
    ]);
    return { vendors: vendors.items, stations: stations.items };
  }, []);

  const vendors = state.data?.vendors ?? EMPTY_VENDORS;
  const stations = state.data?.stations ?? EMPTY_STATIONS;
  // 这三个 Map 会被 context 的十几个消费者读到。没有 useMemo 时，
  // Provider 每次渲染都重建它们，value 是个新对象，所有消费者跟着重渲染。
  // 400 个模型时重建一次 261µs；数据没变时完全可以复用。
  const { vendorBySlug, modelBySlug, stationBySlug } = useMemo(() => ({
    vendorBySlug: new Map(vendors.map((vendor) => [vendor.slug, vendor])),
    modelBySlug: new Map(vendors.flatMap((vendor) => vendor.models).map((model) => [model.slug, model])),
    stationBySlug: new Map(stations.map((station) => [station.slug, station])),
  }), [vendors, stations]);
  const value = useMemo(() => ({ ...state, vendorBySlug, modelBySlug, stationBySlug }),
    [state, vendorBySlug, modelBySlug, stationBySlug]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <MeProvider>
        <CatalogProvider>{children}</CatalogProvider>
      </MeProvider>
    </ToastProvider>
  );
}
