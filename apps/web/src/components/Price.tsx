// price is integer MINOR UNITS everywhere in the system; this is the only place it becomes
// a human number (Global Constraint 9).
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function Price({ minorUnits }: { minorUnits: number }) {
  return <span className="datum">{fmt.format(minorUnits / 100)}</span>;
}
