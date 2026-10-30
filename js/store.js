// Shared-list data layer. The database is the source of truth; this is only an in-memory view of it.
import { sb } from './supabase.js';

const PREF_KEY = 'bucket.currentFamily'; // harmless UI preference only

export const state = {
  user: null,
  families: [],          // [{ id, name, role }]
  familyId: null,
  items: new Map(),      // id -> row (confirmed by the database)
  pending: new Map(),    // client_ref -> optimistic row not yet confirmed
  sync: 'idle',          // 'idle' | 'loading' | 'live' | 'reconnecting' | 'error'
  prices: new Map(),     // item_code -> price_products row, for the family's chosen branch
  links: new Map(),      // name key -> item_code (remembered product choices)
  priceStore: null,      // { chain_id, store_id, name, city } of the chosen branch
  loadError: null,
};

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn(state));

export const currentFamily = () => state.families.find((f) => f.id === state.familyId) || null;

// ───────── Families ─────────
export async function loadFamilies() {
  const { data, error } = await sb
    .from('family_members')
    .select('role, families ( id, name, price_chain_id, price_store_id )')
    .eq('user_id', state.user.id);
  if (error) throw error;
  state.families = (data || []).filter((r) => r.families)
    .map((r) => ({ id: r.families.id, name: r.families.name, role: r.role,
      priceChainId: r.families.price_chain_id, priceStoreId: r.families.price_store_id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  let pref = null;
  try { pref = localStorage.getItem(PREF_KEY); } catch { /* storage unavailable */ }
  state.familyId = state.families.some((f) => f.id === pref) ? pref : state.families[0]?.id ?? null;
  emit();
  return state.families;
}

export function selectFamily(id) {
  state.familyId = id;
  try { localStorage.setItem(PREF_KEY, id); } catch { /* ignore */ }
  emit();
}

// ───────── Items ─────────
const newer = (a, b) => !a || new Date(b.updated_at) >= new Date(a.updated_at);

function applyRow(row) {
  if (row.family_id !== state.familyId) return;
  if (row.client_ref) state.pending.delete(row.client_ref);
  if (newer(state.items.get(row.id), row)) state.items.set(row.id, row);
  if (row.item_code && !state.prices.has(row.item_code)) refreshPrices();
}

export async function fetchItems() {
  const fid = state.familyId;
  if (!fid) return;
  const { data, error } = await sb.from('shopping_items').select('*').eq('family_id', fid).order('created_at');
  if (fid !== state.familyId) return; // family switched meanwhile
  if (error) { state.loadError = error; emit(); throw error; }
  state.loadError = null;
  state.items = new Map(data.map((r) => [r.id, r]));
  for (const r of data) if (r.client_ref) state.pending.delete(r.client_ref);
  emit();
  refreshPrices();
}

let channel = null;
let retryTimer = null;

export async function startSync() {
  stopSync();
  const fid = state.familyId;
  if (!fid) return;
  state.sync = 'loading'; state.items = new Map(); state.pending = new Map(); emit();
  try { await fetchItems(); } catch { state.sync = 'error'; emit(); }

  channel = sb.channel(`items:${fid}:${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'shopping_items', filter: `family_id=eq.${fid}` },
      (p) => { applyRow(p.new); emit(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shopping_items', filter: `family_id=eq.${fid}` },
      (p) => { applyRow(p.new); emit(); })
    // Delete events can't be filtered by family; they only carry the id, so we just drop it if we have it.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'shopping_items' },
      (p) => { if (p.old?.id && state.items.delete(p.old.id)) emit(); })
    .subscribe(async (status) => {
      if (fid !== state.familyId) return;
      if (status === 'SUBSCRIBED') {
        clearTimeout(retryTimer);
        // catch up on anything missed while disconnected
        try { await fetchItems(); state.sync = 'live'; } catch { state.sync = 'error'; }
        emit();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (channel && status !== 'CLOSED') {
          state.sync = 'reconnecting'; emit();
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { if (fid === state.familyId) startSync(); }, 4000);
        }
      }
    });
}

export function stopSync() {
  clearTimeout(retryTimer);
  if (channel) { const c = channel; channel = null; sb.removeChannel(c); }
  state.sync = 'idle';
}

/** All items to display: confirmed rows plus optimistic ones still in flight. */
export function visibleItems() {
  return [...state.items.values(), ...state.pending.values()];
}

export async function addItem({ name, quantity, category }) {
  const client_ref = crypto.randomUUID();
  const optimistic = {
    id: `pending:${client_ref}`, client_ref, family_id: state.familyId, name: name.trim(),
    quantity: quantity?.trim() || null, category, purchased: false, pending: true,
    created_at: new Date().toISOString(), updated_at: new Date(0).toISOString(),
  };
  state.pending.set(client_ref, optimistic); emit();
  const item_code = state.links.get(nameKey(optimistic.name)) || null; // remembered product for this name
  const { data, error } = await sb.from('shopping_items')
    .insert({ family_id: state.familyId, name: optimistic.name, quantity: optimistic.quantity, category, client_ref, item_code })
    .select().single();
  if (error) {
    // a retry of the same client_ref would hit the unique constraint; treat as success and refetch
    state.pending.delete(client_ref); emit();
    throw error;
  }
  applyRow(data); emit();
  return data;
}

async function patch(id, changes) {
  const before = state.items.get(id);
  if (!before) return;
  state.items.set(id, { ...before, ...changes }); emit();
  const { data, error } = await sb.from('shopping_items').update(changes).eq('id', id).select().maybeSingle();
  if (error || !data) {
    state.items.set(id, before); emit();
    throw error || new Error('NOT_FOUND');
  }
  applyRow(data); emit();
  return data;
}

export const setPurchased = (id, purchased) => patch(id, { purchased });
export const updateItem = (id, { name, quantity, category }) =>
  patch(id, { name: name.trim(), quantity: quantity?.trim() || null, category });

export async function deleteItem(id) {
  const before = state.items.get(id);
  state.items.delete(id); emit();
  const { error } = await sb.from('shopping_items').delete().eq('id', id);
  if (error) { if (before) state.items.set(id, before); emit(); throw error; }
}

export async function clearPurchased() {
  const ids = [...state.items.values()].filter((i) => i.purchased).map((i) => i.id);
  if (!ids.length) return 0;
  const backup = ids.map((id) => state.items.get(id));
  ids.forEach((id) => state.items.delete(id)); emit();
  const { error } = await sb.from('shopping_items').delete().in('id', ids).eq('purchased', true);
  if (error) { backup.forEach((r) => state.items.set(r.id, r)); emit(); throw error; }
  return ids.length;
}

// ───────── Family / membership RPCs ─────────
const rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
};
export const createFamily = (name) => rpc('create_family', { p_name: name });
export const acceptInvitation = (token) => rpc('accept_invitation', { p_token: token });
export const listMembers = (fid) => rpc('list_family_members', { p_family_id: fid });
export const createInvitation = async (fid, email) => (await rpc('create_invitation', { p_family_id: fid, p_email: email }))[0];
export const revokeInvitation = (id) => rpc('revoke_invitation', { p_invitation_id: id });
export const removeMember = (fid, uid) => rpc('remove_member', { p_family_id: fid, p_user_id: uid });
export const leaveFamily = (fid) => rpc('leave_family', { p_family_id: fid });
export const transferOwnership = (fid, uid) => rpc('transfer_ownership', { p_family_id: fid, p_new_owner: uid });
export const deleteFamily = (fid, name) => rpc('delete_family', { p_family_id: fid, p_confirm_name: name });

export async function renameFamily(fid, name) {
  const { error } = await sb.from('families').update({ name: name.trim() }).eq('id', fid);
  if (error) throw error;
  const f = state.families.find((x) => x.id === fid);
  if (f) f.name = name.trim();
  emit();
}

export async function listInvitations(fid) {
  const { data, error } = await sb.from('family_invitations')
    .select('id, email, created_at, expires_at, accepted_at, revoked_at')
    .eq('family_id', fid).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export function resetState() {
  stopSync();
  Object.assign(state, { user: null, families: [], familyId: null, items: new Map(), pending: new Map(), loadError: null,
    prices: new Map(), links: new Map(), priceStore: null });
  emit();
}

// ───────── Prices (Victory, official price-transparency files) ─────────
export const VICTORY_CHAINS = ['7290696200003', '7290058103393'];
export const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 80);

/** Leading number in a free-text quantity: "2" → 2, "1.5 ק״ג" → 1.5, "" → 1 */
export function qtyNumber(q) {
  const m = String(q || '').replace(',', '.').match(/\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : 1;
  return n > 0 && n < 1000 ? n : 1;
}

let priceTimer = null;
/** Reload the branch, remembered links and the prices of linked items (debounced). */
export function refreshPrices() {
  clearTimeout(priceTimer);
  priceTimer = setTimeout(loadPrices, 150);
}

export async function loadPrices() {
  const fam = currentFamily();
  if (!fam) return;
  const fid = fam.id;
  try {
    const { data: links } = await sb.from('family_item_links').select('name_key, item_code').eq('family_id', fid);
    if (fid !== state.familyId) return;
    state.links = new Map((links || []).map((l) => [l.name_key, l.item_code]));
    if (!fam.priceStoreId) { state.priceStore = null; state.prices = new Map(); emit(); return; }
    if (!state.priceStore || state.priceStore.store_id !== fam.priceStoreId || state.priceStore.chain_id !== fam.priceChainId) {
      const { data: st } = await sb.from('price_stores').select('chain_id, store_id, name, city, address')
        .eq('chain_id', fam.priceChainId).eq('store_id', fam.priceStoreId).maybeSingle();
      state.priceStore = st || { chain_id: fam.priceChainId, store_id: fam.priceStoreId, name: `סניף ${fam.priceStoreId}` };
      state.prices = new Map();
    }
    const codes = [...new Set([...state.items.values()].map((i) => i.item_code).filter(Boolean))];
    if (codes.length) {
      const { data } = await sb.from('price_products')
        .select('item_code, name, manufacturer, price, unit_price, unit_of_measure, unit_qty, quantity, is_weighted, imported_at')
        .eq('chain_id', fam.priceChainId).eq('store_id', fam.priceStoreId).in('item_code', codes);
      if (fid !== state.familyId) return;
      state.prices = new Map((data || []).map((p) => [p.item_code, p]));
    }
    emit();
  } catch { /* prices are optional; the list keeps working without them */ }
}

/** Price info for one list item, or null. */
export function itemPrice(item) {
  if (!state.priceStore || !item.item_code) return null;
  const p = state.prices.get(item.item_code);
  if (!p) return { missing: true };
  const n = qtyNumber(item.quantity);
  return { product: p, each: Number(p.price), total: Number(p.price) * n, qty: n, weighted: p.is_weighted };
}

/** Estimated total of the items still needed. */
export function listTotal() {
  let sum = 0, priced = 0, count = 0;
  for (const i of state.items.values()) {
    if (i.purchased) continue;
    count++;
    const p = itemPrice(i);
    if (p && !p.missing) { sum += p.total; priced++; }
  }
  return { sum, priced, count };
}

export async function searchProducts(query) {
  const st = state.priceStore;
  if (!st) return [];
  const { data, error } = await sb.rpc('search_price_products', { p_chain_id: st.chain_id, p_store_id: st.store_id, p_query: query, p_limit: 25 });
  if (error) throw error;
  return data || [];
}

/** Link a list item to a catalog product, and remember the choice for next time. */
export async function linkItem(item, product, remember = true) {
  await patch(item.id, { item_code: product ? product.item_code : null });
  if (product) state.prices.set(product.item_code, product);
  const k = nameKey(item.name);
  if (remember && product) {
    const { error } = await sb.from('family_item_links')
      .upsert({ family_id: state.familyId, name_key: k, item_code: product.item_code, updated_at: new Date().toISOString() });
    if (!error) state.links.set(k, product.item_code);
  } else if (!product) {
    await sb.from('family_item_links').delete().eq('family_id', state.familyId).eq('name_key', k);
    state.links.delete(k);
  }
  emit();
}

export async function searchStores(query) {
  let q = sb.from('price_stores').select('chain_id, store_id, name, city, address').in('chain_id', VICTORY_CHAINS)
    .order('city').order('name').limit(60);
  const t = String(query || '').trim();
  if (t) q = q.or(`name.ilike.%${t.replace(/[%,()]/g, '')}%,city.ilike.%${t.replace(/[%,()]/g, '')}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function priceStatus() {
  const st = state.priceStore;
  if (!st) return null;
  const { data } = await sb.from('price_products').select('imported_at').eq('chain_id', st.chain_id).eq('store_id', st.store_id)
    .order('imported_at', { ascending: false }).limit(1);
  return data?.[0]?.imported_at || null;
}

export async function setFamilyStore(fid, chainId, storeId) {
  const { error } = await sb.rpc('set_family_store', { p_family_id: fid, p_chain_id: chainId, p_store_id: storeId });
  if (error) throw error;
  const f = state.families.find((x) => x.id === fid);
  if (f) { f.priceChainId = storeId ? chainId : null; f.priceStoreId = storeId; }
  state.priceStore = null; state.prices = new Map();
  refreshPrices();
}
