import { createClient } from '@supabase/supabase-js';

export const emptyState = () => ({ attendees: [], products: [], transactions: [], productStats: [], sellerStats: [], sellerProductStats: [], totalRevenue: 0, totalOrders: 0, payments: {} });
let client = null;
let timer = null;
let realtimeChannel = null;
let refreshing = null;
let queuedRefresh = false;
let changed = () => {};
export let state = emptyState();
export let connected = false;
export let connectionMessage = 'Conectando con Supabase…';
export let pending = null;

export function getConfig() { return window.FIESTAS_CONFIG || null; }
export function validateConfig(config) {
  if (!config?.supabaseUrl || !config?.supabaseKey) throw new Error('Falta configurar Supabase en el archivo .env.');
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('La URL de Supabase no es válida.');
  const key = config.supabaseKey.trim();
  if (key.startsWith('sb_secret_')) throw new Error('Usa la clave pública publishable; nunca una clave secreta.');
  if (!key.startsWith('sb_publishable_')) {
    try {
      const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') throw new Error();
    } catch { throw new Error('Usa una clave pública publishable o anon válida.'); }
  }
  return { supabaseUrl: url.origin, supabaseKey: key };
}
export function subscribe(callback) { changed = callback; }
function pendingKey() { return `fiestas_pending_${client?.supabaseUrl}`; }
function savePending(value) {
  if (value) sessionStorage.setItem(pendingKey(), JSON.stringify(value));
  else sessionStorage.removeItem(pendingKey());
  pending = value;
}

export async function refresh() {
  if (!client) return;
  if (refreshing) { queuedRefresh = true; return refreshing; }
  refreshing = (async () => {
    try {
      const { data, error } = await client.rpc('fiestas_snapshot');
      if (error) throw error;
      state = {
        ...data,
        products: data.products.map((product) => product.id === 'terremoto' ? { ...product, name: 'Terremoto' } : product),
        transactions: data.transactions.map((sale) => ({
          ...sale,
          items: sale.items.map((item) => item.id === 'terremoto' ? { ...item, name: 'Terremoto' } : item)
        }))
      };
      connected = true;
      connectionMessage = `Actualizado ${new Date().toLocaleTimeString('es-CL')}`;
    } catch (error) {
      // Never display a stale student list or stale revenue as current data.
      state = emptyState();
      connected = false;
      connectionMessage = error.code === 'PGRST202' ? 'Falta ejecutar el código SQL en Supabase.' : 'No se pudo conectar. Revisa Supabase antes de vender.';
    } finally { changed(); }
  })();
  try { await refreshing; } finally {
    refreshing = null;
    if (queuedRefresh) { queuedRefresh = false; void refresh(); }
  }
}

export async function initialize(config) {
  const valid = validateConfig(config);
  client = createClient(valid.supabaseUrl, valid.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey())); } catch { pending = null; }
  if (realtimeChannel) await client.removeChannel(realtimeChannel);
  realtimeChannel = client.channel('fiestas-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fiestas_attendees' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fiestas_products' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fiestas_sales' }, () => void refresh())
    .subscribe();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
  window.addEventListener('offline', () => { connected = false; connectionMessage = 'Sin conexión. Las ventas están pausadas.'; changed(); });
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  await refresh();
}

export async function operate(kind, payload) {
  if (!connected || !navigator.onLine) throw new Error('Conéctate y actualiza la información antes de registrar.');
  if (pending && (pending.kind !== kind || JSON.stringify(pending.payload) !== JSON.stringify(payload))) throw new Error('Hay un guardado pendiente. Usa «Reintentar guardado» antes de continuar.');
  savePending(pending || { key: crypto.randomUUID(), kind, payload });
  const request = pending;
  try {
    const { data, error } = await client.rpc('fiestas_operate', { p_key: request.key, p_kind: kind, p_payload: payload });
    if (error) {
      if (error.code && !error.code.startsWith('PGRST0')) savePending(null);
      throw error;
    }
    savePending(null);
    await refresh();
    return data;
  } catch (error) {
    if (pending) throw new Error('No se pudo confirmar el guardado. Reintenta la misma operación; no se duplicará.');
    await refresh();
    throw new Error(error.message || 'No se pudo guardar la operación.');
  } finally { changed(); }
}
