import type { ScheduleRecord } from "../domain/types.js";

const weekdayIndex: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const priorityWeight: Record<ScheduleRecord["priority"], number> = {
  normal: 0,
  campaign: 1,
  priority: 2,
  emergency: 3,
};

export function compareSchedulePrecedence(
  left: ScheduleRecord,
  right: ScheduleRecord,
): number {
  return (
    priorityWeight[right.priority] - priorityWeight[left.priority] ||
    right.startsAt.localeCompare(left.startsAt) ||
    left.id.localeCompare(right.id)
  );
}

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function matchesScheduleWindow(
  schedule: ScheduleRecord,
  instant: Date,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const weekday = weekdayIndex[part("weekday") ?? ""];
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (weekday === undefined || !Number.isFinite(hour + minute)) return false;
  if (schedule.daysOfWeek.length && !schedule.daysOfWeek.includes(weekday))
    return false;
  const localMinute = hour * 60 + minute;
  if (
    schedule.dailyStartMinutes !== undefined &&
    localMinute < schedule.dailyStartMinutes
  )
    return false;
  if (
    schedule.dailyEndMinutes !== undefined &&
    localMinute >= schedule.dailyEndMinutes
  )
    return false;
  return true;
}
