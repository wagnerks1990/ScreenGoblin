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

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
const wallMinuteCache = new Map<string, number>();
const MAX_WALL_MINUTE_CACHE_ENTRIES = 4096;

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    weekday: weekdayIndex[part("weekday") ?? ""] ?? Number.NaN,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

function wallClockValue(parts: Omit<ZonedParts, "weekday">): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

/**
 * Resolve one local wall-clock minute without assuming a fixed UTC offset.
 * Repeated starts use the later occurrence and repeated ends the earlier one,
 * preventing early activation and preventing a schedule from reactivating
 * when clocks move backward. A nonexistent time advances to the first valid
 * instant after the DST gap.
 */
export function resolveZonedWallMinute(
  date: Pick<ZonedParts, "year" | "month" | "day">,
  minuteOfDay: number,
  timeZone: string,
  boundary: "start" | "end",
): Date {
  const cacheKey = `${timeZone}|${date.year}-${date.month}-${date.day}|${minuteOfDay}|${boundary}`;
  const cached = wallMinuteCache.get(cacheKey);
  if (cached !== undefined) return new Date(cached);
  const remember = (instant: number): Date => {
    if (wallMinuteCache.size >= MAX_WALL_MINUTE_CACHE_ENTRIES)
      wallMinuteCache.clear();
    wallMinuteCache.set(cacheKey, instant);
    return new Date(instant);
  };
  const normalized = new Date(
    Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay),
  );
  const target = {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
    day: normalized.getUTCDate(),
    hour: normalized.getUTCHours(),
    minute: normalized.getUTCMinutes(),
  };
  const desired = wallClockValue(target);
  const offsets = new Set<number>();
  const samples: Array<{ instant: number; offset: number }> = [];
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
    const instant = desired + deltaHours * 60 * 60_000;
    const represented = wallClockValue(zonedParts(new Date(instant), timeZone));
    const offset = represented - instant;
    offsets.add(offset);
    samples.push({ instant, offset });
  }

  const exact = [...offsets]
    .map((offset) => desired - offset)
    .filter((instant) => {
      const actual = zonedParts(new Date(instant), timeZone);
      return wallClockValue(actual) === desired;
    })
    .sort((left, right) => left - right);
  if (exact.length)
    return remember(boundary === "start" ? exact.at(-1)! : exact[0]!);

  // A gap has no exact representation. Find the offset transition to minute
  // precision, then use its first post-gap instant.
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]!;
    const after = samples[index]!;
    if (before.offset === after.offset) continue;
    let low = Math.floor(before.instant / 60_000);
    let high = Math.ceil(after.instant / 60_000);
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const represented = wallClockValue(
        zonedParts(new Date(middle * 60_000), timeZone),
      );
      const offset = represented - middle * 60_000;
      if (offset === before.offset) low = middle;
      else high = middle;
    }
    const transition = high * 60_000;
    const priorWall = wallClockValue(
      zonedParts(new Date((high - 1) * 60_000), timeZone),
    );
    const nextWall = wallClockValue(zonedParts(new Date(transition), timeZone));
    if (priorWall < desired && nextWall > desired) return remember(transition);
  }
  throw new RangeError(`Could not resolve wall-clock boundary in ${timeZone}`);
}

export function schedulePlaybackEndsAt(
  schedule: ScheduleRecord,
  instant: Date,
): string | undefined {
  const candidates: number[] = [];
  if (schedule.endsAt) candidates.push(Date.parse(schedule.endsAt));
  if (schedule.dailyEndMinutes !== undefined) {
    const local = zonedParts(instant, schedule.timezone);
    const dailyBoundary = resolveZonedWallMinute(
      local,
      schedule.dailyEndMinutes,
      schedule.timezone,
      "end",
    ).getTime();
    if (dailyBoundary > instant.getTime()) candidates.push(dailyBoundary);
  }
  return candidates.length
    ? new Date(Math.min(...candidates)).toISOString()
    : undefined;
}

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
  const local = zonedParts(instant, schedule.timezone);
  if (!Number.isFinite(local.weekday + local.hour + local.minute)) return false;
  if (
    schedule.daysOfWeek.length &&
    !schedule.daysOfWeek.includes(local.weekday)
  )
    return false;
  if (schedule.dailyStartMinutes !== undefined) {
    const start = resolveZonedWallMinute(
      local,
      schedule.dailyStartMinutes,
      schedule.timezone,
      "start",
    );
    if (instant < start) return false;
  }
  if (schedule.dailyEndMinutes !== undefined) {
    const end = resolveZonedWallMinute(
      local,
      schedule.dailyEndMinutes,
      schedule.timezone,
      "end",
    );
    if (instant >= end) return false;
  }
  return true;
}
