import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

// Integration (not unit): spawns a real child process. Slow relative to the rest
// of the suite (a cold tsx transform is not fast), and the CI "quality" lane
// excludes *.int.test.ts — this runs in the integration lane instead.
//
// Why this test exists, and why the unit test isn't enough: the unit test's
// `vi.resetModules()` only clears vitest's own module cache. It never touches
// `globalThis`, never touches `process.env`, and never crosses a process
// boundary — so it cannot detect a guard that is wrong on exactly those axes.
// Fix round 1 of this task shipped (then reverted) a `process.env`-based guard
// that silently disabled the SDK in the one process that actually runs
// application code, while still logging "tracing_started" exactly once and
// passing every existing test. This test is the one built specifically to catch
// that class of bug: it spawns a process the way a real service starts (preload
// via NODE_OPTIONS, not an in-process import) and inspects what the *spawned*
// process's SDK actually did, not what the log said.

const execFileAsync = promisify(execFile);

// __dirname, not import.meta.url: this repo's tsconfig targets "module":
// "commonjs" (see tsconfig.base.json), which rejects import.meta outright
// (TS1343). __dirname is the repo's own established pattern for this — see
// e.g. every service's src/db.ts (`path.resolve(__dirname, "../.env")`).
const repoRoot = path.resolve(__dirname, "../../../..");
const tracingPreloadPath = path.resolve(__dirname, "../tracing.ts");
const fixturePath = path.resolve(__dirname, "tracing-fixture.ts");
// The local tsx CLI binary, not plain `node` and not `npx tsx`: every service in
// this repo starts via `"start": "tsx src/main.ts"`, which resolves to exactly
// this binary. This choice is load-bearing, not stylistic — `tsx <file>` respawns
// itself into a child process (see task-2-report.md fix round 1), and it is
// specifically that parent-sets-env / child-inherits-env handoff that the
// previously-shipped process.env guard bug depended on. A plain `node <fixture>`
// invocation is a single process with no such handoff, and was confirmed NOT to
// discriminate against that bug during this test's own development (see fix
// round 2 in task-2-report.md) — it must go through the real respawn to be able
// to catch a regression of it.
const tsxBinPath = path.resolve(repoRoot, "node_modules/.bin/tsx");

// The all-zero trace id is not a real identifier — it's the literal sentinel
// @opentelemetry/api's no-op tracer returns when no SDK/TracerProvider has been
// registered in the current process. Seeing it here means the tracing preload
// did not actually start an SDK in the process that ran the fixture.
const NO_SDK_REGISTERED_TRACE_ID = "00000000000000000000000000000000";

describe("tracing bootstrap (integration — spawns a real child process)", () => {
  it("registers a working SDK in the process that runs application code", async () => {
    const { stdout } = await execFileAsync(tsxBinPath, [fixturePath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // Same preload mechanism every service uses in production:
        // NODE_OPTIONS=--import tsx --import file://.../tracing.ts, and the same
        // `tsx <file>` entry point every service's "start" script uses — which is
        // what actually makes the parent-process/respawned-child shape (and the
        // guard bug that shape exposed) real here rather than assumed away.
        NODE_OPTIONS: `--import tsx --import file://${tracingPreloadPath}`,
        OTEL_SERVICE_NAME: "tracing-int-test",
        // No collector needed: the fixture reads the trace id off the span
        // context synchronously and exits before any batch export could fire.
        // Set anyway, belt-and-braces, so this test can never depend on one.
        OTEL_TRACES_EXPORTER: "none",
      },
      timeout: 30_000,
    });

    // Preload logging (tracing.ts's own "tracing_started" line) and the
    // fixture's own output both land on stdout; the fixture's JSON is always
    // the last line, since it's written immediately before the fixture exits.
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    let traceId: string;
    try {
      ({ traceId } = JSON.parse(lastLine) as { traceId: string });
    } catch {
      throw new Error(
        `Fixture did not print the expected JSON on its last stdout line. ` +
          `Full stdout:\n${stdout}`
      );
    }

    expect(
      traceId,
      `Got the all-zero sentinel trace id ("${NO_SDK_REGISTERED_TRACE_ID}"), which ` +
        `means no OTel SDK was registered in the process that ran the fixture — the ` +
        `tracing preload did not actually start tracing there, even though it may ` +
        `still have logged "tracing_started" (that log line alone does not prove the ` +
        `SDK is active in the process that runs application code; see tracing.ts and ` +
        `task-2-report.md fix round 1 for the guard bug this test exists to catch).`
    ).not.toBe(NO_SDK_REGISTERED_TRACE_ID);
  }, 30_000);
});
