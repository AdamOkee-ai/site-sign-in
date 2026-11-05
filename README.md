# Site Sign-In

OKEE's daily site attendance app. It replaces the printed sign-in sheet.

- **Contractors** open the link on their phone, pick the project (for example HEL16 or HEL17), pick their company and name, and sign with a finger. When they leave, they use the **Sign out** tab and enter their time out. No account is needed.
- **Supervisors** sign in (link at the bottom of the page) to see who is on site, sign people out and run the **emergency roll call**.
- **The OKEE site team** also gets the **Summary** (counts by contractor, PDF and CSV report, forgotten sign-outs to fix) and **Setup** (projects, working areas, companies, people, who is a supervisor or site team).

It runs as a normal web page on GitHub Pages, with Firebase holding the data. It works with weak signal: the app is kept on the phone, and sign-ins made offline are sent when the signal returns.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and styles |
| `app.js` | All the screens and logic |
| `db-adapter.js` | Gives the app a simple view of Firestore (and keeps signatures in their own collection) |
| `firebase-shim.js` | Connects to Firebase: background sign-in for contractors, Google/email sign-in for staff, works out each person's level |
| `config.js` | Your Firebase project settings (not secret) |
| `firebase/firestore.rules` | Security rules to paste into Firebase |
| `sw.js` | Offline layer. **Bump `VERSION` on every change** so phones pick up the update |

## One-off setup (about 20 minutes)

### 1. Firebase
Use a **new, separate Firebase project** (free plan is enough). This keeps it away from the live Site Safety Checks rules. (Sharing the Site Safety Checks project also works. See the note at the top of `firebase/firestore.rules`.)

1. <https://console.firebase.google.com> > **Add project**, for example `okee-site-signin`.
2. **Build > Firestore Database > Create database**. Choose `europe-west2` (London) and start in production mode.
3. **Build > Authentication > Get started > Sign-in method**. Enable **Anonymous** (contractors), **Google** and **Email/Password** (supervisors and site team).
4. **Authentication > Settings > Authorized domains**: add `YOUR-ORG.github.io`.
5. **Project settings (gear) > Your apps > Web app (`</>`)**: register an app, then copy the `firebaseConfig` values into `config.js`.
6. **Firestore Database > Rules**: in `firebase/firestore.rules` replace `you@example.com` with the owner's email (lower case), paste the whole file in, then **Publish**. Keep the real email out of this repository.

### 2. GitHub Pages
1. Create a repository (for example `SITE-SIGN-IN`) and upload all these files, keeping the folders.
2. **Settings > Pages**: deploy from the `main` branch, root folder.
3. Open `https://YOUR-ORG.github.io/SITE-SIGN-IN/` on a phone, then **Add to Home Screen**.

### 3. First steps in the app
1. Scroll to the bottom and tap **Site team and supervisor sign-in**. Sign in with the owner's Google account. The **OKEE site team** tag appears at the top.
2. **Setup > Projects and working areas**: add `HEL16` and `HEL17`. Add working areas to a project only if you want people asked which area they are in.
3. **Setup > Import people**: choose the `roster-import.json` file, or paste lines like `Company, First Surname, Role`. Companies and people that already exist are skipped.
4. **Setup > Supervisors and site team**: add each supervisor's or site team member's email. They sign in with that email (or Google account) from the bottom of the page.
5. Give contractors the link or a QR code of the page address.

## Who sees what

| | Contractor (no sign-in) | Supervisor | OKEE site team |
| --- | --- | --- | --- |
| Sign in and sign out (including Sign out for others) | yes | yes | yes |
| On site list, signatures, emergency roll call | no | yes | yes |
| Summary, PDF/CSV, fix forgotten sign-outs | no | no | yes |
| Setup: projects, areas, companies, people, access | no | no | yes |
| Delete an entry | no | no | yes |

These limits are enforced by the Firebase rules, not just hidden in the screens. Signatures are stored in their own collection that only supervisors and the site team can read.

## Keeping personal data out of GitHub
The app contains no names. The people are held in Firebase and loaded through **Setup > Import people**. Keep `roster-import.json` on a company drive, not in this repository.

## Updating
Change the files in the repository, **bump `VERSION` in `sw.js`**, and phones pick the new version up the next time they have signal.

## Good to know
- With no signal, a sign-in is saved on the phone and sent later. The screen says it is saved after a few seconds.
- Time out can be set once by a contractor. Supervisors can correct it, and the site team can undo a time out or delete an entry.
- The PDF cannot print accented letters, so Șerban prints as Serban in the PDF. The app and the CSV keep the accents.
- Not built yet: an automatic nightly report by email. The Site Safety Checks repository has a GitHub job that does this and the same approach would work here.
