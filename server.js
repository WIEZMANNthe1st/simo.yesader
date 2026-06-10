/*
 * מערכת סידור עבודה — שרת
 * אין תלויות חיצוניות: Node.js בלבד (גרסה 18 ומעלה)
 * הרצה:  node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DAYS = 7;                 // ראשון–שבת
const SHIFT_TYPES = ['day', 'night']; // 07:00–19:00, 19:00–07:00
const SLOTS_PER_SHIFT = 2;      // שני עובדים בכל משמרת

/* כללי המערכת */
const MAX_SHIFTS_PER_WEEK = 4;          // עובד לא עובד יותר מ-4 משמרות בשבוע
const MAX_BLOCKED_DAYS_PER_MONTH = 8;   // עובד יכול לחסום עד 8 ימים בחודש

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/* תאריך של יום d (0–6) בשבוע שמתחיל ב-weekKey */
function dayDateOf(weekKey, d) {
  const [y, m, dd] = weekKey.split('-').map(Number);
  return new Date(y, m - 1, dd + d);
}
const dateKeyOf = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const monthKeyOf = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;

/* ---------- מסד נתונים (קובץ JSON) ---------- */
let db;

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = {
      settings: { adminPassword: process.env.ADMIN_PASSWORD || '1234' },
      employees: [],
      weeks: {}
    };
    saveDb();
  }
  if (!db.settings) db.settings = { adminPassword: '1234' };
  if (!db.employees) db.employees = [];
  if (!db.weeks) db.weeks = {};      // לוחות שבועיים: { schedule, published }
  if (!db.months) db.months = {};    // אילוצים חודשיים: { constraints: { empId: { blocked, note } } }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function getWeek(weekKey) {
  if (!db.weeks[weekKey]) {
    db.weeks[weekKey] = { schedule: {}, published: false };
  }
  return db.weeks[weekKey];
}

function getMonth(monthKey) {
  if (!db.months[monthKey]) {
    db.months[monthKey] = { constraints: {} };
  }
  return db.months[monthKey];
}

/* האילוצים החודשיים של עובד, מתורגמים למפתחות של שבוע נתון ('0-day' וכו') */
function blockedSetForWeek(empId, weekKey) {
  const s = new Set();
  for (let d = 0; d < DAYS; d++) {
    const dt = dayDateOf(weekKey, d);
    const entry = (db.months[monthKeyOf(dt)] || { constraints: {} }).constraints[empId];
    if (!entry) continue;
    const dk = dateKeyOf(dt);
    for (const type of SHIFT_TYPES) {
      if ((entry.blocked || []).includes(`${dk}-${type}`)) s.add(`${d}-${type}`);
    }
  }
  return s;
}

/* ---------- אימות ---------- */
const tokens = new Map(); // token -> { role: 'employee'|'admin', empId? }

function newToken(payload) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, payload);
  return t;
}

function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  return t ? tokens.get(t) : null;
}

/* ---------- אלגוריתם שיבוץ אוטומטי ----------
 * כללים קשיחים:
 *   - לא משבצים עובד למשמרת שסימן בה אילוץ.
 *   - מקסימום 4 משמרות בשבוע לעובד.
 *   - לא משבצים עובד לשתי משמרות רצופות:
 *     לא שתי משמרות באותו יום, ולא משמרת יום מיד אחרי לילה.
 * הוגנות: מי שעבד הכי מעט משובץ ראשון, עם איזון משני של משמרות לילה.
 */
function generateSchedule(weekKey) {
  const employees = db.employees.filter(e => e.active !== false);
  const blockedCache = {};
  const blockedOf = id => blockedCache[id] || (blockedCache[id] = blockedSetForWeek(id, weekKey));

  function attempt() {
    const schedule = {};
    const total = {}, nights = {};
    employees.forEach(e => { total[e.id] = 0; nights[e.id] = 0; });
    const assignedTo = key => schedule[key] || [];

    for (let d = 0; d < DAYS; d++) {
      for (const type of SHIFT_TYPES) {
        const key = `${d}-${type}`;
        const eligible = employees.filter(e => {
          if (blockedOf(e.id).has(key)) return false;
          if (total[e.id] >= MAX_SHIFTS_PER_WEEK) return false;
          const otherType = type === 'day' ? 'night' : 'day';
          if (assignedTo(`${d}-${otherType}`).includes(e.id)) return false;
          if (type === 'day' && d > 0 && assignedTo(`${d - 1}-night`).includes(e.id)) return false;
          return true;
        });
        // מיון לפי הוגנות: סה"כ משמרות, אחר כך מספר לילות, אחר כך אקראי
        eligible.sort((a, b) =>
          (total[a.id] - total[b.id]) ||
          (type === 'night' ? (nights[a.id] - nights[b.id]) : 0) ||
          (Math.random() - 0.5)
        );
        const picked = eligible.slice(0, SLOTS_PER_SHIFT).map(e => e.id);
        while (picked.length < SLOTS_PER_SHIFT) picked.push(null);
        picked.forEach(id => {
          if (id) { total[id]++; if (type === 'night') nights[id]++; }
        });
        schedule[key] = picked;
      }
    }

    const unfilled = Object.entries(schedule)
      .filter(([, ids]) => ids.includes(null)).map(([k]) => k);
    return { schedule, unfilled };
  }

  // כמה ניסיונות אקראיים — נבחרת התוצאה עם הכי מעט משבצות ריקות
  let best = attempt();
  for (let i = 0; i < 60 && best.unfilled.length > 0; i++) {
    const cand = attempt();
    if (cand.unfilled.length < best.unfilled.length) best = cand;
  }
  return best;
}

