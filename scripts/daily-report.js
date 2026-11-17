/* Site Sign-In: end-of-day attendance report.
   Run by .github/workflows/daily-report.yml. Reads the day's sign-ins from Firestore, makes one PDF per project and
   sends each PDF to a Power Automate flow, which saves it in the OKEE SharePoint folder "Daily Sign Ins" (General/HEL16/Safety Reports/Daily Sign Ins).
   This repository and its job logs are public: the logs hold counts only, never names or email addresses. */
process.env.TZ = 'Europe/London';
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const PDFLib = require('pdf-lib');
const R = require('./report-pdf.js');

const pad2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const need = n => { if (!process.env[n]) throw new Error('The ' + n + ' secret is missing. See README > Daily report to SharePoint.'); return process.env[n]; };

async function main() {
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now)) % 24;
  const from = Number(process.env.REPORT_HOUR || 21);
  // the schedule fires a few times a day (to cover winter/summer time and dropped runs); only the first one inside the window sends
  if (!manual && (hour < from || hour >= from + 3)) { console.log('Not report time yet (London hour ' + hour + ', reports go out from ' + from + ':00). Nothing to do.'); return; }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))) });
  const db = admin.firestore();
  const asked = (process.env.REPORT_DATE || '').trim();
  if (asked && !/^\d{4}-\d{2}-\d{2}$/.test(asked)) throw new Error('REPORT_DATE must look like 2026-11-05');
  const date = asked || iso(now);

  const sentRef = db.collection('si_config').doc('reportSent');
  if (!manual) { const s = await sentRef.get(); if (s.exists && s.data().date === date) { console.log('Already sent for ' + date + '. Nothing to do.'); return; } }

  const [attSnap, sigSnap, cfgSnap, rosSnap, repSnap] = await Promise.all([
    db.collection('si_attendance').where('date', '==', date).get(),
    db.collection('si_sigs').where('date', '==', date).get(),
    db.collection('si_config').doc('projects').get(),
    db.collection('si_roster').get(),
    db.collection('si_config').doc('report').get()
  ]);
  // REPORT_PROJECTS (set in the workflow) lists the projects sent to the main flow SHAREPOINT_FLOW_URL (HEL16 folder), e.g. 'HEL16'; blank means all projects.
  // A project with its own flow secret SHAREPOINT_FLOW_URL_<PROJECT> (e.g. SHAREPOINT_FLOW_URL_HEL17) goes to that flow instead, which saves it in that project's folder.
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const only = (process.env.REPORT_PROJECTS || '').split(',').map(norm).filter(Boolean);
  const ownUrl = r => process.env['SHAREPOINT_FLOW_URL_' + norm(r.projectName)] || process.env['SHAREPOINT_FLOW_URL_' + norm(r.project)] || '';
  const wanted = r => !!ownUrl(r) || !only.length || only.includes(norm(r.projectName)) || only.includes(norm(r.project));
  const allRows = attSnap.docs.map(d => ({ ...d.data(), _id: d.id }));
  const skipped = [...new Set(allRows.filter(r => !wanted(r)).map(r => r.projectName || r.project || 'unknown'))];
  if (skipped.length) console.log('Not sent (no SharePoint folder set up for it): ' + skipped.join(', '));
  const rows = allRows.filter(wanted);
  const sigs = {}; sigSnap.docs.forEach(d => { sigs[d.id] = d.data().sig; });
  const people = new Map(); rosSnap.docs.forEach(d => (d.data().people || []).forEach(p => people.set(d.id + '|' + p.id, p)));
  const sortBy = repSnap.exists ? repSnap.data().sort : 'time';
  if (!rows.length) { console.log('Nobody signed in on ' + date + '. No report sent.'); return; }

  // one PDF per project, in the order set up in the app
  const order = ((cfgSnap.exists && cfgSnap.data().list) || []).map(p => p.id);
  const byProj = new Map();
  rows.forEach(r => { const k = r.project || 'unknown'; if (!byProj.has(k)) byProj.set(k, { id: k, name: r.projectName || k, rows: [] }); byProj.get(k).rows.push(r); });
  const projects = [...byProj.values()].sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)) || a.name.localeCompare(b.name));
  let logo = null; try { logo = fs.readFileSync(path.join(__dirname, '..', 'icons', 'logo.png')); } catch (e) { /* the PDF works without it */ }
  const created = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  const files = [];
  for (const p of projects) {
    let teams = null;
    try { const a = await db.collection('si_config').doc('alloc-' + p.id + '-' + date).get(); if (a.exists && Array.isArray(a.data().groups) && a.data().groups.length) teams = a.data().groups; } catch (e) { /* the report works without teams */ }
    const pdf = await R.makePdf(PDFLib, { rows: p.rows, sigs, projectName: p.name, date, logo, created, people, sortBy, teams });
    // a manual run adds the time to the name, because SharePoint will not overwrite a file that is already there
    const filename = 'site-attendance-' + p.name.replace(/[^A-Za-z0-9_-]+/g, '-') + '-' + date + (manual ? '-rerun-' + created.replace(':', '') : '') + '.pdf';
    files.push({ filename, project: p.name, content: Buffer.from(pdf), url: ownUrl(p.rows[0]) });
    const open = p.rows.filter(r => !r.timeOut).length;
    console.log('Report ' + date + ' ' + p.name + ': ' + p.rows.length + ' signed in, ' + open + ' with no time out.');
  }

  // post each PDF to the Power Automate flow (the web address is a secret: it works like a password)
  const mainUrl = files.some(f => !f.url) ? need('SHAREPOINT_FLOW_URL') : '';
  let sent = 0, failed = 0;
  for (const f of files) {
    let ok = false, status = 0;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const res = await fetch(f.url || mainUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'Daily Sign Ins', fileName: f.filename, contentBase64: f.content.toString('base64'), project: f.project, date }) });
        status = res.status; ok = res.ok;
      } catch (e) { status = 0; }
      if (!ok && attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
    }
    if (ok) sent++; else { failed++; console.log('Upload of ' + f.project + ' failed (HTTP ' + status + ').'); }
  }
  console.log('Sent ' + sent + ' of ' + files.length + ' PDFs to SharePoint.');
  if (sent && !failed && !manual) await sentRef.set({ date, at: Date.now(), uploaded: sent });
  if (failed) process.exitCode = 1; // shows the run as failed so it gets noticed
}
main().catch(e => { console.error('Daily report failed: ' + String(e.message).replace(/[\w.+-]+@[\w.-]+/g, '(address)')); process.exit(1); });
