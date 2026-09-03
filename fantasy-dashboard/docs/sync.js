// ── Real-time roster sync (optional) ─────────────────────────────────
// When FIREBASE_CONFIG (firebase-config.js) is filled in, the roster
// saved from the photo-upload panel is written to a single shared
// Firestore document instead of only being encoded into a URL. Every
// open tab (yours and your friend's) listens for changes to that
// document and updates live — no link to resend.
//
// If FIREBASE_CONFIG is left null, none of this activates and the app
// falls back to its original behavior (URL hash + localStorage only).
// A failure here (offline, misconfigured project, etc.) never blocks
// scores from loading — it only affects whether roster changes sync.

let db = null;

if (typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG && typeof firebase !== "undefined") {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
  } catch (err) {
    console.warn("Firebase init failed — cloud sync disabled:", err.message);
    db = null;
  }
}

function isCloudSyncEnabled() {
  return !!db;
}

function matchupDocRef() {
  return db.collection("matchups").doc("current");
}

async function saveMatchupToCloud(matchup) {
  if (!db) return false;
  await matchupDocRef().set({ ...matchup, updatedAt: Date.now() });
  return true;
}

// Calls onUpdate(matchup) immediately with the current saved roster
// (if any) and again every time it changes. Returns an unsubscribe
// function. No-ops (returns a no-op unsubscribe) if sync isn't set up.
function watchMatchupFromCloud(onUpdate) {
  if (!db) return () => {};
  return matchupDocRef().onSnapshot(
    (doc) => {
      if (doc.exists) onUpdate(doc.data());
    },
    (err) => console.warn("Cloud sync listener error (non-fatal):", err.message)
  );
}