/* בדיקת חוקיות של סידור (גם לעריכה ידנית) — מחזירה רשימת הפרות בעברית */
function scheduleViolations(schedule) {
  const nameOf = id => (db.employees.find(e => e.id === id) || { name: '?' }).name;
  const msgs = [];
  const counts = {};

  for (let d = 0; d < DAYS; d++) {
    for (const type of SHIFT_TYPES) {
      const ids = schedule[`${d}-${type}`] || [];
      if (ids[0] && ids[0] === ids[1]) {
        msgs.push(`${nameOf(ids[0])} משובץ/ת פעמיים באותה משמרת (${DAY_NAMES[d]})`);
      }
      ids.forEach(id => { if (id) counts[id] = (counts[id] || 0) + 1; });
    }
  }

  for (const [id, c] of Object.entries(counts)) {
    if (c > MAX_SHIFTS_PER_WEEK) {
      msgs.push(`${nameOf(id)} משובץ/ת ל-${c} משמרות — המקסימום הוא ${MAX_SHIFTS_PER_WEEK} בשבוע`);
    }
  }

  for (let d = 0; d < DAYS; d++) {
    const day = schedule[`${d}-day`] || [];
    const night = schedule[`${d}-night`] || [];
    for (const id of day) {
      if (id && night.includes(id)) {
        msgs.push(`${nameOf(id)} משובץ/ת לשתי משמרות רצופות ביום ${DAY_NAMES[d]}`);
      }
    }
    if (d < DAYS - 1) {
      for (const id of night) {
        if (id && (schedule[`${d + 1}-day`] || []).includes(id)) {
          msgs.push(`${nameOf(id)} משובץ/ת ללילה של ${DAY_NAMES[d]} ומיד אחריו למשמרת יום של ${DAY_NAMES[d + 1]} — משמרות רצופות`);
        }
      }
    }
  }

  return msgs;
}

/* האם עבר תאריך היעד להגשת זמינות לחודש (יום היעד עצמו עדיין פתוח) */
function isMonthLocked(monthKey) {
  const m = db.months[monthKey];
  if (!m || !m.deadline) return false;
  const [y, mo, d] = m.deadline.split('-').map(Number);
  return new Date() >= new Date(y, mo - 1, d + 1);
}

const fmtDate = key => {
  const [y, mo, d] = key.split('-').map(Number);
  return `${d}.${mo}.${y}`;
};

/* שבועות (לפי מפתח יום ראשון) שנוגעים בחודש נתון */
function weekTouchesMonth(weekKey, monthKey) {
  for (let d = 0; d < DAYS; d++) {
    if (monthKeyOf(dayDateOf(weekKey, d)) === monthKey) return true;
  }
  return false;
}

