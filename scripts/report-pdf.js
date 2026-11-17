/* Site Sign-In: builds the daily attendance PDF for one project.
   Same layout as the Download PDF button in the app. Used by scripts/daily-report.js (and testable on its own).
   Text is limited to plain letters (Helvetica), so accents are dropped in the PDF. The app and CSV keep them. */
'use strict';
const SIG_W = 320, SIG_H = 110;
const pdfAscii = t => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?');
const cmpTime = (a, b) => (a || '99:99').localeCompare(b || '99:99');
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayName = s => parseDate(s).toLocaleDateString('en-GB', { weekday: 'long' });
const dateLong = s => parseDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function groupByCompany(rows, cmp) {
  const m = new Map();
  rows.forEach(r => { const k = r.company || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, rs]) => ({ name, rows: rs.sort(cmp || ((a, b) => cmpTime(a.timeIn, b.timeIn) || a.name.localeCompare(b.name))) }));
}

/* o: { rows, sigs (map id -> stroke JSON string), projectName, date (YYYY-MM-DD), logo (PNG bytes or null), created ('HH:MM') } */
async function makePdf(L, o) {
  const { PDFDocument, StandardFonts, rgb } = L;
  const rows = o.rows, sigs = o.sigs || {}, date = o.date;
  const doc = await PDFDocument.create();
  const fR = await doc.embedFont(StandardFonts.Helvetica), fB = await doc.embedFont(StandardFonts.HelveticaBold);
  const MM = 72 / 25.4, PW = 210, PH = 297;
  const info = r => (o.people && o.people.get(r.companyId + '|' + r.personId)) || null;
  const numOf = r => { const p = info(r); return p && p.n ? String(p.n) : ''; };
  const parts = r => { const p = info(r); if (p && (p.f || p.l)) return [String(p.f || '').trim(), String(p.l || '').trim()]; const w = String(r.name || '').trim().split(/\s+/); return [w[0] || '', w.slice(1).join(' ')]; };
  const cmp = o.sortBy === 'first' ? (a, b) => { const x = parts(a), y = parts(b); return x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]); }
    : o.sortBy === 'last' ? (a, b) => { const x = parts(a), y = parts(b); return x[1].localeCompare(y[1]) || x[0].localeCompare(y[0]); } : null;
  const hasArea = rows.some(r => r.area), hasNum = rows.some(r => numOf(r));
  const M = 14, W = PW - 2 * M, RH = 11;
  const C = a => rgb(a[0] / 255, a[1] / 255, a[2] / 255);
  const INK = [20, 23, 27], RED = [225, 16, 10], GREY = [90, 98, 108], LINE = [211, 216, 222], WHITE = [255, 255, 255], PALE = [238, 240, 243];
  const cols = [{ k: 'name', t: 'Name', w: 0 }].concat(hasNum ? [{ k: 'num', t: 'No.', w: 12 }] : []).concat([{ k: 'role', t: 'Role', w: 20 }])
    .concat(hasArea ? [{ k: 'area', t: 'Area', w: 22 }] : [])
    .concat([{ k: 'in', t: 'In', w: 14 }, { k: 'out', t: 'Out', w: 14 }, { k: 'sig', t: 'Signature', w: 30 }]);
  cols[0].w = W - cols.reduce((n, c) => n + c.w, 0);
  const xs = []; let xx = M; cols.forEach(c => { xs.push(xx); xx += c.w; });
  let pg = doc.addPage([PW * MM, PH * MM]), y = M;
  const Y = mm => (PH - mm) * MM, X = mm => mm * MM;
  const txt = (str, x, base, size, bold, col, right) => {
    str = pdfAscii(str);
    const f = bold ? fB : fR;
    const w = f.widthOfTextAtSize(str, size);
    pg.drawText(str, { x: right ? X(x) - w : X(x), y: Y(base), size, font: f, color: C(col) });
  };
  const rect = (x, top, w, h, col) => pg.drawRectangle({ x: X(x), y: Y(top + h), width: X(w), height: h * MM, color: C(col) });
  const hline = (x1, x2, yy, col, th) => pg.drawLine({ start: { x: X(x1), y: Y(yy) }, end: { x: X(x2), y: Y(yy) }, thickness: th, color: C(col) });
  const fit = (t, w) => { t = pdfAscii(t); const max = (w - 3) * MM; if (fR.widthOfTextAtSize(t, 9.5) <= max) return t; while (t.length > 1 && fR.widthOfTextAtSize(t + '...', 9.5) > max) t = t.slice(0, -1); return t + '...'; };
  if (o.logo) { try { const png = await doc.embedPng(o.logo); pg.drawImage(png, { x: X(M), y: Y(y + 14.6), width: 12 * MM, height: 14.6 * MM }); } catch (e) { /* logo is optional */ } }
  txt('DAILY SITE ATTENDANCE RECORD', M + 16, y + 6, 16, true, INK);
  txt(o.projectName + '   |   ' + dayName(date) + ' ' + dateLong(date), M + 16, y + 12.5, 10.5, false, GREY);
  y += 19; hline(M, M + W, y, RED, 2.2); y += 7;
  const inN = rows.filter(r => !r.timeOut).length, groups = groupByCompany(rows, cmp);
  txt('Signed in: ' + rows.length + '      No time out: ' + inN + '      Signed out: ' + (rows.length - inN) + '      Companies: ' + groups.length, M, y, 10, true, INK);
  y += 6;
  const colHead = () => { rect(M, y, W, 7, PALE); cols.forEach((c, i) => txt(c.t.toUpperCase(), xs[i] + 1.5, y + 4.8, 8.5, true, GREY)); y += 7; };
  const groupHead = (g, cont) => {
    rect(M, y, W, 8, INK); rect(M, y + 8, W, 0.7, RED);
    txt(g.name.toUpperCase() + (cont ? '  (continued)' : ''), M + 2, y + 5.6, 11, true, WHITE);
    txt(g.rows.filter(r => !r.timeOut).length + ' no time out  |  ' + g.rows.length + ' signed in', M + W - 2, y + 5.5, 9, false, WHITE, true);
    y += 8.7; colHead();
  };
  const sigDraw = (sig, bx, by, bw, bh) => {
    let st = []; try { st = JSON.parse(sig || '[]'); } catch (e) { /* unreadable signature: leave blank */ }
    const k = Math.min(bw / SIG_W, bh / SIG_H);
    st.forEach(s => {
      if (!Array.isArray(s) || s.length < 2) return;
      let d = 'M' + s[0][0] + ' ' + s[0][1]; for (let i = 1; i < s.length; i++) d += ' L' + s[i][0] + ' ' + s[i][1];
      pg.drawSvgPath(d, { x: X(bx), y: Y(by), scale: k * MM, borderWidth: 0.7, borderColor: C(INK), borderLineCap: L.LineCapStyle.Round });
    });
  };
  let anyWalk = false;
  groups.forEach(g => {
    if (y + 8.7 + 7 + RH > PH - 16) { pg = doc.addPage([PW * MM, PH * MM]); y = M; }
    groupHead(g, false);
    g.rows.forEach(r => {
      if (y + RH > PH - 16) { pg = doc.addPage([PW * MM, PH * MM]); y = M; groupHead(g, true); }
      if (r.walkIn) anyWalk = true;
      const vals = { name: fit(r.name + (r.walkIn ? ' *' : ''), cols[0].w), num: fit(numOf(r), 12), role: fit(r.role || '', 20), area: fit(r.area || '', 22), in: r.timeIn || '', out: r.timeOut || '-' };
      cols.forEach((c, i) => { if (c.k !== 'sig') txt(vals[c.k], xs[i] + 1.5, y + 6.6, 9.5, false, (c.k === 'out' && !r.timeOut) ? RED : INK); });
      const si = cols.length - 1; sigDraw(sigs[r._id], xs[si] + 1.5, y + 1, cols[si].w - 3, RH - 2);
      hline(M, M + W, y + RH, LINE, 0.6); y += RH;
    });
    y += 5;
  });
  if (!groups.length) txt('Nobody signed in on this day.', M, y, 10, false, GREY);
  if (anyWalk) txt('* Not on the company roster', M, Math.min(y + 2, PH - 20), 8.5, false, GREY);

  /* teams and areas page */
  if (o.teams && o.teams.length) {
    const byId = new Map(rows.map(r => [r.personId, r]));
    const used = new Set(); o.teams.forEach(g => { if (g.sup) used.add(g.sup.id); (g.m || []).forEach(x => used.add(x.id)); });
    const loose = rows.filter(r => !used.has(r.personId));
    pg = doc.addPage([PW * MM, PH * MM]); y = M;
    txt('TEAMS AND AREAS', M, y + 6, 16, true, INK); y += 9;
    txt(o.projectName + '   |   ' + dayName(date) + ' ' + dateLong(date), M, y + 3, 10.5, false, GREY); y += 6; hline(M, M + W, y, RED, 2.2); y += 6;
    const TR = 7.5;
    const tcols = [{ t: 'Name', x: M + 1.5 }, { t: 'Company', x: M + 78 }, { t: 'No.', x: M + 118 }, { t: 'In', x: M + 138 }, { t: 'Out', x: M + 158 }];
    const trow = (nm, co, num, tin, tout, bold, red) => {
      if (y + TR > PH - 16) { pg = doc.addPage([PW * MM, PH * MM]); y = M; }
      txt(fit(nm, 76), tcols[0].x, y + 5.2, 9.5, bold, INK); txt(fit(co || '', 38), tcols[1].x, y + 5.2, 9.5, false, INK);
      txt(fit(num || '', 18), tcols[2].x, y + 5.2, 9.5, false, INK); txt(tin || '', tcols[3].x, y + 5.2, 9.5, false, INK); txt(tout || '', tcols[4].x, y + 5.2, 9.5, false, red ? RED : INK);
      hline(M, M + W, y + TR, LINE, 0.6); y += TR;
    };
    const thead = (title, right, grey) => {
      if (y + 8.7 + 7 + TR * 2 > PH - 16) { pg = doc.addPage([PW * MM, PH * MM]); y = M; }
      rect(M, y, W, 8, grey ? GREY : INK); rect(M, y + 8, W, 0.7, RED);
      txt(title.toUpperCase(), M + 2, y + 5.6, 11, true, WHITE); txt(right, M + W - 2, y + 5.5, 9, false, WHITE, true); y += 8.7;
      rect(M, y, W, 6, PALE); tcols.forEach(c => txt(c.t.toUpperCase(), c.x, y + 4.2, 8, true, GREY)); y += 6;
    };
    const line = (x, role) => {
      const r = byId.get(x.id);
      const num = r ? numOf(r) : '';
      trow(x.n + (role ? '  (' + role + ')' : ''), x.c || (r && r.company) || '', num, r ? (r.timeIn || '') : 'not signed in', r ? (r.timeOut || '-') : '', !!role, r && !r.timeOut);
    };
    o.teams.forEach((g, i) => {
      const n = (g.m || []).length + (g.sup ? 1 : 0);
      thead(g.area || ('Team ' + (i + 1)), (g.sup ? 'Supervisor: ' + g.sup.n + '  |  ' : '') + n + ' people', false);
      if (g.sup) line(g.sup, 'Supervisor');
      (g.m || []).forEach(x => line(x, ''));
      if (!n) trow('Nobody in this team', '', '', '', '', false, false);
      y += 5;
    });
    if (loose.length) {
      thead('Not in a team', loose.length + ' people', true);
      loose.forEach(r => trow(r.name, r.company, numOf(r), r.timeIn || '', r.timeOut || '-', false, !r.timeOut));
    }
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => { pg = p; txt('Okee Electrics  |  Site Sign-In', M, PH - 8, 8, false, GREY); txt('Page ' + (i + 1) + ' of ' + pages.length + '  |  Created ' + (o.created || ''), M + W, PH - 8, 8, false, GREY, true); });
  return await doc.save();
}

module.exports = { makePdf, groupByCompany, dayName, dateLong };
