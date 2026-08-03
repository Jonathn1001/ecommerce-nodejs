// Runs the invariant checker and asserts a scenario's expected outcome, exiting non-zero
// with the offending rows printed when reality disagrees.
//
// This lives in a file rather than inline `tsx -e '...'` inside chaos.sh on purpose: the
// poison assertion is a dozen lines of logic, and nesting that in single quotes inside a
// bash case statement is where a quoting slip turns a real assertion into a no-op. Global
// Constraint 1 of this slice is that no check may be incapable of failing.
//
// Usage: tsx infra/scripts/assert-invariants.ts clean|poison
import { runInvariants, type Violation } from "./check-invariants";

const MODE = process.argv[2];
const PGBASE = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5432";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const DRAIN_SECONDS = Number(process.env.DRAIN_SECONDS ?? 60);
// One poison message parks once PER CONSUMER GROUP, not once overall, so the expected
// depth is a property of how many groups subscribe to the topic — see chaos.sh's poison
// scenario for the count and why.
const EXPECT_PARKED = Number(process.env.EXPECT_PARKED ?? 2);

const dump = (v: Violation[]) => JSON.stringify(v, null, 2);

// Kafka rows are {topic, depth}; Rabbit rows are {queue, depth}.
const parkedTotal = (v: Violation[]) =>
  v
    .flatMap((x) => x.rows as { depth: number }[])
    .reduce((n, r) => n + Number(r.depth ?? 0), 0);

async function main() {
  if (MODE !== "clean" && MODE !== "poison")
    throw new Error("usage: assert-invariants.ts clean|poison");

  const violations = await runInvariants({
    pgBase: PGBASE,
    brokers: BROKERS,
    waitForDrainSeconds: DRAIN_SECONDS,
  });

  if (MODE === "clean") {
    if (violations.length > 0) {
      console.error(dump(violations));
      process.exit(1);
    }
    console.log("invariants clean");
    return;
  }

  // poison: the ONLY acceptable violation is the DLQ one, reporting exactly the messages
  // we parked on purpose. A stalled partition would additionally leave orders non-terminal
  // (INV1) or outbox rows unsent (INV4), and a DRAIN_TIMEOUT would appear here too — all of
  // which fail this check rather than being swallowed.
  const names = [...new Set(violations.map((x) => x.invariant))].sort();
  if (names.length !== 1 || names[0] !== "INV5_DLQ_NOT_EMPTY") {
    console.error("expected exactly [INV5_DLQ_NOT_EMPTY], got:", dump(violations));
    process.exit(1);
  }
  const total = parkedTotal(violations);
  if (total !== EXPECT_PARKED) {
    console.error(`expected exactly ${EXPECT_PARKED} parked message(s), got ${total}`);
    console.error(dump(violations));
    process.exit(1);
  }
  console.log(`poison parked (${total}), partition kept moving`);
}

void main();
