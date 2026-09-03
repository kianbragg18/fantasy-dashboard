// ── Firebase project config ──────────────────────────────────────────
// Paste your Firebase project's web config here (see setup steps).
//
// This is NOT a secret. Firebase's web config (apiKey included) is
// meant to be public — it just tells the SDK which project to talk
// to. Actual access control is enforced by Firestore Security Rules
// (set in the Firebase console), not by hiding this object. It's
// fine for this to be committed to a public repo.
//
// Leave this as `null` and the app works exactly as before (roster
// shared via a copied link) — cloud sync is entirely optional and
// turns on automatically once this is filled in.

const FIREBASE_CONFIG = null;

// Example, once you've created a project (see chat for setup steps):
// const FIREBASE_CONFIG = {
//   apiKey: "AIzaSy...",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   storageBucket: "your-project.appspot.com",
//   messagingSenderId: "123456789",
//   appId: "1:123456789:web:abcdef123456",
// };
