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
    .select('role, families ( id, name )')
    .eq('user_id', state.user.id);
  if (error) throw error;
  state.families = (data || []).filter((r) => r.families)
    .map((r) => ({ id: r.families.id, name: r.families.name, role: r.role }))
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
  const { data, error } = await sb.from('shopping_items')
    .insert({ family_id: state.familyId, name: optimistic.name, quantity: optimistic.quantity, category, client_ref })
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
  Object.assign(state, { user: null, families: [], familyId: null, items: new Map(), pending: new Map(), loadError: null });
  emit();
}
