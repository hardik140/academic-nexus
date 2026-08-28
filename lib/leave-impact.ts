export interface TimetableSlotForImpact {
  id: string;
  course_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export interface AffectedClass {
  date: string;
  slotId: string;
  courseId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * Pure, deterministic: every date in [startDate, endDate] (inclusive,
 * YYYY-MM-DD calendar dates — parsed as UTC so this doesn't shift by a day
 * depending on the caller's local timezone) cross-referenced against the
 * teacher's own timetable_slots by day_of_week. One row per (date, slot) —
 * no fabricated "no impact" subcount, only classes that actually fall
 * within the leave range.
 */
export function computeAffectedClasses(
  startDate: string,
  endDate: string,
  slots: TimetableSlotForImpact[]
): AffectedClass[] {
  const slotsByDay = new Map<number, TimetableSlotForImpact[]>();
  for (const slot of slots) {
    if (!slotsByDay.has(slot.day_of_week)) slotsByDay.set(slot.day_of_week, []);
    slotsByDay.get(slot.day_of_week)!.push(slot);
  }

  const affected: AffectedClass[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (cursor.getTime() <= end.getTime()) {
    const dayOfWeek = cursor.getUTCDay();
    const dateStr = cursor.toISOString().split("T")[0];
    for (const slot of slotsByDay.get(dayOfWeek) || []) {
      affected.push({
        date: dateStr,
        slotId: slot.id,
        courseId: slot.course_id,
        dayOfWeek,
        startTime: slot.start_time,
        endTime: slot.end_time,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return affected;
}