/* ---------- עזרי HTTP ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  if (file === '/admin') file = '/admin.html';
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('לא נמצא'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const BLOCKED_KEY_RE = /^(\d{4}-\d{2}-\d{2})-(day|night)$/;

/* ---------- ראוטר ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const auth = getAuth(req);

  /* --- ציבורי --- */
  if (p === '/api/names' && method === 'GET') {
    return sendJson(res, 200, db.employees.filter(e => e.active !== false)
      .map(e => ({ id: e.id, name: e.name })));
  }

  if (p === '/api/login' && method === 'POST') {
    const { empId, code } = await readBody(req);
    const emp = db.employees.find(e => e.id === empId && e.active !== false);
    if (!emp || String(emp.code) !== String(code || '')) {
      return sendJson(res, 401, { error: 'שם או קוד שגויים' });
    }
    return sendJson(res, 200, { token: newToken({ role: 'employee', empId: emp.id }), name: emp.name });
  }

  if (p === '/api/admin/login' && method === 'POST') {
    const { password } = await readBody(req);
    if (String(password || '') !== String(db.settings.adminPassword)) {
      return sendJson(res, 401, { error: 'סיסמה שגויה' });
    }
    return sendJson(res, 200, { token: newToken({ role: 'admin' }) });
  }

  /* --- עובד מחובר: זמינות ברמה חודשית --- */
  if (p === '/api/month' && method === 'GET') {
    if (!auth || auth.role !== 'employee') return sendJson(res, 401, { error: 'לא מחובר' });
    const monthKey = url.searchParams.get('month');
    if (!MONTH_RE.test(monthKey || '')) return sendJson(res, 400, { error: 'חודש לא תקין' });
    const mine = getMonth(monthKey).constraints[auth.empId] || { blocked: [], note: '' };
    const names = {};
    db.employees.forEach(e => { names[e.id] = e.name; });
    // סידורים מפורסמים של שבועות שנוגעים בחודש הזה
    const publishedWeeks = Object.entries(db.weeks)
      .filter(([wk, w]) => w.published && weekTouchesMonth(wk, monthKey))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wk, w]) => ({ week: wk, schedule: w.schedule }));
    return sendJson(res, 200, {
      blocked: mine.blocked || [],
      note: mine.note || '',
      publishedWeeks,
      names,
      myId: auth.empId,
      maxBlockedDays: MAX_BLOCKED_DAYS_PER_MONTH,
      deadline: (db.months[monthKey] || {}).deadline || null,
      locked: isMonthLocked(monthKey)
    });
  }

  if (p === '/api/month' && method === 'POST') {
    if (!auth || auth.role !== 'employee') return sendJson(res, 401, { error: 'לא מחובר' });
    const { month: monthKey, blocked, note } = await readBody(req);
    if (!MONTH_RE.test(monthKey || '')) return sendJson(res, 400, { error: 'חודש לא תקין' });

    // אכיפת תאריך היעד
    if (isMonthLocked(monthKey)) {
      return sendJson(res, 400, {
        error: `ההגשה לחודש זה נסגרה — תאריך היעד היה ${fmtDate(db.months[monthKey].deadline)}. לשינויים פנו למנהל.`
      });
    }

    // ניקוי: רק מפתחות תקינים של תאריכים בתוך החודש הזה
    const cleanBlocked = (Array.isArray(blocked) ? blocked : [])
      .filter(k => {
        const m = typeof k === 'string' && k.match(BLOCKED_KEY_RE);
        return m && m[1].startsWith(monthKey + '-');
      })
      .slice(0, 62);

    // אכיפת המגבלה: עד 8 ימים חסומים בחודש (יום נספר פעם אחת)
    const days = new Set(cleanBlocked.map(k => k.slice(0, 10)));
    if (days.size > MAX_BLOCKED_DAYS_PER_MONTH) {
      const m = parseInt(monthKey.slice(5), 10) - 1;
      return sendJson(res, 400, {
        error: `אפשר לחסום עד ${MAX_BLOCKED_DAYS_PER_MONTH} ימים בחודש ${HEB_MONTHS[m]} — סימנתם ${days.size} ימים. הסירו חסימות ונסו שוב.`
      });
    }

    getMonth(monthKey).constraints[auth.empId] = {
      blocked: cleanBlocked,
      note: String(note || '').slice(0, 500),
      updatedAt: new Date().toISOString()
    };
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* --- מנהל --- */
  if (p.startsWith('/api/admin/')) {
    if (p !== '/api/admin/login') {
      if (!auth || auth.role !== 'admin') return sendJson(res, 401, { error: 'לא מחובר כמנהל' });
    }

    if (p === '/api/admin/week' && method === 'GET') {
      const weekKey = url.searchParams.get('week');
      if (!WEEK_RE.test(weekKey || '')) return sendJson(res, 400, { error: 'שבוע לא תקין' });
      const week = getWeek(weekKey);

      // החודשים שהשבוע נוגע בהם
      const monthKeys = [...new Set(
        Array.from({ length: DAYS }, (_, d) => monthKeyOf(dayDateOf(weekKey, d))))];

      // תרגום הזמינות החודשית של כל עובד למפתחות השבוע
      const constraints = {};
      for (const e of db.employees) {
        let submitted = false;
        const notes = [];
        for (const mk of monthKeys) {
          const entry = (db.months[mk] || { constraints: {} }).constraints[e.id];
          if (entry) {
            submitted = true;
            if (entry.note) notes.push(entry.note);
          }
        }
        if (submitted) {
          constraints[e.id] = {
            blocked: [...blockedSetForWeek(e.id, weekKey)],
            note: notes.join(' | ')
          };
        }
      }

      return sendJson(res, 200, {
        employees: db.employees,
        constraints,
        schedule: week.schedule,
        published: !!week.published
      });
    }

    if (p === '/api/admin/employee' && method === 'POST') {
      const { name, code } = await readBody(req);
      if (!name || !String(name).trim()) return sendJson(res, 400, { error: 'חסר שם' });
      const emp = {
        id: crypto.randomUUID(),
        name: String(name).trim().slice(0, 50),
        code: String(code || Math.floor(1000 + Math.random() * 9000)).slice(0, 20),
        active: true
      };
      db.employees.push(emp);
      saveDb();
      return sendJson(res, 200, emp);
    }

    const empMatch = p.match(/^\/api\/admin\/employee\/([\w-]+)$/);
    if (empMatch) {
      const emp = db.employees.find(e => e.id === empMatch[1]);
      if (!emp) return sendJson(res, 404, { error: 'עובד לא נמצא' });
      if (method === 'PUT') {
        const { name, code, active } = await readBody(req);
        if (name !== undefined) emp.name = String(name).trim().slice(0, 50);
        if (code !== undefined) emp.code = String(code).slice(0, 20);
        if (active !== undefined) emp.active = !!active;
        saveDb();
        return sendJson(res, 200, emp);
      }
      if (method === 'DELETE') {
        db.employees = db.employees.filter(e => e.id !== emp.id);
        saveDb();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/generate' && method === 'POST') {
      const { week: weekKey } = await readBody(req);
      if (!WEEK_RE.test(weekKey || '')) return sendJson(res, 400, { error: 'שבוע לא תקין' });
      const { schedule, unfilled } = generateSchedule(weekKey);
      const week = getWeek(weekKey);
      week.schedule = schedule;
      saveDb();
      return sendJson(res, 200, { schedule, unfilled });
    }

    if (p === '/api/admin/schedule' && method === 'POST') {
      const { week: weekKey, schedule } = await readBody(req);
      if (!WEEK_RE.test(weekKey || '')) return sendJson(res, 400, { error: 'שבוע לא תקין' });
      const week = getWeek(weekKey);
      const clean = {};
      for (let d = 0; d < DAYS; d++) {
        for (const type of SHIFT_TYPES) {
          const key = `${d}-${type}`;
          const ids = Array.isArray(schedule && schedule[key]) ? schedule[key] : [];
          clean[key] = [0, 1].map(i =>
            db.employees.some(e => e.id === ids[i]) ? ids[i] : null);
        }
      }
      const violations = scheduleViolations(clean);
      if (violations.length) {
        return sendJson(res, 400, { error: 'הסידור מפר את הכללים: ' + violations.join(' • ') });
      }
      week.schedule = clean;
      saveDb();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/admin/publish' && method === 'POST') {
      const { week: weekKey, published } = await readBody(req);
      if (!WEEK_RE.test(weekKey || '')) return sendJson(res, 400, { error: 'שבוע לא תקין' });
      getWeek(weekKey).published = !!published;
      saveDb();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/admin/deadlines' && method === 'GET') {
      const deadlines = {};
      for (const [mk, m] of Object.entries(db.months)) {
        if (m.deadline) deadlines[mk] = m.deadline;
      }
      return sendJson(res, 200, deadlines);
    }

    if (p === '/api/admin/deadline' && method === 'POST') {
      const { month: monthKey, deadline } = await readBody(req);
      if (!MONTH_RE.test(monthKey || '')) return sendJson(res, 400, { error: 'חודש לא תקין' });
      const m = getMonth(monthKey);
      if (!deadline) {
        delete m.deadline;
      } else {
        if (!WEEK_RE.test(String(deadline))) return sendJson(res, 400, { error: 'תאריך יעד לא תקין' });
        m.deadline = String(deadline);
      }
      saveDb();
      return sendJson(res, 200, { ok: true, deadline: m.deadline || null });
    }

    if (p === '/api/admin/password' && method === 'POST') {
      const { password } = await readBody(req);
      if (!password || String(password).length < 4) {
        return sendJson(res, 400, { error: 'סיסמה חייבת להכיל לפחות 4 תווים' });
      }
      db.settings.adminPassword = String(password);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: 'נתיב לא קיים' });
}

/* ---------- שרת ---------- */
loadDb();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(res, url.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: 'שגיאת שרת: ' + err.message });
  }
}).listen(PORT, () => {
  console.log(`✓ מערכת סידור עבודה פועלת: http://localhost:${PORT}`);
  console.log(`  דף עובדים:  http://localhost:${PORT}/`);
  console.log(`  דף ניהול:   http://localhost:${PORT}/admin`);
});
