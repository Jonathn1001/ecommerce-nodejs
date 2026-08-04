import { render, screen } from "@testing-library/react";
import { OrderTracker } from "../OrderTracker";

it("marks the step in flight and announces it politely", () => {
  render(<OrderTracker status="AWAITING_PAYMENT" failedAt={null} />);
  const current = screen.getByRole("listitem", { current: "step" });
  expect(current).toHaveTextContent("Payment");
  const live = screen.getByRole("status");
  expect(live).toHaveTextContent(/payment/i);
  // Polite, not assertive: the saga can produce three transitions in a few seconds and none of
  // them is an interruption.
  expect(live).toHaveAttribute("aria-live", "polite");
});

// The design language encodes saga state in colour, so the state must ALSO be readable as
// text — in greyscale, and to a screen reader.
it("states every step's condition in text, not only in colour", () => {
  render(<OrderTracker status="PENDING" failedAt={null} />);
  for (const label of ["Order placed", "Inventory reserved", "Payment", "Confirmed"])
    expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText("Inventory reserved").closest("li")).toHaveTextContent(
    /in progress/i
  );
  expect(screen.getByText("Order placed").closest("li")).toHaveTextContent(/done/i);
});

it("shows the compensation path when the failure was observed", () => {
  render(<OrderTracker status="CANCELLED" failedAt="AWAITING_PAYMENT" />);
  expect(screen.getByText("Payment").closest("li")).toHaveTextContent(/failed/i);
  expect(screen.getByRole("status")).toHaveTextContent(/cancelled/i);
});

it("blames no step on a cold-loaded cancellation", () => {
  render(<OrderTracker status="CANCELLED" failedAt={null} />);
  expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/cancelled/i);
});

it("completes every step once confirmed", () => {
  render(<OrderTracker status="CONFIRMED" failedAt={null} />);
  expect(screen.queryByRole("listitem", { current: "step" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/confirmed/i);
});

// The pulse is a class, so `prefers-reduced-motion` can remove it in CSS rather than the
// component branching on a media query it cannot see in jsdom.
it("marks the active step with the animated class, and nothing else", () => {
  const { container } = render(<OrderTracker status="PENDING" failedAt={null} />);
  expect(container.querySelectorAll(".tracker-pulse")).toHaveLength(1);
});
