import { render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MediaVault } from "./MediaVault";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("does not claim live inventory or verified ingestion before a live read succeeds", async () => {
  window.sessionStorage.setItem("sg_access_token", "live-token");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

  render(<MediaVault />);

  expect(screen.getByText("Loading live inventory")).toBeTruthy();
  expect(await screen.findByText("Live inventory unavailable")).toBeTruthy();
  expect(document.body).toHaveTextContent(
    "This Console does not verify ingestion provenance",
  );
  expect(document.body).toHaveTextContent(
    "These records do not prove that an ingestion, scanning, or approval pipeline ran",
  );
  expect(document.body).not.toHaveTextContent("approved content pipeline");
  expect(screen.queryByText("Club Fair — September")).toBeNull();
});
