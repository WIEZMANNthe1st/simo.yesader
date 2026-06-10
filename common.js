/* פונקציות משותפות לשני הדפים */

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MAX_SHIFTS_PER_WEEK = 4;
const SHIFT_LABELS = { day: 'יום 07:00–19:00', night: 'לילה 19:00–07:00' };
const SHIFT_TYPES = ['day', 'night'];

/* יום ראשון של השבוע במרחק offset שבועות מהשבוע הבא */
function weekStart(offset) {
  const now = new Date();
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  sunday.setDate(sunday.getDate() + 7 * (1 + offset)); // ברירת מחדל: השבוע הבא
  return sunday;
}

function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function weekLabel(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const f = d => `${d.getDate()}.${d.getMonth() + 1}`;
  return `${f(start)} – ${f(end)}.${end.getFullYear()}`;
}

function dayDate(start, d) {
  const dt = new Date(start);
  dt.setDate(dt.getDate() + d);
  return `${dt.getDate()}.${dt.getMonth() + 1}`;
}

async function api(path, opts = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith('/login')) {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
    throw new Error('פג תוקף החיבור');
  }
  if (!res.ok) throw new Error(data.error || 'שגיאה');
  return data;
}

function showMsg(el, text, cls) {
  el.textContent = text;
  el.className = 'msg ' + cls;
  if (cls === 'ok') setTimeout(() => { el.className = 'msg'; }, 3000);
}
