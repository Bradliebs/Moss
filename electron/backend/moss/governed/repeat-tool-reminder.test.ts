import { describe, expect, it } from "vitest";

import { RepeatToolReminder } from "./repeat-tool-reminder";

describe("RepeatToolReminder", () => {
  it("treats object property order as the same call", () => {
    const reminder = new RepeatToolReminder();

    expect(reminder.observe("read_file", '{"path":"a","offset":1}')).toBeUndefined();
    expect(reminder.observe("read_file", '{"offset":1,"path":"a"}')).toBeUndefined();
    expect(reminder.observe("read_file", '{"path":"a","offset":1}')).toContain("three times");
  });

  it("resets when a tracked tool or its arguments change", () => {
    const reminder = new RepeatToolReminder();

    reminder.observe("read_file", '{"path":"a"}');
    reminder.observe("read_file", '{"path":"a"}');
    expect(reminder.observe("read_file", '{"path":"b"}')).toBeUndefined();
    expect(reminder.observe("search_files", '{"path":"a"}')).toBeUndefined();
    expect(reminder.observe("search_files", '{"path":"a"}')).toBeUndefined();
    expect(reminder.observe("search_files", '{"path":"a"}')).toContain("three times");
  });

  it("keeps excluded bookkeeping calls transparent to the chain", () => {
    const reminder = new RepeatToolReminder();

    reminder.observe("read_file", "{}");
    expect(reminder.observe("plan", "{}" )).toBeUndefined();
    reminder.observe("read_file", "{}");
    expect(reminder.observe("read_file", "{}")).toContain("three times");
  });

  it("emits only at configured thresholds and bounds detailed arguments", () => {
    const reminder = new RepeatToolReminder();
    const args = JSON.stringify({ content: "x".repeat(1000) });
    const emitted: Array<string | undefined> = [];
    for (let count = 1; count <= 9; count++) emitted.push(reminder.observe("write_file", args));

    expect(emitted.map((value, index) => value ? index + 1 : 0).filter(Boolean)).toEqual([3, 5, 8]);
    expect(emitted[4]).toContain("(+");
    expect(emitted[4]!.length).toBeLessThan(800);
  });
});