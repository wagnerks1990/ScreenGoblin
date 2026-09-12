import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { Schedules } from "./Schedules";

beforeEach(() => window.sessionStorage.clear());

it("contains authenticated schedules without substituting fixtures or dead actions", () => {
  window.sessionStorage.setItem("sg_access_token", "live-token");
  render(<Schedules />);

  expect(screen.getByText("Live schedule view is not connected")).toBeTruthy();
  expect(
    screen.getByText(/No demonstration records have been substituted/),
  ).toBeTruthy();
  expect(screen.queryByText("School Day Baseline")).toBeNull();
  expect(screen.queryByRole("button", { name: /new schedule/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
  expect(document.body).not.toHaveTextContent(
    "Normal programming always resumes",
  );
});
