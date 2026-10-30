import { h, icon, busy, fieldError, toast, confirmDialog, openDialog, fmtDate, bdi } from '../ui.js';
import { heError } from '../errors.js';
import * as store from '../store.js';
import { sb } from '../supabase.js';
import { navigate } from '../router.js';
import { inviteLink } from '../invite.js';

export function SettingsView({ onFamiliesChanged }) {
  const fam = store.currentFamily();
  const me = store.state.user;
  const isOwner = fam.role === 'owner';

  // ── Family name ──
  const nameIn = h('input.input#fam-name', { value: fam.name, maxlength: 60, disabled: !isOwner });
  const nameBtn = h('button.btn.btn-secondary', { type: 'submit' }, 'שמירה');
  const nameForm = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = nameIn.value.trim();
    if (!v) return fieldError(nameForm, 'השם לא יכול להיות ריק.');
    busy(nameBtn, async () => {
      try { await store.renameFamily(fam.id, v); fieldError(nameForm, ''); toast('השם עודכן', { kind: 'success' }); }
      catch (err) { fieldError(nameForm, heError(err)); }
    });
  } },
  h('div.field', h('label', { for: 'fam-name' }, 'שם המשפחה'),
    isOwner ? h('div.inline-form', nameIn, nameBtn) : nameIn,
    !isOwner && h('p.hint', 'רק בעלי המשפחה יכולים לשנות את השם.')));

  // ── Members ──
  const membersList = h('ul.rows', { 'aria-busy': 'true' }, h('li.muted', 'טוען…'));
  let members = [];
  async function loadMembers() {
    try {
      members = await store.listMembers(fam.id);
      membersList.removeAttribute('aria-busy');
      membersList.replaceChildren(...members.map((m) => h('li.row',
        h('div.row-main',
          h('span.row-title', bdi(m.email), m.user_id === me.id && h('span.muted', ' (את/ה)')),
          h('span.badge', { class: m.role === 'owner' ? 'badge-owner' : '' },
            m.role === 'owner' && icon('crown', 14), m.role === 'owner' ? 'בעלים' : 'חבר/ה')),
        isOwner && m.user_id !== me.id && h('div.row-actions',
          h('button.btn.btn-text', { type: 'button', onclick: () => transfer(m) }, 'העברת בעלות'),
          h('button.btn.btn-text.btn-danger-text', { type: 'button', onclick: () => remove(m) }, 'הסרה')))));
    } catch (err) {
      membersList.replaceChildren(h('li.form-error', heError(err)));
    }
  }
  async function transfer(m) {
    const yes = await confirmDialog({ title: 'להעביר את הבעלות?', message: `${m.email} יהפוך לבעלים של המשפחה, ואת/ה תהיה חבר/ה רגיל/ה. רק הבעלים החדש יוכל להחזיר אותה.`, confirmLabel: 'העברה' });
    if (!yes) return;
    try { await store.transferOwnership(fam.id, m.user_id); toast('הבעלות הועברה', { kind: 'success' }); await onFamiliesChanged(); }
    catch (err) { toast(heError(err), { kind: 'error' }); }
  }
  async function remove(m) {
    const yes = await confirmDialog({ title: 'להסיר מהמשפחה?', message: `${m.email} יאבד את הגישה לרשימה.`, confirmLabel: 'הסרה', danger: true });
    if (!yes) return;
    try { await store.removeMember(fam.id, m.user_id); toast('החבר הוסר'); loadMembers(); }
    catch (err) { toast(heError(err), { kind: 'error' }); }
  }

  // ── Invitations (owner only) ──
  const invList = h('ul.rows');
  const created = h('div');
  async function loadInvites() {
    try {
      const all = await store.listInvitations(fam.id);
      const pending = all.filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date());
      invList.replaceChildren(...(pending.length ? pending.map((i) => h('li.row',
        h('div.row-main',
          h('span.row-title', bdi(i.email)),
          h('span.muted.small', 'בתוקף עד ', fmtDate(i.expires_at))),
        h('div.row-actions',
          h('button.btn.btn-text.btn-danger-text', { type: 'button', onclick: async (e) => {
            const btn = e.currentTarget;
            const yes = await confirmDialog({ title: 'לבטל את ההזמנה?', message: `הקישור שנשלח אל ${i.email} יפסיק לעבוד.`, confirmLabel: 'ביטול ההזמנה', danger: true });
            if (!yes) return;
            try { await busy(btn, () => store.revokeInvitation(i.id)); toast('ההזמנה בוטלה'); created.replaceChildren(); loadInvites(); }
            catch (err) { toast(heError(err), { kind: 'error' }); }
          } }, 'ביטול'))))
        : [h('li.muted', 'אין הזמנות ממתינות.')]));
    } catch (err) { invList.replaceChildren(h('li.form-error', heError(err))); }
  }
  const invEmail = h('input.input#inv-email', { type: 'email', dir: 'ltr', inputmode: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
  const invBtn = h('button.btn.btn-primary', { type: 'submit' }, icon('send', 18), 'יצירת הזמנה');
  const invForm = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = invEmail.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return fieldError(invForm, 'הזינו כתובת מייל תקינה.');
    busy(invBtn, async () => {
      try {
        const inv = await store.createInvitation(fam.id, v);
        fieldError(invForm, ''); invEmail.value = '';
        const link = inviteLink(inv.token);
        const linkIn = h('input.input.mono', { value: link, readonly: true, dir: 'ltr', 'aria-label': 'קישור ההזמנה', onfocus: (ev) => ev.target.select() });
        created.replaceChildren(h('div.invite-result', { role: 'status' },
          h('p', h('strong', 'ההזמנה נוצרה. '), 'המייל ', h('strong', 'לא'), ' נשלח אוטומטית. העתיקו את הקישור ושלחו אותו אל ', bdi(v), ' בוואטסאפ, SMS או מייל.'),
          linkIn,
          h('div.btn-row',
            h('button.btn.btn-secondary', { type: 'button', onclick: async () => {
              try { await navigator.clipboard.writeText(link); toast('הקישור הועתק', { kind: 'success' }); }
              catch { linkIn.focus(); toast('סמנו את הקישור והעתיקו ידנית'); }
            } }, icon('copy', 18), 'העתקת הקישור'),
            navigator.share && h('button.btn.btn-secondary', { type: 'button', onclick: () =>
              navigator.share({ title: 'הזמנה ל-The Bucket', text: `הזמנה להצטרף לרשימת הקניות של ${fam.name}`, url: link }).catch(() => {}) },
            icon('send', 18), 'שיתוף')),
          h('p.muted.small', 'הקישור תקף ל־7 ימים, עובד רק עבור ', bdi(v), ' ורק פעם אחת. אנחנו לא שומרים אותו, אז שלחו אותו עכשיו.')));
        loadInvites();
      } catch (err) { fieldError(invForm, heError(err)); }
    });
  } },
  h('div.field', h('label', { for: 'inv-email' }, 'מייל של בן/בת המשפחה'), h('div.inline-form', invEmail, invBtn)));

  // ── Danger zone ──
  const danger = isOwner
    ? h('button.btn.btn-danger-outline', { type: 'button', onclick: deleteFamily }, icon('trash', 18), 'מחיקת המשפחה')
    : h('button.btn.btn-danger-outline', { type: 'button', onclick: leave }, icon('logout', 18), 'עזיבת המשפחה');

  async function leave() {
    const yes = await confirmDialog({ title: 'לעזוב את המשפחה?', message: 'תאבדו את הגישה לרשימה. כדי לחזור תצטרכו הזמנה חדשה.', confirmLabel: 'עזיבה', danger: true });
    if (!yes) return;
    try { await store.leaveFamily(fam.id); toast('עזבת את המשפחה'); await onFamiliesChanged(); }
    catch (err) { toast(heError(err), { kind: 'error' }); }
  }
  function deleteFamily() {
    const confirmIn = h('input.input#del-confirm', { autocomplete: 'off' });
    const err = h('p.form-error', { role: 'alert', hidden: true });
    const go = h('button.btn.btn-danger', { type: 'button', onclick: async () => {
      try { await busy(go, () => store.deleteFamily(fam.id, confirmIn.value)); dlg.close(); toast('המשפחה נמחקה'); await onFamiliesChanged(); }
      catch (e) { err.hidden = false; err.textContent = heError(e); }
    } }, 'מחיקה לצמיתות');
    const dlg = openDialog({
      title: 'מחיקת המשפחה',
      body: h('div.stack', err,
        h('p', 'המשפחה, כל הרשימה וכל ההזמנות יימחקו לצמיתות, וכל החברים יאבדו גישה. אי אפשר לבטל.'),
        h('div.field', h('label', { for: 'del-confirm' }, 'לאישור, הקלידו את שם המשפחה: ', h('strong', fam.name)), confirmIn)),
      actions: [h('button.btn.btn-secondary', { type: 'button', onclick: () => dlg.close() }, 'ביטול'), go],
    });
  }

  // ── Victory branch for prices ──
  const priceBox = h('div.stack');
  async function renderPrices() {
    if (fam.priceStoreId && !store.state.priceStore) await store.loadPrices();
    const ps = store.state.priceStore;
    const rows = [];
    if (fam.priceStoreId && ps) {
      rows.push(h('p', 'הסניף שלכם: ', h('strong', bdi(ps.name)), ps.city ? ` · ${ps.city}` : ''));
      const at = await store.priceStatus().catch(() => null);
      rows.push(h('p.muted.small', at ? `המחירים עודכנו לאחרונה: ${fmtDate(at)}` : 'המחירים לסניף הזה עוד לא נטענו. הם יופיעו אחרי העדכון היומי הבא.'));
    } else {
      rows.push(h('p.muted', 'בחרו את סניף ויקטורי שבו אתם קונים, ותראו ליד כל מוצר את המחיר שלו ואת הסכום המשוער של הרשימה.'));
    }
    if (isOwner) rows.push(h('button.btn.btn-secondary.align-start', { type: 'button', onclick: pickStore }, fam.priceStoreId ? 'החלפת סניף' : 'בחירת סניף'));
    else if (!fam.priceStoreId) rows.push(h('p.hint', 'רק בעלי המשפחה יכולים לבחור סניף.'));
    rows.push(h('p.hint', 'המחירים מגיעים מהקבצים הרשמיים שהרשת מפרסמת לפי חוק שקיפות המחירים. הם עשויים להיות שונים מהמחיר בקופה, ומבצעים לא נכללים.'));
    priceBox.replaceChildren(...rows);
  }
  function pickStore() {
    const q = h('input.input#store-q', { type: 'search', autocomplete: 'off', placeholder: 'עיר או שם סניף', 'aria-label': 'חיפוש סניף' });
    const list = h('ul.match-list', { 'aria-live': 'polite' });
    let timer, seq = 0;
    async function run() {
      const my = ++seq;
      list.replaceChildren(h('li.muted', 'מחפש…'));
      try {
        const stores = await store.searchStores(q.value);
        if (my !== seq) return;
        list.replaceChildren(...(stores.length ? stores.map((st) => h('li',
          h('button.match-row', { type: 'button', onclick: async (e) => {
            try {
              await busy(e.currentTarget, () => store.setFamilyStore(fam.id, st.chain_id, st.store_id));
              fam.priceStoreId = st.store_id; fam.priceChainId = st.chain_id;
              dlg.close(); toast('הסניף נשמר', { kind: 'success' });
              setTimeout(renderPrices, 400);
            } catch (err) { toast(heError(err), { kind: 'error' }); }
          } },
          h('span.match-main', h('span.match-name', bdi(st.name)), h('span.muted.small', [st.city, st.address].filter(Boolean).join(' · '))))))
          : [h('li.muted', q.value.trim() ? 'לא נמצאו סניפים.' : 'רשימת הסניפים עוד לא נטענה. היא תופיע אחרי העדכון הראשון של המחירים.')]));
      } catch (err) { if (my === seq) list.replaceChildren(h('li.form-error', heError(err))); }
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    const dlg = openDialog({
      title: 'בחירת סניף ויקטורי',
      body: h('div.stack', q, list),
      actions: [
        fam.priceStoreId && h('button.btn.btn-text.btn-danger-text', { type: 'button', onclick: async () => {
          try { await store.setFamilyStore(fam.id, null, null); fam.priceStoreId = null; dlg.close(); renderPrices(); } catch (err) { toast(heError(err), { kind: 'error' }); }
        } }, 'ביטול הסניף'),
        h('button.btn.btn-secondary', { type: 'button', onclick: () => dlg.close() }, 'סגירה'),
      ].filter(Boolean),
    });
    q.focus(); run();
  }

  // ── Family switcher (only if the user belongs to more than one) ──
  const switcher = store.state.families.length > 1 && h('section.card',
    h('h2.section-title', 'המשפחות שלי'),
    h('ul.rows', store.state.families.map((f) => h('li.row',
      h('div.row-main', h('span.row-title', f.name), f.id === fam.id && h('span.badge', 'פעילה')),
      f.id !== fam.id && h('div.row-actions', h('button.btn.btn-text', { type: 'button', onclick: () => { store.selectFamily(f.id); navigate('/'); } }, 'מעבר'))))));

  const view = h('div.page',
    h('header.app-header.app-header-sub',
      h('div.brand-row',
        h('button.icon-btn', { type: 'button', 'aria-label': 'חזרה לרשימה', onclick: () => navigate('/') }, icon('arrowRight', 22)),
        h('h1.page-title', 'הגדרות'))),
    h('main.content.settings#main',
      h('section.card', h('h2.section-title', icon('users', 20), 'המשפחה'), nameForm),
      h('section.card', h('h2.section-title', 'מחירים מוויקטורי'), priceBox),
      switcher,
      h('section.card', h('h2.section-title', 'חברי המשפחה'), membersList),
      isOwner && h('section.card',
        h('h2.section-title', icon('mail', 20), 'הזמנת בני משפחה'),
        invForm, created,
        h('h3.subsection-title', 'הזמנות ממתינות'), invList),
      h('section.card',
        h('h2.section-title', 'החשבון שלי'),
        h('p', 'מחובר/ת בתור ', h('strong', bdi(me.email))),
        h('button.btn.btn-secondary', { type: 'button', onclick: async (e) => {
          await busy(e.currentTarget, async () => { await sb.auth.signOut(); });
        } }, icon('logout', 18), 'יציאה מהחשבון')),
      h('section.card.danger-zone',
        h('h2.section-title', 'אזור רגיש'),
        h('p.muted.small', isOwner
          ? 'בעלי המשפחה לא יכולים לעזוב אותה. כדי לעזוב, העבירו קודם את הבעלות לחבר אחר, או מחקו את המשפחה.'
          : 'עזיבה תסיר את הגישה שלך לרשימה המשותפת.'),
        danger),
      h('nav.legal-links', { 'aria-label': 'מידע משפטי' },
        h('a', { href: '#/privacy' }, 'מדיניות פרטיות'),
        h('a', { href: '#/terms' }, 'תנאי שימוש'),
        h('a', { href: '#/accessibility' }, 'הצהרת נגישות'))));

  loadMembers();
  renderPrices();
  if (isOwner) loadInvites();
  return { el: view, focus: () => {} };
}
