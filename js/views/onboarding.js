import { h, icon, busy, fieldError, bdi } from '../ui.js';
import { heError } from '../errors.js';
import * as store from '../store.js';
import { extractToken } from '../invite.js';
import { sb } from '../supabase.js';

/** Shown to a signed-in user who doesn't belong to any family yet. */
export function OnboardingView({ onJoined, inviteError }) {
  const name = h('input.input#family-name', { type: 'text', maxlength: 60, required: true, placeholder: 'למשפחת כהן' });
  const createBtn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'יצירת משפחה');
  const createForm = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const v = name.value.trim();
    if (!v) return fieldError(createForm, 'בחרו שם למשפחה.');
    busy(createBtn, async () => {
      try { const id = await store.createFamily(v); await onJoined(id); }
      catch (err) { fieldError(createForm, heError(err)); }
    });
  } },
  h('div.field', h('label', { for: 'family-name' }, 'שם המשפחה'), name),
  createBtn);

  const link = h('input.input#invite-link', { type: 'text', dir: 'ltr', autocomplete: 'off', placeholder: 'https://…/#/invite/…' });
  const joinBtn = h('button.btn.btn-secondary.btn-block', { type: 'submit' }, 'הצטרפות');
  const joinForm = h('form.stack', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const token = extractToken(link.value);
    if (!token) return fieldError(joinForm, 'הדביקו את קישור ההזמנה המלא שקיבלתם.');
    busy(joinBtn, async () => {
      try { const id = await store.acceptInvitation(token); await onJoined(id); }
      catch (err) { fieldError(joinForm, heError(err)); }
    });
  } },
  h('div.field', h('label', { for: 'invite-link' }, 'קישור הזמנה'), link));
  joinForm.append(joinBtn);
  if (inviteError) fieldError(joinForm, inviteError);

  const view = h('div.page.auth-page',
    h('main.auth-wrap#main',
      h('div.auth-brand', h('img.auth-logo', { src: 'assets/logo-badge.svg', alt: 'The Bucket', width: 168, height: 168 })),
      h('div.card.auth-card',
        h('h1.page-title', 'ברוכים הבאים'),
        h('p.muted', 'כדי להתחיל, צרו משפחה חדשה או הצטרפו למשפחה שהזמינה אתכם.'),
        h('h2.section-title', icon('users', 20), 'משפחה חדשה'),
        createForm,
        h('div.divider', h('span', 'או')),
        h('h2.section-title', icon('mail', 20), 'קיבלתי הזמנה'),
        h('p.muted.small', 'ההזמנה תעבוד רק אם נכנסתם עם כתובת המייל שאליה היא נשלחה.'),
        joinForm),
      h('button.btn.btn-text', { type: 'button', onclick: () => sb.auth.signOut() }, icon('logout', 18), 'יציאה מהחשבון')));
  return { el: view, focus: () => name.focus() };
}
