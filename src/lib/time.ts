export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function getZonedDateParts(
  instant: Date,
  timeZone: string,
): ZonedDateParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

export function zonedDateTimeToUtc(
  local: Omit<ZonedDateParts, "second"> & { second?: number },
  timeZone: string,
): Date {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second ?? 0,
  );
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = getZonedDateParts(new Date(guess), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = target - observedAsUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function calendarDate(
  year: number,
  month: number,
  day: number,
  offsetDays: number,
) {
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localWeekday(parts: Pick<ZonedDateParts, "year" | "month" | "day">) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function nextBusinessDate(
  year: number,
  month: number,
  day: number,
  minimumOffsetDays = 1,
) {
  let offsetDays = minimumOffsetDays;
  for (;;) {
    const candidate = calendarDate(year, month, day, offsetDays);
    const weekday = localWeekday(candidate);
    if (weekday !== 0 && weekday !== 6) return candidate;
    offsetDays += 1;
  }
}

export function localDateKey(instant: Date, timeZone: string): string {
  const local = getZonedDateParts(instant, timeZone);
  return `${local.year.toString().padStart(4, "0")}-${local.month
    .toString()
    .padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
}

export function localDateStorageValue(instant: Date, timeZone: string): Date {
  return new Date(`${localDateKey(instant, timeZone)}T00:00:00.000Z`);
}

export function getLocalDayBounds(instant: Date, timeZone: string) {
  const local = getZonedDateParts(instant, timeZone);
  const next = calendarDate(local.year, local.month, local.day, 1);
  return {
    start: zonedDateTimeToUtc(
      { ...local, hour: 0, minute: 0, second: 0 },
      timeZone,
    ),
    end: zonedDateTimeToUtc(
      { ...next, hour: 0, minute: 0, second: 0 },
      timeZone,
    ),
    key: localDateKey(instant, timeZone),
  };
}

export function getBillingPeriodBounds(
  instant: Date,
  timeZone: string,
  cycleDay: number,
) {
  const safeCycleDay = Math.min(28, Math.max(1, Math.trunc(cycleDay)));
  const local = getZonedDateParts(instant, timeZone);
  const startMonth = new Date(
    Date.UTC(
      local.year,
      local.month - 1 - (local.day < safeCycleDay ? 1 : 0),
      safeCycleDay,
    ),
  );
  const endMonth = new Date(
    Date.UTC(
      startMonth.getUTCFullYear(),
      startMonth.getUTCMonth() + 1,
      safeCycleDay,
    ),
  );
  return {
    start: zonedDateTimeToUtc(
      {
        year: startMonth.getUTCFullYear(),
        month: startMonth.getUTCMonth() + 1,
        day: startMonth.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timeZone,
    ),
    end: zonedDateTimeToUtc(
      {
        year: endMonth.getUTCFullYear(),
        month: endMonth.getUTCMonth() + 1,
        day: endMonth.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timeZone,
    ),
  };
}

function timeToMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function getSendWindowAvailability(
  instant: Date,
  timeZone: string,
  start: string,
  end: string,
): { allowed: true } | { allowed: false; nextAllowedAt: Date } {
  if (!start || !end || start === end) return { allowed: true };
  const local = getZonedDateParts(instant, timeZone);
  const currentMinute = local.hour * 60 + local.minute;
  const startMinute = timeToMinutes(start);
  const endMinute = timeToMinutes(end);
  const overnight = startMinute > endMinute;
  const allowed = overnight
    ? currentMinute >= startMinute || currentMinute < endMinute
    : currentMinute >= startMinute && currentMinute < endMinute;
  if (allowed) return { allowed: true };

  const useTomorrow = !overnight && currentMinute >= endMinute;
  const date = calendarDate(
    local.year,
    local.month,
    local.day,
    useTomorrow ? 1 : 0,
  );
  return {
    allowed: false,
    nextAllowedAt: zonedDateTimeToUtc(
      {
        ...date,
        hour: Math.floor(startMinute / 60),
        minute: startMinute % 60,
      },
      timeZone,
    ),
  };
}

export function getNextOperatingDayStart(
  instant: Date,
  timeZone: string,
  windowStart: string,
) {
  const local = getZonedDateParts(instant, timeZone);
  const next = calendarDate(local.year, local.month, local.day, 1);
  const startMinute = windowStart ? timeToMinutes(windowStart) : 0;
  return zonedDateTimeToUtc(
    {
      ...next,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
    },
    timeZone,
  );
}

/** Returns the next weekday start in local calendar time, including DST. */
export function getNextBusinessDayStart(
  instant: Date,
  timeZone: string,
  windowStart: string,
) {
  const local = getZonedDateParts(instant, timeZone);
  const next = nextBusinessDate(local.year, local.month, local.day);
  const startMinute = windowStart ? timeToMinutes(windowStart) : 0;
  return zonedDateTimeToUtc(
    {
      ...next,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
    },
    timeZone,
  );
}

export function getBusinessSendWindowAvailability(
  instant: Date,
  timeZone: string,
  start: string,
  end: string,
): { allowed: true } | { allowed: false; nextAllowedAt: Date } {
  const local = getZonedDateParts(instant, timeZone);
  const weekday = localWeekday(local);
  if (weekday === 0 || weekday === 6) {
    const next = nextBusinessDate(local.year, local.month, local.day);
    const startMinute = start ? timeToMinutes(start) : 0;
    return {
      allowed: false,
      nextAllowedAt: zonedDateTimeToUtc(
        {
          ...next,
          hour: Math.floor(startMinute / 60),
          minute: startMinute % 60,
        },
        timeZone,
      ),
    };
  }

  const availability = getSendWindowAvailability(instant, timeZone, start, end);
  if (availability.allowed) return availability;

  const nextLocal = getZonedDateParts(availability.nextAllowedAt, timeZone);
  const nextWeekday = localWeekday(nextLocal);
  if (nextWeekday !== 0 && nextWeekday !== 6) return availability;

  return {
    allowed: false,
    nextAllowedAt: getNextBusinessDayStart(instant, timeZone, start),
  };
}
