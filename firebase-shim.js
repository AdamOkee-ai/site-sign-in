/* Site Sign-In: Firebase layer for the hosted app.
   Contractors are signed in anonymously in the background (no account needed).
   Supervisors and the OKEE site team sign in with Google or email. Their level comes from the Firestore rules
   (owner email) and the si_members collection (added in the app under Setup). */
const V = '10.14.1';
const base = 'https://www.gstatic.com/firebasejs/' + V + '/';
const CFG = window.SI_CONFIG || {};
const done = window.__siResolve, failed = window.__siReject;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- full-screen messages ---------- */
const gate = document.createElement('div'); gate.id = 'gate'; gate.hidden = true; document.body.appendChild(gate);
function showGate(html, closable) {
  gate.innerHTML = '<div class="gbox">' + (closable ? '<button class="glink gx" id="gX" type="button">Close</button>' : '') + html + '</div>'; gate.hidden = false;
  const x = gate.querySelector('#gX'); if (x) x.onclick = hideGate;
}
function hideGate() { gate.hidden = true; gate.innerHTML = ''; }

if (!CFG.firebase || !CFG.firebase.apiKey || String(CFG.firebase.apiKey).startsWith('PASTE')) {
  showGate('<h2>Almost ready</h2><p>This copy of the app is not connected to its Firebase project yet. Add the project settings to <code>config.js</code> (see the README).</p>');
  failed(new Error('missing Firebase config'));
  throw new Error('SI: missing Firebase config');
}

let fb;
try {
  const [app, auth, fsx] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(base + f)));
  fb = { ...app, ...auth, ...fsx };
} catch (e) {
  showGate('<h2>Open once with signal</h2><p>This phone has not downloaded the app yet. Open it once with mobile data or Wi-Fi, then it also works with weak signal.</p><button class="gbtn" onclick="location.reload()">Try again</button>');
  failed(e); throw e;
}

const app = fb.initializeApp(CFG.firebase);
const auth = fb.getAuth(app);
let fs;
try { fs = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) }); }
catch (e) { fs = fb.getFirestore(app); }

const nice = e => {
  const c = (e && e.code) || '';
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return 'Sign-in was closed before it finished.';
  if (c.includes('popup-blocked')) return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (c.includes('unauthorized-domain')) return 'This web address is not allowed to sign in yet. Add it under Authentication > Settings > Authorized domains in Firebase.';
  if (c.includes('network')) return 'No signal. Signing in needs a connection.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'That email and password do not match.';
  if (c.includes('email-already-in-use')) return 'That email already has an account. Use Sign in instead.';
  if (c.includes('weak-password')) return 'Use a password of at least 6 characters.';
  if (c.includes('invalid-email')) return 'That email address does not look right.';
  if (c.includes('admin-restricted') || c.includes('operation-not-allowed')) return 'This sign-in method is not switched on in Firebase yet (Authentication > Sign-in method).';
  return 'Could not sign in (' + (c || 'error') + ').';
};

/* ---------- staff sign-in ---------- */
function staffScreen(msg, mode) {
  const err = msg ? '<p class="gerr">' + esc(msg) + '</p>' : '';
  if (mode !== 'email') {
    showGate('<h2>Site team and supervisors</h2><p>Sign in to see who is on site and manage the lists. Contractors do not need to sign in.</p>' + err +
      '<button class="gbtn" id="gGoogle" type="button">Sign in with Google</button><button class="gbtn alt" id="gEmail" type="button">Sign in with email</button>', true);
    gate.querySelector('#gGoogle').onclick = async () => { try { await fb.signInWithPopup(auth, new fb.GoogleAuthProvider()); location.reload(); } catch (e) { staffScreen(nice(e)); } };
    gate.querySelector('#gEmail').onclick = () => staffScreen('', 'email');
    return;
  }
  showGate('<h2>Sign in with email</h2>' + err +
    '<label class="gl">Email<input id="gE" type="email" autocomplete="email" inputmode="email"></label>' +
    '<label class="gl">Password<input id="gP" type="password" autocomplete="current-password"></label>' +
    '<button class="gbtn" id="gIn" type="button">Sign in</button><button class="gbtn alt" id="gNew" type="button">Create account</button>' +
    '<div class="glinks"><button class="glink" id="gReset" type="button">Forgot password</button><button class="glink" id="gBack" type="button">Back</button></div>', true);
  const E = () => gate.querySelector('#gE').value.trim(), P = () => gate.querySelector('#gP').value;
  gate.querySelector('#gIn').onclick = async () => { try { await fb.signInWithEmailAndPassword(auth, E(), P()); location.reload(); } catch (e) { staffScreen(nice(e), 'email'); } };
  gate.querySelector('#gNew').onclick = async () => {
    try { const c = await fb.createUserWithEmailAndPassword(auth, E(), P()); await fb.sendEmailVerification(c.user); verifyScreen(c.user); } catch (e) { staffScreen(nice(e), 'email'); }
  };
  gate.querySelector('#gReset').onclick = async () => {
    if (!E()) { staffScreen('Type your email first, then tap Forgot password.', 'email'); return; }
    try { await fb.sendPasswordResetEmail(auth, E()); staffScreen('A reset link has been sent to ' + E() + '.', 'email'); } catch (e) { staffScreen(nice(e), 'email'); }
  };
  gate.querySelector('#gBack').onclick = () => staffScreen();
}
function verifyScreen(user, msg) {
  showGate('<h2>Check your email</h2><p>We sent a link to <b>' + esc(user.email) + '</b>. Tap it, then come back and tap Continue.</p>' + (msg ? '<p class="gerr">' + esc(msg) + '</p>' : '') +
    '<button class="gbtn" id="gDone" type="button">Continue</button><div class="glinks"><button class="glink" id="gResend" type="button">Send the link again</button><button class="glink" id="gOut" type="button">Cancel</button></div>');
  gate.querySelector('#gDone').onclick = async () => {
    try { await user.reload(); await user.getIdToken(true); } catch (e) {}
    if (auth.currentUser && auth.currentUser.emailVerified) location.reload(); else verifyScreen(user, 'Not verified yet. Tap the link in the email first.');
  };
  gate.querySelector('#gResend').onclick = async () => { try { await fb.sendEmailVerification(user); verifyScreen(user, 'Sent again.'); } catch (e) { verifyScreen(user, nice(e)); } };
  gate.querySelector('#gOut').onclick = () => fb.signOut(auth).then(() => location.reload());
}

