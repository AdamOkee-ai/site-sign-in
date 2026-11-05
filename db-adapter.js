/* Site Sign-In: small adapter that gives the app a simple document store on top of Firestore.
   The app talks to db.doc("attendance/ID") and db.collection("attendance").where(...).onSnapshot(...).
   This file maps those names to the real Firestore collections and returns plain snapshots.
   Writes are never allowed to hang the screen: with no signal Firestore keeps them on the phone and sends them
   later, so after a few seconds a write counts as saved on the phone. */
(function () {
  'use strict';
  var MAP = { roster: 'si_roster', attendance: 'si_attendance', sigs: 'si_sigs', config: 'si_config', members: 'si_members' };
  var QUEUE_MS = 4000;
  function real(path) { var p = path.split('/'); p[0] = MAP[p[0]] || p[0]; return p; }

  function make(fb, fs) {
    function settle(p) {
      var timer;
      return Promise.race([
        p.then(function (v) { clearTimeout(timer); return v; }),
        new Promise(function (res) { timer = setTimeout(function () { res('queued'); }, QUEUE_MS); })
      ]);
    }
    function snapDoc(s) { return { id: s.id, exists: s.exists(), data: function () { return s.data(); }, metadata: s.metadata }; }
    function snapQuery(qs) {
      return {
        docs: qs.docs.map(function (d) { return { id: d.id, exists: true, data: function () { return d.data(); }, metadata: d.metadata }; }),
        size: qs.size, empty: qs.empty, metadata: qs.metadata
      };
    }
    function query(path, filters) {
      var coll = real(path).join('/');
      function build() {
        var base = fb.collection(fs, coll);
        return filters.length ? fb.query.apply(null, [base].concat(filters.map(function (f) { return fb.where(f[0], f[1], f[2]); }))) : base;
      }
      return {
        where: function (f, op, v) { return query(path, filters.concat([[f, op, v]])); },
        onSnapshot: function (next, err) {
          return fb.onSnapshot(build(), { includeMetadataChanges: true }, function (qs) { next(snapQuery(qs)); }, function (e) { if (err) err(e); });
        },
        get: function () { return fb.getDocs(build()).then(snapQuery); }
      };
    }
    function docRef(path) { return fb.doc.apply(null, [fs].concat(real(path))); }
    return {
      doc: function (path) {
        return {
          id: path.split('/').pop(),
          get: function () { return fb.getDoc(docRef(path)).then(snapDoc); },
          set: function (d) { return settle(fb.setDoc(docRef(path), d)); },
          update: function (d) { return settle(fb.updateDoc(docRef(path), d)); },
          delete: function () { return settle(fb.deleteDoc(docRef(path))); },
          onSnapshot: function (next, err) {
            return fb.onSnapshot(docRef(path), { includeMetadataChanges: true }, function (s) { next(snapDoc(s)); }, function (e) { if (err) err(e); });
          }
        };
      },
      collection: function (path) { return query(path, []); }
    };
  }
  window.SIDb = { make: make };
})();
