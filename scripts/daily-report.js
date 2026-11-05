/* Site Sign-In: end-of-day attendance report.
   Run by .github/workflows/daily-report.yml. Reads the day's sign-ins from Firestore, makes one PDF per project and
   emails them to the OKEE site team members who have not opted out (Setup > Supervisors and site team).
   This repository and its job logs are public: the logs hold counts only, never names or email addresses. */
process.env.TZ = 'Europe/London';
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const PDFLib = require('pdf-lib');
const R = require('./report-pdf.js');

const pad2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const need = n => { if (!process.env[n]) throw new Error('The ' + n + ' secret is missing. See README > Daily report email.'); return process.env[n]; };

async function main() {
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now)) % 24;
  const from = Number(process.env.REPORT_HOUR || 18);
  // the schedule fires a few times a day (to cover winter/summer time and dropped runs); only the first one inside the window sends
  if (!manual && (hour < from || hour >= from + 3)) { console.log('Not report time yet (London hour ' + hour + ', reports go out from ' + from + ':00). Nothing to do.'); return; }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))) });
  const db = admin.firestore();
  const asked = (process.env.REPORT_DATE || '').trim();
  if (asked && !/^\d{4}-\d{2}-\d{2}$/.test(asked)) throw new Error('REPORT_DATE must look like 2026-11-05');
  const date = asked || iso(now);
  const testTo = (process.env.TEST_TO || '').trim().toLowerCase();

  const sentRef = db.collection('si_config').doc('reportSent');
  if (!manual) { const s = await sentRef.get(); if (s.exists && s.data().date === date) { console.log('Already sent for ' + date + '. Nothing to do.'); return; } }

  const [attSnap, sigSnap, memSnap, cfgSnap] = await Promise.all([
    db.collection('si_attendance').where('date', '==', date).get(),
    db.collection('si_sigs').where('date', '==', date).get(),
    db.collection('si_members').get(),
    db.collection('si_config').doc('projects').get()
  ]);
  const rows = attSnap.docs.map(d => ({ ...d.data(), _id: d.id }));
  const sigs = {}; sigSnap.docs.forEach(d => { sigs[d.id] = d.data().sig; });
  if (!rows.length) { console.log('Nobody signed in on ' + date + '. No report sent.'); return; }

  // site team members who have not turned the report off
  let to = memSnap.docs.filter(d => d.data().role === 'site' && d.data().reports !== false).map(d => d.id.toLowerCase());
  if (testTo) to = [testTo];
  to = [...new Set(to)];
  if (!to.length) { console.log('No site team member has the daily report switched on. Nothing sent.'); return; }

  // one PDF per project, in the order set up in the app
  const order = ((cfgSnap.exists && cfgSnap.data().list) || []).map(p => p.id);
  const byProj = new Map();
  rows.forEach(r => { const k = r.project || 'unknown'; if (!byProj.has(k)) byProj.set(k, { id: k, name: r.projectName || k, rows: [] }); byProj.get(k).rows.push(r); });
  const projects = [...byProj.values()].sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)) || a.name.localeCompare(b.name));
  let logo = null; try { logo = fs.readFileSync(path.join(__dirname, '..', 'icons', 'logo.png')); } catch (e) { /* the PDF works without it */ }
  const created = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  const files = [], lines = [];
  for (const p of projects) {
    const pdf = await R.makePdf(PDFLib, { rows: p.rows, sigs, projectName: p.name, date, logo, created });
    files.push({ filename: 'site-attendance-' + p.name.replace(/[^A-Za-z0-9_-]+/g, '-') + '-' + date + '.pdf', content: Buffer.from(pdf), contentType: 'application/pdf' });
    const open = p.rows.filter(r => !r.timeOut).length;
    lines.push({ name: p.name, signed: p.rows.length, open, out: p.rows.length - open, companies: new Set(p.rows.map(r => r.company)).size });
    console.log('Report ' + date + ' ' + p.name + ': ' + p.rows.length + ' signed in, ' + open + ' with no time out.');
  }

  const site = process.env.SITE_URL || 'https://adamokee-ai.github.io/site-sign-in/';
  const longDate = R.dayName(date) + ' ' + R.dateLong(date);
  const subject = 'Site attendance ' + longDate + ' - ' + lines.map(l => l.name + ': ' + l.signed).join(', ');
  const text = ['Daily site attendance report, ' + longDate, ''].concat(lines.map(l => l.name + ': ' + l.signed + ' signed in, ' + l.out + ' signed out, ' + l.open + ' with no time out, ' + l.companies + ' companies')).concat([
    '', 'The PDF for each project is attached.', lines.some(l => l.open) ? 'People with no time out can be fixed under Summary in the app.' : '', '',
    'You get this because you are on the OKEE site team. To stop these emails, open ' + site + ', sign in, go to Setup > Supervisors and site team and turn off "My daily report email".']).join('\n');
  const html = '<p>Daily site attendance report, <b>' + longDate + '</b></p><ul>' + lines.map(l => '<li><b>' + l.name + '</b>: ' + l.signed + ' signed in, ' + l.out + ' signed out, ' + l.open + ' with no time out, ' + l.companies + ' companies</li>').join('') + '</ul><p>The PDF for each project is attached.' +
    (lines.some(l => l.open) ? ' People with no time out can be fixed under Summary in the app.' : '') + '</p><p style="color:#5A626C;font-size:13px">You get this because you are on the OKEE site team. To stop these emails, open <a href="' + site + '">the app</a>, sign in, go to Setup &gt; Supervisors and site team and turn off &ldquo;My daily report email&rdquo;.</p>';

  const port = Number(process.env.SMTP_PORT || 587);
  const mailer = nodemailer.createTransport({ host: need('SMTP_HOST'), port, secure: port === 465, auth: { user: need('SMTP_USER'), pass: need('SMTP_PASS') } });
  const fromAddr = process.env.MAIL_FROM || process.env.SMTP_USER;
  let sent = 0, failed = 0;
  for (const addr of to) { // one email each, so nobody sees the other recipients
    try { await mailer.sendMail({ from: fromAddr, to: addr, subject, text, html, attachments: files }); sent++; }
    catch (e) { failed++; console.log('One email could not be sent: ' + String(e.message).replace(/[\w.+-]+@[\w.-]+/g, '(address)')); }
  }
  console.log('Sent ' + sent + ' of ' + to.length + ' emails.');
  if (sent && !manual) await sentRef.set({ date, at: Date.now(), recipients: sent });
  if (failed) process.exitCode = 1; // shows the run as failed so it gets noticed
}
main().catch(e => { console.error('Daily report failed: ' + String(e.message).replace(/[\w.+-]+@[\w.-]+/g, '(address)')); process.exit(1); });
