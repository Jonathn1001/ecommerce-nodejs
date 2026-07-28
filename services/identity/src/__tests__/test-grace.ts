// Side-effect module: config.ts reads REFRESH_GRACE_MS at import time, so this has to run
// before anything pulls in `../app` — same rule as `test-key.ts`, just for a different env
// var. Import this FIRST (alongside test-key.ts) in a test file that needs to exercise
// "outside the grace window" behavior without a real ~10s sleep.
//
// 2000ms is a deliberate compromise, not "whatever is fast enough locally". The same file
// has two tests pulling in opposite directions:
//   - one MUST land its replay INSIDE the window with no sleep of its own — it only has
//     the time a real supertest round trip + a Postgres transaction takes, and that needs
//     headroom against a loaded/contended CI runner (Task 11 matrices these suites), or it
//     flakes red with no product defect;
//   - the other deliberately sleeps past the window to prove it expires into genuine REUSE,
//     and derives that sleep from config.REFRESH_GRACE_MS + 50 (so it tracks whatever this
//     file sets, currently ~2050ms).
// Do NOT shrink this back toward the old 200ms to speed up the suite — that trades a real
// flakiness risk in the first test for shaving off ~1.8s. If the two tests ever need
// genuinely different values, split them into two files (config reads the env once, at
// `../app` import time, so one process-wide value can't serve two different targets).
//
// Kept separate from test-key.ts on purpose — that module's job is JWT keypair generation;
// this one's job is timing config. One concern per side-effect module.
process.env.REFRESH_GRACE_MS = "2000";
