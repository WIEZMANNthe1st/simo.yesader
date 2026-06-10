/* בדיקת עשן מקצה לקצה — מריצים על מסד נתונים נקי:  node smoke-test.js */
const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;

function assert(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + msg);
  if (!cond) failures++;
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}

(async () => {
  // כניסת מנהל
  let r = await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } });
  assert(r.status === 401, 'סיסמת מנהל שגויה נדחית');
  r = await call('/api/admin/login', { method: 'POST', body: { password: '1234' } });
  assert(r.status === 200 && r.data.token, 'כניסת מנהל מצליחה');
  const admin = r.data.token;

  // הוספת 8 עובדים (7 ומעלה נדרשים לכיסוי מלא עם מגבלת 4 משמרות)
  const emps = [];
  for (const name of ['דנה', 'יוסי', 'מיכל', 'אבי', 'נועה', 'רון', 'תמר', 'גיל']) {
    r = await call('/api/admin/employee', { method: 'POST', token: admin, body: { name, code: '1111' } });
    assert(r.status === 200 && r.data.id, `הוספת עובד: ${name}`);
    emps.push(r.data);
  }

  // רשימת שמות ציבורית
  r = await call('/api/names');
  assert(r.data.length >= 8, 'רשימת שמות לכניסה');

  // כניסת עובד
  r = await call('/api/login', { method: 'POST', body: { empId: emps[0].id, code: 'bad' } });
  assert(r.status === 401, 'קוד שגוי נדחה');
  r = await call('/api/login', { method: 'POST', body: { empId: emps[0].id, code: '1111' } });
  assert(r.status === 200 && r.data.token, 'כניסת עובד מצליחה');
  const dana = r.data.token;

  /* ===== הגשת זמינות חודשית ===== */
  // דנה חוסמת את 14–15.6 (שני ימים, כל המשמרות) לחודש יוני
  const month = '2026-06';
  const danaBlocked = ['2026-06-14-day', '2026-06-14-night', '2026-06-15-day', '2026-06-15-night'];
  r = await call('/api/month', { method: 'POST', token: dana, body: { month, blocked: danaBlocked, note: 'בבקשה בלי תחילת שבוע' } });
  assert(r.status === 200, 'שמירת זמינות חודשית');
  r = await call('/api/month?month=' + month, { token: dana });
  assert(JSON.stringify(r.data.blocked.sort()) === JSON.stringify(danaBlocked.sort()), 'הזמינות נשמרה ונקראה');
  assert(Array.isArray(r.data.publishedWeeks) && r.data.publishedWeeks.length === 0, 'אין עדיין סידורים מפורסמים');
  assert(r.data.maxBlockedDays === 8, 'מכסת הימים מוחזרת לעובד');

  // מפתחות מחוץ לחודש מסוננים
  r = await call('/api/month', { method: 'POST', token: dana, body: { month, blocked: [...danaBlocked, '2026-07-01-day', 'junk'], note: 'בבקשה בלי תחילת שבוע' } });
  assert(r.status === 200, 'שמירה עם מפתחות זרים מתקבלת');
  r = await call('/api/month?month=' + month, { token: dana });
  assert(!r.data.blocked.includes('2026-07-01-day') && !r.data.blocked.includes('junk'), 'תאריך מחוץ לחודש וערך זבל סוננו');

  /* ===== כלל: עד 8 ימים חסומים בחודש ===== */
  r = await call('/api/login', { method: 'POST', body: { empId: emps[1].id, code: '1111' } });
  const yossi = r.data.token;
  const nineDays = [];
  for (let d = 21; d <= 29; d++) nineDays.push(`2026-06-${d}-day`);
  r = await call('/api/month', { method: 'POST', token: yossi, body: { month, blocked: nineDays } });
  assert(r.status === 400, '9 ימים חסומים בחודש — נדחה: ' + (r.data.error || ''));
  r = await call('/api/month', { method: 'POST', token: yossi, body: { month, blocked: nineDays.slice(0, 8) } });
  assert(r.status === 200, '8 ימים חסומים בחודש — מותר');
  // יום עם שתי משמרות נספר פעם אחת
  const eightDaysDouble = nineDays.slice(0, 8).flatMap(k => [k, k.replace('-day', '-night')]);
  r = await call('/api/month', { method: 'POST', token: yossi, body: { month, blocked: eightDaysDouble } });
  assert(r.status === 200, 'יום עם שתי משמרות חסומות נספר כיום אחד');
  // בחודש אחר המכסה נפרדת
  r = await call('/api/month', { method: 'POST', token: yossi, body: { month: '2026-07', blocked: ['2026-07-05-day'] } });
  assert(r.status === 200, 'חסימה בחודש אחר — מכסה נפרדת');

  /* ===== תאריך יעד להגשה ===== */
  // מנהל קובע תאריך יעד שעבר (אתמול) לחודש אוגוסט
  r = await call('/api/admin/deadline', { method: 'POST', token: admin, body: { month: '2026-08', deadline: '2026-06-01' } });
  assert(r.status === 200, 'קביעת תאריך יעד');
  r = await call('/api/month', { method: 'POST', token: dana, body: { month: '2026-08', blocked: ['2026-08-10-day'] } });
  assert(r.status === 400, 'הגשה אחרי תאריך היעד — נדחית: ' + (r.data.error || ''));
  r = await call('/api/month?month=2026-08', { token: dana });
  assert(r.data.locked === true && r.data.deadline === '2026-06-01', 'העובד רואה שהחודש נעול ומה היה תאריך היעד');
  // תאריך יעד של היום עצמו — עדיין פתוח (כולל)
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  r = await call('/api/admin/deadline', { method: 'POST', token: admin, body: { month: '2026-08', deadline: todayKey } });
  r = await call('/api/month', { method: 'POST', token: dana, body: { month: '2026-08', blocked: ['2026-08-10-day'] } });
  assert(r.status === 200, 'יום היעד עצמו עדיין פתוח להגשה');
  // הסרת תאריך יעד
  r = await call('/api/admin/deadline', { method: 'POST', token: admin, body: { month: '2026-08', deadline: '' } });
  assert(r.status === 200 && r.data.deadline === null, 'הסרת תאריך יעד');
  r = await call('/api/month?month=2026-08', { token: dana });
  assert(r.data.locked === false && r.data.deadline === null, 'אחרי הסרה — החודש פתוח ללא הגבלה');
  // רשימת תאריכי יעד + הרשאות
  r = await call('/api/admin/deadline', { method: 'POST', token: admin, body: { month: '2026-07', deadline: '2026-06-20' } });
  r = await call('/api/admin/deadlines', { token: admin });
  assert(r.data['2026-07'] === '2026-06-20', 'רשימת תאריכי היעד למנהל');
  r = await call('/api/admin/deadline', { method: 'POST', token: dana, body: { month: '2026-07', deadline: '2026-06-01' } });
  assert(r.status === 401, 'עובד לא יכול לקבוע תאריך יעד');

  /* ===== יצירת סידור אוטומטי לשבוע 14–20.6 ===== */
  const week = '2026-06-14';
  r = await call('/api/admin/generate', { method: 'POST', token: admin, body: { week } });
  assert(r.status === 200, 'יצירת סידור אוטומטי');
  const sched = r.data.schedule;
  assert(Object.keys(sched).length === 14, '14 משמרות בסידור');
  assert(r.data.unfilled.length === 0, 'כל המשבצות מאוישות (8 עובדים)');

  // האילוצים החודשיים של דנה (14–15.6 = ימים 0,1 בשבוע) מכובדים
  const danaWeekKeys = ['0-day', '0-night', '1-day', '1-night'];
  assert(danaWeekKeys.every(k => !sched[k].includes(emps[0].id)), 'האילוצים החודשיים של דנה מכובדים בסידור השבועי');

  // כלל: עד 4 משמרות בשבוע
  const counts = {};
  Object.values(sched).flat().forEach(id => { if (id) counts[id] = (counts[id] || 0) + 1; });
  assert(Math.max(...Object.values(counts)) <= 4, 'אף עובד לא משובץ ליותר מ-4 משמרות בשבוע');

  // כלל: בלי משמרות רצופות
  let sameDay = 0, dayAfterNight = 0;
  for (let d = 0; d < 7; d++) {
    for (const id of sched[`${d}-day`]) {
      if (id && sched[`${d}-night`].includes(id)) sameDay++;
      if (id && d > 0 && sched[`${d - 1}-night`].includes(id)) dayAfterNight++;
    }
  }
  assert(sameDay === 0, 'אף עובד לא משובץ לשתי משמרות באותו יום');
  assert(dayAfterNight === 0, 'אין משמרת יום מיד אחרי לילה');

  // הוגנות
  const vals = Object.values(counts);
  assert(Math.max(...vals) - Math.min(...vals) <= 2, `חלוקה הוגנת (טווח: ${Math.min(...vals)}–${Math.max(...vals)} משמרות)`);

  // המנהל רואה את האילוצים מתורגמים לשבוע
  r = await call('/api/admin/week?week=' + week, { token: admin });
  const danaCon = r.data.constraints[emps[0].id];
  assert(danaCon && JSON.stringify(danaCon.blocked.sort()) === JSON.stringify(danaWeekKeys.sort()), 'המנהל רואה אילוצים חודשיים בתצוגה שבועית');
  assert(danaCon.note === 'בבקשה בלי תחילת שבוע', 'הערת העובד מגיעה למנהל');
  assert(r.data.constraints[emps[2].id] === undefined, 'עובד שלא הגיש — מסומן כ"טרם הזין"');

  /* ===== עריכה ידנית שמפרה כללים — נדחית ===== */
  const ids = emps.map(e => e.id);
  const emptySched = () => {
    const s = {};
    for (let d = 0; d < 7; d++) { s[`${d}-day`] = [null, null]; s[`${d}-night`] = [null, null]; }
    return s;
  };
  let bad = emptySched();
  for (let d = 0; d < 5; d++) bad[`${d}-day`] = [ids[2], null];
  r = await call('/api/admin/schedule', { method: 'POST', token: admin, body: { week, schedule: bad } });
  assert(r.status === 400, 'סידור עם 5 משמרות לעובד — נדחה');
  bad = emptySched();
  bad['2-day'] = [ids[2], null]; bad['2-night'] = [ids[2], null];
  r = await call('/api/admin/schedule', { method: 'POST', token: admin, body: { week, schedule: bad } });
  assert(r.status === 400, 'סידור עם שתי משמרות באותו יום — נדחה');
  bad = emptySched();
  bad['2-night'] = [ids[2], null]; bad['3-day'] = [ids[2], null];
  r = await call('/api/admin/schedule', { method: 'POST', token: admin, body: { week, schedule: bad } });
  assert(r.status === 400, 'סידור עם לילה ומיד יום למחרת — נדחה');
  bad = emptySched();
  bad['2-day'] = [ids[2], ids[2]];
  r = await call('/api/admin/schedule', { method: 'POST', token: admin, body: { week, schedule: bad } });
  assert(r.status === 400, 'אותו עובד פעמיים באותה משמרת — נדחה');
  r = await call('/api/admin/schedule', { method: 'POST', token: admin, body: { week, schedule: sched } });
  assert(r.status === 200, 'סידור חוקי נשמר בהצלחה');

  /* ===== פרסום והרשאות ===== */
  r = await call('/api/admin/publish', { method: 'POST', token: admin, body: { week, published: true } });
  assert(r.status === 200, 'פרסום הסידור');
  r = await call('/api/month?month=' + month, { token: dana });
  assert(r.data.publishedWeeks.length === 1 && r.data.publishedWeeks[0].week === week, 'העובד רואה את הסידור המפורסם בתצוגת החודש');

  r = await call('/api/admin/week?week=' + week, { token: dana });
  assert(r.status === 401, 'עובד חסום מ-API של מנהל');
  r = await call('/api/admin/week?week=' + week, {});
  assert(r.status === 401, 'אורח חסום מ-API של מנהל');

  console.log(failures === 0 ? '\n=== כל הבדיקות עברו ===' : `\n=== ${failures} בדיקות נכשלו ===`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(e => { console.error('שגיאה:', e.message); process.exitCode = 1; });
