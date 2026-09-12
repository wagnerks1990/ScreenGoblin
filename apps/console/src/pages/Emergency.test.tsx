import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Emergency } from "./Emergency";

it("shows only static emergency unavailability without fixture claims", () => {
  render(<Emergency />);

  expect(
    screen.getByRole("heading", {
      name: "No emergency controls are available",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /activation disabled/i }),
  ).toBeDisabled();
  expect(screen.queryByText("No message is active")).toBeNull();
  expect(screen.queryByText(/All screens \(30\)/)).toBeNull();
  expect(screen.queryByText("Audit preview")).toBeNull();
  expect(screen.queryByText("Exact screen preview")).toBeNull();
  expect(screen.queryByText("AUTHORIZED DISTRICT MESSAGE")).toBeNull();
  expect(screen.queryByText("Locked template")).toBeNull();
});