/* ---------- who is this? 'operative' (contractor), 'supervisor' or 'site' (OKEE site team) ---------- */
async function roleOf(user) {
  if (!user || user.isAnonymous || !user.email) return 'operative';
  const verified = user.emailVerified || user.providerData.some(p => p.providerId === 'google.com');
  if (!verified) return 'operative';
  const email = user.email.toLowerCase();
  try {
    // only the site team (owners and people added as site team) may read the whole members list
    await fb.getDocs(fb.query(fb.collection(fs, 'si_members'), fb.limit(1)));
    return 'site';
  } catch (e) { if (!e || e.code !== 'permission-denied') throw e; }
  try {
    const s = await fb.getDoc(fb.doc(fs, 'si_members', email));
    if (s.exists() && s.data().role === 'supervisor') return 'supervisor';
  } catch (e) { if (!e || e.code !== 'permission-denied') throw e; }
  return 'operative';
}
async function roleOfSafe(user) {
  try { return await roleOf(user); }
  catch (e) { try { return localStorage.getItem('si.role.' + (user.email || '').toLowerCase()) || 'operative'; } catch (x) { return 'operative'; } }
}

/* ---------- the backend the app talks to ---------- */
function makeBackend(user, role) {
  return {
    kind: 'firebase', role, uid: user.uid,
    email: user.isAnonymous ? '' : (user.email || '').toLowerCase(),
    db: window.SIDb.make(fb, fs),
    download: async (filename, data) => {
      const type = /\.pdf$/i.test(filename) ? 'application/pdf' : /\.csv$/i.test(filename) ? 'text/csv' : 'application/octet-stream';
      const blob = new Blob([data], { type });
      const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
      if (mobile && navigator.canShare) {
        const file = new File([blob], filename, { type });
        if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e && e.name === 'AbortError') throw { code: 'declined' }; } }
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    },
    signIn: () => staffScreen(),
    signOut: async () => { try { await fb.signOut(auth); } catch (e) {} location.reload(); },
  };
}

/* ---------- start ---------- */
let started = false;
fb.onAuthStateChanged(auth, async user => {
  if (started) return;
  if (!user) {
    try { await fb.signInAnonymously(auth); } // onAuthStateChanged fires again with the anonymous user
    catch (e) {
      showGate('<h2>Can’t connect</h2><p>' + esc(e && e.code === 'auth/admin-restricted-operation' ? 'Anonymous sign-in is not switched on in Firebase yet (Authentication > Sign-in method > Anonymous).' : 'Check the signal and try again.') + '</p><button class="gbtn" onclick="location.reload()">Try again</button>');
      failed(e);
    }
    return;
  }
  const pwd = user.providerData.some(p => p.providerId === 'password');
  if (pwd && !user.emailVerified) { verifyScreen(user); return; }
  started = true;
  const role = await roleOfSafe(user);
  if (!user.isAnonymous) { try { localStorage.setItem('si.role.' + user.email.toLowerCase(), role); } catch (e) {} }
  if (!user.isAnonymous && role === 'operative') {
    showGate('<h2>Not added yet</h2><p>You are signed in as <b>' + esc(user.email) + '</b>, but this address has not been added as a supervisor or site team member. Ask the site team to add it under Setup.</p><button class="gbtn" type="button" id="gOut">Back to the sign-in app</button>');
    gate.querySelector('#gOut').onclick = () => fb.signOut(auth).then(() => location.reload());
  }
  done(makeBackend(user, role));
});
