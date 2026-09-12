import { describe, expect, it } from "vitest";
import type { ScheduleRecord } from "../src/domain/types.js";
import {
  compareSchedulePrecedence,
  matchesScheduleWindow,
  resolveZonedWallMinute,
  schedulePlaybackEndsAt,
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

  it("advances nonexistent spring-forward boundaries to the gap end", () => {
    const spring = {
      ...schedule,
      daysOfWeek: [0],
      dailyStartMinutes: 2 * 60 + 30,
      dailyEndMinutes: 4 * 60,
    };
    expect(
      resolveZonedWallMinute(
        { year: 2026, month: 3, day: 8 },
        2 * 60 + 30,
        "America/New_York",
        "start",
      ).toISOString(),
    ).toBe("2026-03-08T07:00:00.000Z");
    expect(
      matchesScheduleWindow(spring, new Date("2026-03-08T06:59:00.000Z")),
    ).toBe(false);
    expect(
      matchesScheduleWindow(spring, new Date("2026-03-08T07:00:00.000Z")),
    ).toBe(true);

    const endingInGap = {
      ...spring,
      dailyStartMinutes: 60,
      dailyEndMinutes: 2 * 60 + 30,
    };
    const beforeGap = new Date("2026-03-08T06:30:00.000Z");
    expect(schedulePlaybackEndsAt(endingInGap, beforeGap)).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(matchesScheduleWindow(endingInGap, beforeGap)).toBe(true);
    expect(
      matchesScheduleWindow(endingInGap, new Date("2026-03-08T07:00:00.000Z")),
    ).toBe(false);
  });

  it("uses the later repeated start and earlier repeated end at fall-back", () => {
    const repeatedStart = {
      ...schedule,
      daysOfWeek: [0],
      dailyStartMinutes: 90,
      dailyEndMinutes: 3 * 60,
    };
    expect(
      resolveZonedWallMinute(
        { year: 2026, month: 11, day: 1 },
        90,
        "America/New_York",
        "start",
      ).toISOString(),
    ).toBe("2026-11-01T06:30:00.000Z");
    expect(
      matchesScheduleWindow(
        repeatedStart,
        new Date("2026-11-01T05:45:00.000Z"),
      ),
    ).toBe(false);
    expect(
      matchesScheduleWindow(
        repeatedStart,
        new Date("2026-11-01T06:30:00.000Z"),
      ),
    ).toBe(true);

    const repeatedEnd = {
      ...repeatedStart,
      dailyStartMinutes: 30,
      dailyEndMinutes: 90,
    };
    const beforeFirstEnd = new Date("2026-11-01T05:15:00.000Z");
    expect(schedulePlaybackEndsAt(repeatedEnd, beforeFirstEnd)).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(matchesScheduleWindow(repeatedEnd, beforeFirstEnd)).toBe(true);
    expect(
      matchesScheduleWindow(repeatedEnd, new Date("2026-11-01T06:15:00.000Z")),
    ).toBe(false);
  });

  it("resolves ordinary fractional-offset zones and next-day midnight", () => {
    const kolkata = {
      ...schedule,
      timezone: "Asia/Kolkata",
      daysOfWeek: [],
      dailyStartMinutes: 9 * 60,
      dailyEndMinutes: 10 * 60,
    };
    expect(
      schedulePlaybackEndsAt(kolkata, new Date("2026-09-14T04:00:00.000Z")),
    ).toBe("2026-09-14T04:30:00.000Z");
    expect(
      resolveZonedWallMinute(
        { year: 2026, month: 9, day: 14 },
        1440,
        "Asia/Kolkata",
        "end",
      ).toISOString(),
    ).toBe("2026-09-14T18:30:00.000Z");
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
