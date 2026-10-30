// Turn any Supabase / network / RPC error into a clear Hebrew message.
const RPC = {
  NOT_AUTHENTICATED: 'צריך להתחבר מחדש.',
  INVALID_NAME: 'השם צריך להכיל בין 1 ל־60 תווים.',
  NOT_A_MEMBER: 'אינך חבר במשפחה הזו.',
  NOT_OWNER: 'רק בעלי המשפחה יכולים לבצע פעולה זו.',
  INVALID_EMAIL: 'כתובת המייל אינה תקינה.',
  ALREADY_MEMBER: 'המשתמש הזה כבר חבר במשפחה.',
  INVITE_INVALID: 'קישור ההזמנה אינו תקין.',
  INVITE_REVOKED: 'ההזמנה בוטלה. בקשו הזמנה חדשה.',
  INVITE_USED: 'כבר נעשה שימוש בהזמנה הזו.',
  INVITE_EXPIRED: 'פג תוקף ההזמנה. בקשו הזמנה חדשה.',
  INVITE_WRONG_EMAIL: 'ההזמנה נשלחה לכתובת מייל אחרת. התחברו עם המייל שאליו נשלחה ההזמנה.',
  EMAIL_NOT_CONFIRMED: 'יש לאשר את כתובת המייל לפני קבלת הזמנה.',
  CANNOT_REMOVE_SELF: 'אי אפשר להסיר את עצמך. השתמשו ב״עזיבת המשפחה״.',
  OWNER_CANNOT_LEAVE: 'בעלי המשפחה לא יכולים לעזוב. העבירו קודם את הבעלות או מחקו את המשפחה.',
  ALREADY_OWNER: 'את/ה כבר הבעלים.',
  CONFIRM_MISMATCH: 'שם המשפחה שהוקלד אינו תואם.',
  STORE_NOT_FOUND: 'הסניף לא נמצא. נסו לבחור שוב.',
};

const AUTH = [
  [/invalid login credentials/i, 'מייל או סיסמה שגויים.'],
  [/email not confirmed/i, 'עדיין לא אישרת את כתובת המייל. בדקו את תיבת הדואר.'],
  [/user already registered|already been registered/i, 'כבר קיים חשבון עם המייל הזה. נסו להתחבר.'],
  [/password should be at least|weak password|password is too weak/i, 'הסיסמה חלשה מדי. השתמשו לפחות ב־8 תווים.'],
  [/rate limit|too many requests|security purposes/i, 'יותר מדי ניסיונות. המתינו מעט ונסו שוב.'],
  [/invalid email|unable to validate email/i, 'כתובת המייל אינה תקינה.'],
  [/same password|different from the old/i, 'הסיסמה החדשה חייבת להיות שונה מהקודמת.'],
  [/jwt expired|refresh token|session.*(missing|expired)|not authenticated/i, 'פג תוקף החיבור. התחברו מחדש.'],
  [/signups not allowed/i, 'ההרשמה סגורה כרגע.'],
  [/code verifier|auth code|flow state/i, 'הקישור כבר נוצל או נפתח בדפדפן אחר. נסו שוב מאותו מכשיר.'],
  [/failed to fetch|network|load failed|fetch failed/i, 'אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.'],
  [/permission denied|row-level security|violates row-level/i, 'אין לך הרשאה לבצע פעולה זו.'],
];

export function heError(err) {
  if (!err) return 'אירעה שגיאה. נסו שוב.';
  const msg = String(err.message || err.error_description || err || '');
  const code = msg.trim().split(/\s/)[0];
  if (RPC[code]) return RPC[code];
  if (!navigator.onLine) return 'אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.';
  for (const [re, he] of AUTH) if (re.test(msg)) return he;
  return 'אירעה שגיאה. נסו שוב.';
}
