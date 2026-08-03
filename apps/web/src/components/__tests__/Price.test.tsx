import { render, screen } from "@testing-library/react";
import { Price } from "../Price";

it.each([
  [900, "$9.00"],
  [2450, "$24.50"],
  [890000, "$8,900.00"],
  [0, "$0.00"],
])("renders %i minor units as %s", (minor, expected) => {
  render(<Price minorUnits={minor} />);
  expect(screen.getByText(expected)).toBeInTheDocument();
});
