import { sb } from './supabase.js';
import { h, icon, toast } from './ui.js';
import { heError } from './errors.js';
import * as store from './store.js';
import { navigate, onRoute, currentPath } from './router.js';
import { savePendingInvite, takePendingInvite, extractToken } from './invite.js';
import { LoginView, RegisterView, ForgotView, ResetView } from './views/auth.js';
import { OnboardingView } from './views/onboarding.js';
import { ListView } from './views/list.js';
import { SettingsView } from './views/settings.js';
import { PrivacyView, TermsView, AccessibilityView } from './views/legal.js';

const root = document.getElementById('app');
const PUBLIC = { '/login': LoginView, '/register': RegisterView, '/forgot': ForgotView };
const LEGAL = { '/privacy': PrivacyView, '/terms': TermsView, '/accessibility': AccessibilityView };

let current = null;
let ready = false;          // first auth check finished
let familiesLoaded = false;
let familiesError = null;
let inviteError = null;
// Password-reset links come back as ?reset=1&code=… ; the flag lives in the URL until the new password is saved.
const inRecovery = () => new URLSearchParams(location.search).has('reset');
let signingOut = false;

function mount(view, title) {
  current?.destroy?.();
  current = view;
  root.replaceChildren(view.el);
  document.title = title ? `${title} · The Bucket` : 'The Bucket';
  window.scrollTo(0, 0);
  // move focus to the page for screen readers / keyboard users, then to the first useful field
  const main = root.querySelector('main');
  if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }); }
  view.focus?.();
}

function loading(text = 'טוען…') {
  return { el: h('div.page.center', h('div.loader', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), h('span', text))) };
}

function errorScreen(err, retry) {
  return { el: h('div.page.center', h('div.card.auth-card', { role: 'alert' },
    icon('alert', 28), h('h1.page-title', 'משהו השתבש'), h('p', heError(err)),
    h('button.btn.btn-primary', { type: 'button', onclick: retry }, icon('refresh', 18), 'נסו שוב'))) };
}

async function refreshFamilies() {
  try { await store.loadFamilies(); familiesError = null; }
  catch (err) { familiesError = err; }
  familiesLoaded = true;
}

async function handleSignedIn(session) {
  store.state.user = session.user;
  const token = takePendingInvite();
  if (token) {
    try {
      const fid = await store.acceptInvitation(token);
      await refreshFamilies();
      store.selectFamily(fid);
      toast(`הצטרפת למשפחה ${store.currentFamily()?.name || ''}`.trim(), { kind: 'success' });
    } catch (err) {
      inviteError = heError(err);
      toast(inviteError, { kind: 'error', timeout: 8000 });
    }
  }
  if (!familiesLoaded) await refreshFamilies();
}

async function route(path = currentPath()) {
  // Invitation link: #/invite/<token>
  if (path.startsWith('/invite/')) {
    const token = extractToken(path);
    if (token) savePendingInvite(token);
    const { data } = await sb.auth.getSession();
    if (data.session) { familiesLoaded = false; await handleSignedIn(data.session); }
    return navigate('/', { replace: true });
  }
  if (LEGAL[path]) return mount(LEGAL[path](), null);
  if (!ready) return mount(loading());

  const user = store.state.user;
  if (inRecovery() && user) return mount(ResetView(), 'סיסמה חדשה');
  if (!user) {
    const View = PUBLIC[path];
    if (View) return mount(View(), null);
    return navigate('/login', { replace: true });
  }
  if (PUBLIC[path]) return navigate('/', { replace: true });

  if (!familiesLoaded) { mount(loading()); await refreshFamilies(); }
  if (familiesError) return mount(errorScreen(familiesError, async () => { familiesLoaded = false; route(); }));

  if (!store.state.families.length) {
    store.stopSync();
    const v = OnboardingView({ inviteError, onJoined: async (fid) => {
      inviteError = null; await refreshFamilies(); store.selectFamily(fid); navigate('/', { replace: true });
    } });
    return mount(v, 'ברוכים הבאים');
  }

  if (path === '/settings') {
    return mount(SettingsView({ onFamiliesChanged: async () => {
      await refreshFamilies(); store.startSync(); navigate('/', { replace: true });
    } }), 'הגדרות');
  }
  if (path !== '/') return navigate('/', { replace: true });

  mount(ListView(), store.currentFamily()?.name);
  if (store.state.sync === 'idle') store.startSync();
}

// Switching family from settings → resubscribe to that family's list
let lastFamily = null;
store.subscribe((s) => {
  if (s.familyId !== lastFamily) {
    lastFamily = s.familyId;
    if (s.familyId && s.user) store.startSync();
  }
});

// ── Auth lifecycle ──
sb.auth.onAuthStateChange((event, session) => {
  // Never await Supabase calls inside this callback (it can deadlock the auth client).
  setTimeout(async () => {
    if (session && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY')) {
      if (store.state.user?.id !== session.user.id) { familiesLoaded = false; await handleSignedIn(session); }
      ready = true;
      route();
    } else if (event === 'USER_UPDATED' && session) {
      store.state.user = session.user;
    } else if (event === 'TOKEN_REFRESHED' && session) {
      store.state.user = session.user;
    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      const wasSignedIn = !!store.state.user;
      store.resetState(); familiesLoaded = false; lastFamily = null;
      ready = true;
      if (wasSignedIn && !signingOut) toast('פג תוקף החיבור. התחברו מחדש.', { kind: 'error', timeout: 6000 });
      signingOut = false;
      route(currentPath());
    }
  }, 0);
});
const realSignOut = sb.auth.signOut.bind(sb.auth);
sb.auth.signOut = async (...a) => { signingOut = true; const r = await realSignOut(...a); return r; };

// Errors Supabase puts in the URL after an email link (expired / already used)
(() => {
  const q = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
  const desc = q.get('error_description');
  if (desc) {
    setTimeout(() => toast(/expired|invalid/i.test(desc) ? 'הקישור פג תוקף או כבר נוצל. בקשו קישור חדש.' : heError(desc), { kind: 'error', timeout: 8000 }), 300);
    history.replaceState(null, '', location.pathname + '#/login');
  }
})();

// ── Connectivity ──
const offline = document.getElementById('offline');
function updateOnline() {
  offline.hidden = navigator.onLine;
  if (navigator.onLine && store.state.familyId && store.state.user) store.fetchItems().catch(() => {});
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.state.familyId && store.state.user) {
    if (store.state.sync !== 'live') store.startSync(); else store.fetchItems().catch(() => {});
  }
});
offline.replaceChildren(icon('wifiOff', 18), h('span', 'אין חיבור לאינטרנט. שינויים לא יישמרו עד שהחיבור יחזור.'));
updateOnline();

onRoute(route);
route();
