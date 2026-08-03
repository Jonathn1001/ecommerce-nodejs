import { render } from "@testing-library/react";
import { Silhouette } from "../Silhouette";

it.each(["ELECTRONICS", "CLOTHING", "FURNITURE", "MOTORBIKE"] as const)(
  "renders a shape for %s",
  (type) => {
    const { container } = render(<Silhouette type={type} />);
    expect(container.querySelector("svg")).not.toBeNull();
  }
);

// Degrade, never crash: the union comes from a network response, so an unknown value is
// reachable if Catalog ever adds a type before the storefront knows about it.
it("degrades to a neutral shape for an unknown type", () => {
  const { container } = render(
    <Silhouette type={"SPACESHIP" as unknown as "ELECTRONICS"} />
  );
  expect(container.querySelector("svg")).not.toBeNull();
});
