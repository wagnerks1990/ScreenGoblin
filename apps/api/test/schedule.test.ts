import { describe, expect, it } from "vitest";
import type { ScheduleRecord } from "../src/domain/types.js";
import {
  compareSchedulePrecedence,
  matchesScheduleWindow,
  validTimeZone,
} from "../src/utils/schedule.js";

const schedule: ScheduleRecord = {
  id: "cm123schedule",
  organizationId: "cm123org",
  playlistId: "cm123playlist",
  name: "School day",
  priority: "normal",
  startsAt: "2020-01-01T00:00:00.000Z",
  timezone: "America/New_York",
  daysOfWeek: [1],
  dailyStartMinutes: 9 * 60,
  dailyEndMinutes: 10 * 60,
  enabled: true,
  screenIds: ["cm123screen"],
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};

describe("schedule time zone window", () => {
  it("evaluates weekday and minutes in the configured IANA time zone", () => {
    expect(
      matchesScheduleWindow(schedule, new Date("2026-09-14T13:30:00.000Z")),
    ).toBe(true);
    expect(
      matchesScheduleWindow(schedule, new Date("2026-09-14T16:00:00.000Z")),
    ).toBe(false);
  });

  it("accounts for standard-time UTC offset changes", () => {
    expect(
      matchesScheduleWindow(schedule, new Date("2026-01-12T14:30:00.000Z")),
    ).toBe(true);
  });

  it("rejects unknown time zones", () => {
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(validTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("resolves equal-priority conflicts deterministically", () => {
    const older = { ...schedule, id: "schedule-b" };
    const newer = {
      ...schedule,
      id: "schedule-z",
      startsAt: "2021-01-01T00:00:00.000Z",
    };
    const sameStartLowerId = { ...newer, id: "schedule-a" };
    expect([older, newer].sort(compareSchedulePrecedence)[0]?.id).toBe(
      "schedule-z",
    );
    expect(
      [newer, sameStartLowerId].sort(compareSchedulePrecedence)[0]?.id,
    ).toBe("schedule-a");
  });
});
