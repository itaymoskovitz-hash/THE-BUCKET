import { h, icon, busy, fieldError, toast, bdi } from '../ui.js';
import { sb, appBaseUrl } from '../supabase.js';
import { heError } from '../errors.js';
import { navigate } from '../router.js';
import { hasPendingInvite } from '../invite.js';

const MIN_PW = 8;
const emailOk = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

function shell(title, subtitle, ...content) {
  return h('div.page.auth-page',
    h('main.auth-wrap#main',
      h('div.auth-brand',
        h('img.auth-logo', { src: 'assets/logo-badge.svg', alt: 'The Bucket', width: 168, height: 168 })),
      h('div.card.auth-card',
        h('h1.page-title', title),
        subtitle && h('p.muted', subtitle),
        hasPendingInvite() && h('p.notice', icon('mail', 18),
          h('span', 'הוזמנת להצטרף למשפחה. התחברו או הירשמו עם כתובת המייל שאליה נשלחה ההזמנה.')),
        ...content),
      h('nav.legal-links', { 'aria-label': 'מידע משפטי' },
        h('a', { href: '#/privacy' }, 'מדיניות פרטיות'),
        h('a', { href: '#/terms' }, 'תנאי שימוש'),
        h('a', { href: '#/accessibility' }, 'הצהרת נגישות'))));
}

const field = (id, label, input, hint) =>
  h('div.field', h('label', { for: id }, label), input, hint && h('p.hint#' + id + '-hint', hint));

export function LoginView() {
  const email = h('input.input#email', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email', dir: 'ltr' });
  const pw = h('input.input#password', { type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'כניסה');
  const form = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = email.value.trim();
    if (!emailOk(v)) return fieldError(form, 'הזינו כתובת מייל תקינה.');
    if (!pw.value) return fieldError(form, 'הזינו סיסמה.');
    fieldError(form, '');
    busy(btn, async () => {
      const { error } = await sb.auth.signInWithPassword({ email: v, password: pw.value });
      if (error) fieldError(form, heError(error));
      // success is handled by the auth listener in app.js
    });
  } },
  field('email', 'מייל', email), field('password', 'סיסמה', pw), btn);
  return { el: shell('כניסה', 'הרשימה המשותפת של המשפחה, בכל טלפון.',
    form,
    h('div.auth-alt',
      h('a', { href: '#/forgot' }, 'שכחתי סיסמה'),
      h('p', 'אין לך חשבון? ', h('a', { href: '#/register' }, 'הרשמה')))), focus: () => email.focus() };
}

export function RegisterView() {
  const email = h('input.input#email', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email', dir: 'ltr' });
  const pw = h('input.input#password', { type: 'password', autocomplete: 'new-password', required: true, minlength: MIN_PW, dir: 'ltr', 'aria-describedby': 'password-hint' });
  const pw2 = h('input.input#password2', { type: 'password', autocomplete: 'new-password', required: true, dir: 'ltr' });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'יצירת חשבון');
  const body = h('div');
  const form = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = email.value.trim();
    if (!emailOk(v)) return fieldError(form, 'הזינו כתובת מייל תקינה.');
    if (pw.value.length < MIN_PW) return fieldError(form, `הסיסמה צריכה להכיל לפחות ${MIN_PW} תווים.`);
    if (pw.value !== pw2.value) return fieldError(form, 'הסיסמאות אינן תואמות.');
    fieldError(form, '');
    busy(btn, async () => {
      const { data, error } = await sb.auth.signUp({ email: v, password: pw.value, options: { emailRedirectTo: appBaseUrl() } });
      if (error) return fieldError(form, heError(error));
      if (!data.session) {
        body.replaceChildren(h('div.stack',
          h('p.notice.notice-success', icon('mail', 18), h('span', 'שלחנו לך מייל לאישור החשבון.')),
          h('p', 'פתחו את המייל ששלחנו אל ', bdi(v), ' ולחצו על הקישור. אחר כך חזרו לכאן והתחברו.'),
          h('p.muted.small', 'לא הגיע? בדקו בתיקיית הספאם. ייתכן שיעברו כמה דקות.'),
          h('a.btn.btn-secondary.btn-block', { href: '#/login' }, 'למסך הכניסה')));
      }
    });
  } },
  field('email', 'מייל', email),
  field('password', 'סיסמה', pw, `לפחות ${MIN_PW} תווים`),
  field('password2', 'אימות סיסמה', pw2),
  btn);
  body.append(form, h('div.auth-alt', h('p', 'כבר יש לך חשבון? ', h('a', { href: '#/login' }, 'כניסה'))));
  return { el: shell('הרשמה', null, body), focus: () => email.focus() };
}

export function ForgotView() {
  const email = h('input.input#email', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email', dir: 'ltr' });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'שליחת קישור לאיפוס');
  const body = h('div');
  const form = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = email.value.trim();
    if (!emailOk(v)) return fieldError(form, 'הזינו כתובת מייל תקינה.');
    busy(btn, async () => {
      const { error } = await sb.auth.resetPasswordForEmail(v, { redirectTo: appBaseUrl() + '?reset=1' });
      if (error) return fieldError(form, heError(error));
      // Same message whether or not the account exists (avoids revealing who is registered).
      body.replaceChildren(h('p.notice.notice-success', icon('mail', 18),
        h('span', 'אם קיים חשבון עם המייל הזה, נשלח אליו קישור לאיפוס הסיסמה. פתחו אותו מהמכשיר הזה.')),
        h('a.btn.btn-secondary.btn-block', { href: '#/login' }, 'חזרה לכניסה'));
    });
  } }, field('email', 'מייל', email), btn);
  body.append(form, h('div.auth-alt', h('a', { href: '#/login' }, 'חזרה לכניסה')));
  return { el: shell('איפוס סיסמה', 'נשלח לך קישור לבחירת סיסמה חדשה.', body), focus: () => email.focus() };
}

export function ResetView() {
  const pw = h('input.input#password', { type: 'password', autocomplete: 'new-password', required: true, dir: 'ltr', 'aria-describedby': 'password-hint' });
  const pw2 = h('input.input#password2', { type: 'password', autocomplete: 'new-password', required: true, dir: 'ltr' });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'שמירת סיסמה חדשה');
  const form = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    if (pw.value.length < MIN_PW) return fieldError(form, `הסיסמה צריכה להכיל לפחות ${MIN_PW} תווים.`);
    if (pw.value !== pw2.value) return fieldError(form, 'הסיסמאות אינן תואמות.');
    busy(btn, async () => {
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) return fieldError(form, heError(error));
      toast('הסיסמה עודכנה', { kind: 'success' });
      history.replaceState(null, '', location.pathname + '#/'); // drop ?reset=1
      navigate('/', { replace: true });
    });
  } }, field('password', 'סיסמה חדשה', pw, `לפחות ${MIN_PW} תווים`), field('password2', 'אימות סיסמה', pw2), btn);
  return { el: shell('בחירת סיסמה חדשה', null, form), focus: () => pw.focus() };
}
