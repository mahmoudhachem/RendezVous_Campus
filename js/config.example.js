/*
 * Live groups between phones need a small shared database. Paste your Firebase web config here
 * (Firebase console → Project settings → Your apps → Web app → "firebaseConfig").
 *
 * While this stays null, "Plan together" still works between tabs/windows of the SAME browser
 * (handy to test and to demo on one computer), but not between different phones.
 *
 * Example:
 * window.RDV_FIREBASE = {
 *   apiKey: "AIza...",
 *   authDomain: "rendezvous-campus.firebaseapp.com",
 *   databaseURL: "https://rendezvous-campus-default-rtdb.europe-west1.firebasedatabase.app",
 *   projectId: "rendezvous-campus",
 *   appId: "1:123:web:abc"
 * };
 */
// Copy this file to js/config.js (which git ignores) and paste your config there.
window.RDV_FIREBASE = null;
