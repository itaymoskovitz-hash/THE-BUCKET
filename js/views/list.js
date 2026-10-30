import { h, icon, toast, openDialog, confirmDialog, busy, bdi } from '../ui.js';
import { CATEGORIES, categorize, categoryName, QUICK_ADD, sameName } from '../categories.js';
import { heError } from '../errors.js';
import * as store from '../store.js';
import { navigate } from '../router.js';

const inFlight = new Set(); // normalized names currently being added (blocks double taps)
// Categories the user opened. Kept only in memory, so every new visit to the app starts with all categories closed.
const openCats = new Set();
const key = (s) => s.trim().replace(/\s+/g, ' ');
const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });
const money = (n) => ils.format(n);

export function ListView() {
  const fam = store.currentFamily();
  const stats = h('div.stats', { 'aria-live': 'polite' });
  const totalLine = h('p.total-line', { hidden: true });
  const syncBar = h('div.sync-bar', { role: 'status' });
  const listHost = h('div.list-host');
  const chips = h('div.chips', { role: 'group', 'aria-label': 'הוספה מהירה' });

  // ── Add form ──
  const nameIn = h('input.input.input-lg#item-name', {
    type: 'text', name: 'name', autocomplete: 'off', enterkeyhint: 'done', maxlength: 80,
    placeholder: 'מה צריך לקנות?', 'aria-label': 'שם המוצר', required: true,
  });
  const qtyIn = h('input.input#item-qty', { type: 'text', name: 'qty', maxlength: 20, inputmode: 'text', placeholder: 'למשל 2 או 1 ק״ג' });
  const autoOpt = h('option', { value: '0' }, 'אוטומטי');
  const catSel = h('select.input#item-cat', { name: 'cat' }, autoOpt,
    CATEGORIES.map((c) => h('option', { value: String(c.id) }, c.name)));
  const addBtn = h('button.btn.btn-primary.btn-add', { type: 'submit' }, icon('plus', 22), h('span', 'הוספה'));
  nameIn.addEventListener('input', () => {
    autoOpt.textContent = nameIn.value.trim() ? `אוטומטי · ${categoryName(categorize(nameIn.value))}` : 'אוטומטי';
  });

  const form = h('form.add-form', { onsubmit: async (e) => {
    e.preventDefault();
    const name = key(nameIn.value);
    if (!name) { nameIn.focus(); return; }
    const cat = Number(catSel.value) || categorize(name);
    const ok = await add(name, qtyIn.value, cat, addBtn);
    if (ok) {
      nameIn.value = ''; qtyIn.value = ''; catSel.value = '0'; autoOpt.textContent = 'אוטומטי';
      nameIn.focus();
    }
  } },
  h('div.add-row', nameIn, addBtn),
  h('div.add-extra',
    h('label.field-inline', h('span', 'כמות'), qtyIn),
    h('label.field-inline', h('span', 'קטגוריה'), catSel)));

  let holdTimer;
  form.addEventListener('focusout', () => {
    form.classList.add('hold'); clearTimeout(holdTimer);
    holdTimer = setTimeout(() => form.classList.remove('hold'), 400);
  });

  async function add(name, quantity, category, btn) {
    const k = key(name).toLowerCase();
    if (inFlight.has(k)) return false;
    const existing = store.visibleItems().find((i) => sameName(i.name, name));
    if (existing && !existing.purchased) {
      toast(`״${existing.name}״ כבר ברשימה`);
      if (!openCats.has(existing.category)) { openCats.add(existing.category); renderList(); }
      flash(existing.id);
      return true;
    }
    inFlight.add(k); renderChips();
    openCats.add(existing ? existing.category : category); // show the item you just added
    try {
      if (existing && existing.purchased) {
        await store.setPurchased(existing.id, false);
        toast(`״${existing.name}״ הוחזר לרשימה`, { kind: 'success' });
      } else {
        await (btn ? busy(btn, () => store.addItem({ name, quantity, category })) : store.addItem({ name, quantity, category }));
      }
      return true;
    } catch (err) {
      toast(heError(err), { kind: 'error', timeout: 6000 });
      return false;
    } finally { inFlight.delete(k); renderChips(); }
  }

  function flash(id) {
    const row = listHost.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderChips() {
    const items = store.visibleItems();
    chips.replaceChildren(...QUICK_ADD.map((name) => {
      const onList = items.some((i) => !i.purchased && sameName(i.name, name));
      const busyNow = inFlight.has(name.toLowerCase());
      return h('button.chip', {
        type: 'button', 'aria-pressed': String(onList), disabled: busyNow,
        onclick: () => add(name, '', categorize(name)),
      }, icon(onList ? 'check' : 'plus', 16), name);
    }));
  }

  // ── Prices ──
  function priceTag(item) {
    if (!store.state.priceStore || item.pending) return null;
    const p = store.itemPrice(item);
    if (item.purchased) return p && !p.missing ? h('span.price.is-muted', money(p.total)) : null;
    if (!p) return h('button.price-link', { type: 'button', 'aria-label': `התאמת מחיר ל${item.name}`, onclick: () => matchItem(item) }, 'מחיר?');
    if (p.missing) return h('button.price-link', { type: 'button', onclick: () => matchItem(item) }, 'לא נמצא בסניף');
    const label = p.weighted ? `${money(p.each)} לק״ג` : (p.qty !== 1 ? `${money(p.total)}` : money(p.each));
    return h('button.price', {
      type: 'button',
      title: p.product.name,
      'aria-label': `${p.product.name}, ${label}. הקישו להחלפת המוצר`,
      onclick: () => matchItem(item),
    }, label);
  }

  function matchItem(item) {
    const q = h('input.input#match-q', { type: 'search', value: item.name, autocomplete: 'off', 'aria-label': 'חיפוש מוצר בסניף' });
    const remember = h('input#match-remember', { type: 'checkbox', checked: true });
    const results = h('ul.match-list', { 'aria-live': 'polite' });
    let timer, seq = 0;
    async function run() {
      const my = ++seq;
      const t = q.value.trim();
      if (t.length < 2) { results.replaceChildren(h('li.muted', 'הקלידו לפחות 2 אותיות.')); return; }
      results.replaceChildren(h('li.muted', 'מחפש…'));
      try {
        const rows = await store.searchProducts(t);
        if (my !== seq) return;
        results.replaceChildren(...(rows.length ? rows.map((p) => h('li',
          h('button.match-row', { type: 'button', onclick: async (e) => {
            try { await busy(e.currentTarget, () => store.linkItem(item, p, remember.checked)); dlg.close(); toast('המחיר עודכן', { kind: 'success' }); }
            catch (err) { toast(heError(err), { kind: 'error' }); }
          } },
          h('span.match-main', h('span.match-name', bdi(p.name)),
            h('span.muted.small', bdi([p.manufacturer, p.quantity && p.unit_qty ? `${Number(p.quantity)} ${p.unit_qty}` : null].filter(Boolean).join(' · ')))),
          h('span.match-price', p.is_weighted ? `${money(p.price)} לק״ג` : money(p.price)))))
          : [h('li.muted', 'לא נמצאו מוצרים. נסו מילה אחרת, למשל שם המותג.')]));
      } catch (err) { if (my === seq) results.replaceChildren(h('li.form-error', heError(err))); }
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    const dlg = openDialog({
      title: 'בחירת מוצר מהסניף',
      body: h('div.stack',
        h('p.muted.small', 'בחרו את המוצר המדויק כדי לראות את המחיר שלו ב', bdi(store.state.priceStore.name), '.'),
        q,
        h('label.check-line', remember, h('span', `לזכור שכשכותבים ״${item.name}״ הכוונה למוצר הזה`)),
        results),
      actions: [
        item.item_code && h('button.btn.btn-text.btn-danger-text', { type: 'button', onclick: async () => {
          try { await store.linkItem(item, null); dlg.close(); } catch (err) { toast(heError(err), { kind: 'error' }); }
        } }, 'הסרת ההתאמה'),
        h('button.btn.btn-secondary', { type: 'button', onclick: () => dlg.close() }, 'סגירה'),
      ].filter(Boolean),
    });
    q.select(); run();
  }

  // ── Item rows ──
  function itemRow(item) {
    const label = `${item.name}${item.quantity ? `, ${item.quantity}` : ''}`;
    return h('li.item', { dataset: { id: item.id }, class: [item.purchased && 'is-done', item.pending && 'is-pending'].filter(Boolean).join(' ') },
      h('button.check', {
        type: 'button', role: 'checkbox', 'aria-checked': String(!!item.purchased),
        'aria-label': `${label} — ${item.purchased ? 'נקנה, הקישו לביטול' : 'סמנו כנקנה'}`,
        disabled: item.pending,
        onclick: async () => {
          try { await store.setPurchased(item.id, !item.purchased); }
          catch (err) { toast(heError(err), { kind: 'error' }); }
        },
      }, h('span.box', icon('check', 18))),
      h('div.item-text',
        h('span.item-name', bdi(item.name)),
        item.quantity && h('span.qty', bdi(item.quantity)),
        priceTag(item)),
      !item.pending && h('button.icon-btn', { type: 'button', 'aria-label': `עריכת ${item.name}`, onclick: () => editItem(item) }, icon('pencil', 18)));
  }

  function renderList() {
    const items = store.visibleItems();
    const remaining = items.filter((i) => !i.purchased);
    const done = items.filter((i) => i.purchased).sort((a, b) => new Date(b.purchased_at || 0) - new Date(a.purchased_at || 0));

    stats.replaceChildren(
      h('div.stat', h('strong', String(remaining.length)), h('span', 'נשאר לקנות')),
      h('div.stat.stat-done', h('strong', String(done.length)), h('span', 'נקנו')));

    const ps = store.state.priceStore;
    totalLine.hidden = !ps || !remaining.length;
    if (ps && remaining.length) {
      const t = store.listTotal();
      totalLine.replaceChildren(
        h('span', 'סה״כ משוער ', h('strong', money(t.sum))),
        h('span.muted.total-sub', `מחירים ל־${t.priced} מתוך ${t.count} מוצרים · `, bdi(ps.name)));
    }

    const s = store.state;
    syncBar.hidden = s.sync === 'live' || s.sync === 'idle' || (s.sync === 'loading' && !s.loadError);
    syncBar.className = 'sync-bar' + (s.sync === 'error' ? ' is-error' : '');
    syncBar.replaceChildren(
      icon(s.sync === 'error' ? 'alert' : 'wifiOff', 18),
      h('span', s.sync === 'error' ? 'לא הצלחנו לטעון את הרשימה.' : 'החיבור לעדכונים נותק. מתחברים מחדש…'),
      h('button.btn.btn-text', { type: 'button', onclick: () => store.startSync() }, icon('refresh', 16), 'נסו שוב'));

    if (s.sync === 'loading' && !items.length) {
      listHost.replaceChildren(h('div.skeleton', { 'aria-label': 'טוען את הרשימה' }, h('div'), h('div'), h('div')));
      return;
    }
    if (!items.length) {
      listHost.replaceChildren(h('div.empty',
        icon('bucket', 40),
        h('p.empty-title', 'הרשימה ריקה'),
        h('p.muted', 'הוסיפו מוצר בשורה למעלה, או הקישו על אחת ההצעות.')));
      return;
    }

    const sections = CATEGORIES.map((c) => {
      const rows = remaining.filter((i) => i.category === c.id)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (!rows.length) return null;
      const open = openCats.has(c.id);
      const list = h('ul.items#cat-items-' + c.id, { hidden: !open }, rows.map(itemRow));
      return h('section.cat', { class: open ? 'is-open' : '' },
        h('h3.cat-head',
          h('button.cat-toggle', {
            type: 'button', 'aria-expanded': String(open), 'aria-controls': `cat-items-${c.id}`,
            onclick: () => { open ? openCats.delete(c.id) : openCats.add(c.id); renderList(); },
          },
          h('span.cat-text',
            h('span.cat-name', c.name),
            !open && h('span.cat-preview', bdi(rows.map((i) => i.name).join(', ')))),
          h('span.count', String(rows.length)),
          h('span.chev', icon('chevronDown', 20)))),
        list);
    });

    const allDone = !remaining.length && done.length
      ? h('div.all-done', icon('check', 22), h('span', 'קניתם הכל!')) : null;

    const doneSection = done.length ? h('section.done', { 'aria-labelledby': 'done-title' },
      h('div.done-head',
        h('h3.cat-title#done-title', 'נקנו', h('span.count', String(done.length))),
        h('button.btn.btn-text.btn-danger-text', { type: 'button', onclick: async (e) => {
          const btn = e.currentTarget;
          const yes = await confirmDialog({
            title: 'לנקות את המוצרים שנקנו?',
            message: `${done.length} מוצרים יימחקו מהרשימה של כל בני המשפחה. אי אפשר לבטל.`,
            confirmLabel: 'מחיקה', danger: true,
          });
          if (!yes) return;
          try { const n = await busy(btn, store.clearPurchased); toast(`נמחקו ${n} מוצרים`, { kind: 'success' }); }
          catch (err) { toast(heError(err), { kind: 'error' }); }
        } }, icon('trash', 16), 'ניקוי נקנו')),
      h('ul.items', done.map(itemRow))) : null;

    listHost.replaceChildren(...[...sections, allDone, doneSection].filter(Boolean));
  }

  function editItem(item) {
    const n = h('input.input#edit-name', { value: item.name, maxlength: 80, required: true });
    const q = h('input.input#edit-qty', { value: item.quantity || '', maxlength: 20 });
    const c = h('select.input#edit-cat', CATEGORIES.map((x) => h('option', { value: String(x.id), selected: x.id === item.category }, x.name)));
    const err = h('p.form-error', { role: 'alert', hidden: true });
    const save = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      if (!key(n.value)) { err.hidden = false; err.textContent = 'יש להזין שם מוצר.'; n.focus(); return; }
      try { openCats.add(Number(c.value)); await busy(save, () => store.updateItem(item.id, { name: key(n.value), quantity: q.value, category: Number(c.value) })); dlg.close(); }
      catch (e) { err.hidden = false; err.textContent = heError(e); }
    } }, 'שמירה');
    const dlg = openDialog({
      title: 'עריכת מוצר',
      body: h('div.stack',
        err,
        h('label.field', { for: 'edit-name' }, h('span', 'שם'), n),
        h('label.field', { for: 'edit-qty' }, h('span', 'כמות'), q),
        h('label.field', { for: 'edit-cat' }, h('span', 'קטגוריה'), c),
        h('button.btn.btn-text.btn-danger-text.align-start', { type: 'button', onclick: async () => {
          dlg.close();
          const yes = await confirmDialog({ title: `למחוק את ״${item.name}״?`, message: 'המוצר יימחק מהרשימה של כל בני המשפחה.', confirmLabel: 'מחיקה', danger: true });
          if (!yes) return;
          try { await store.deleteItem(item.id); toast('המוצר נמחק'); } catch (e) { toast(heError(e), { kind: 'error' }); }
        } }, icon('trash', 16), 'מחיקת המוצר')),
      actions: [h('button.btn.btn-secondary', { type: 'button', onclick: () => dlg.close() }, 'ביטול'), save],
    });
    n.select();
  }

  const view = h('div.page.list-page',
    h('header.app-header',
      h('div.brand-row',
        h('img.brand-mark', { src: 'assets/logo.svg', alt: '', width: 40, height: 40 }),
        h('div.titles',
          h('p.family-name', fam.name),
          h('h1.page-title', 'רשימת הקניות')),
        h('button.icon-btn', { type: 'button', 'aria-label': 'הגדרות משפחה וחשבון', onclick: () => navigate('/settings') }, icon('settings', 22))),
      stats, totalLine),
    h('main.content#main',
      syncBar,
      h('div.card.add-card', form, h('p.chips-label', 'הוספה מהירה'), chips),
      listHost));

  const render = () => { renderList(); renderChips(); };
  render();
  const unsub = store.subscribe(render);
  return { el: view, destroy: unsub, focus: () => {} };
}
