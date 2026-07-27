// Side-effect module: config.ts reads REFRESH_GRACE_MS at import time, so this has to run
// before anything pulls in `../app` — same rule as `test-key.ts`, just for a different env
// var. Import this FIRST (alongside test-key.ts) in a test file that needs to exercise
// "outside the grace window" behavior: it shrinks the production default (10s) down to
// 200ms, so a test can clear the window with a ~250ms wait instead of a real ~10s sleep.
//
// Kept separate from test-key.ts on purpose — that module's job is JWT keypair generation;
// this one's job is timing config. One concern per side-effect module.
process.env.REFRESH_GRACE_MS = "200";
