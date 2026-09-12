import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { Playlists } from "./Playlists";

beforeEach(() => window.sessionStorage.clear());

it("contains authenticated playlists without substituting fixtures or dead actions", () => {
  window.sessionStorage.setItem("sg_access_token", "live-token");
  render(<Playlists />);

  expect(screen.getByText("Live playlist view is not connected")).toBeTruthy();
  expect(
    screen.getByText(/No demonstration records have been substituted/),
  ).toBeTruthy();
  expect(screen.queryByText("High School Hallways")).toBeNull();
  expect(screen.queryByRole("button", { name: /new playlist/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /edit playlist/i })).toBeNull();
});
