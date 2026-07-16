import assert from "node:assert/strict";
import test from "node:test";

import tmuxFeedback, { reconstructFeedbackState, type FeedbackNote } from "../extensions/tmux-feedback/index.ts";

function note(id: number, feedback = `feedback ${id}`): FeedbackNote {
  return {
    id,
    quote: `quote ${id}`,
    feedback,
    createdAt: `2026-07-16T00:00:0${id}.000Z`,
  };
}

function snapshotEntry(notes: FeedbackNote[], nextId: unknown) {
  return {
    type: "custom",
    customType: "tmux-feedback",
    data: {
      action: "snapshot",
      notes,
      nextId,
    },
  };
}

test("reconstruction keeps the first valid occurrence of each positive integer note ID", () => {
  const state = reconstructFeedbackState([
    snapshotEntry(
      [note(1, "first"), note(1, "duplicate"), note(2), note(0), note(-1), note(1.5)],
      2,
    ),
  ]);

  assert.deepEqual(state.notes, [note(1, "first"), note(2)]);
  assert.equal(state.nextId, 3);
});

test("reconstruction derives nextId above retained IDs when the snapshot nextId is invalid", () => {
  for (const invalidNextId of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "7"]) {
    const state = reconstructFeedbackState([snapshotEntry([note(3)], invalidNextId)]);

    assert.equal(state.nextId, 4);
  }
});

type SelectCall = { title: string; options: string[] };
type EditorCall = { title: string; prefill: string };
type ConfirmCall = { title: string; message: string };
type Notification = { message: string; type: string };
type SelectStep = string | undefined | ((call: SelectCall) => string | undefined | Promise<string | undefined>);
type EditorStep = string | undefined | ((call: EditorCall) => string | undefined | Promise<string | undefined>);
type ConfirmStep = boolean | ((call: ConfirmCall) => boolean | Promise<boolean>);

function choose(label: string): SelectStep {
  return ({ options }) => options.find((option) => option === label);
}

const chooseFirstNote: SelectStep = ({ options }) => options.find((option) => option.startsWith("#"));

function createHarness(initialNotes: FeedbackNote[], initialNextId: number) {
  const eventHandlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const branch: unknown[] = [snapshotEntry(initialNotes, initialNextId)];
  const appendedEntries: ReturnType<typeof snapshotEntry>[] = [];
  const notifications: Notification[] = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const selectCalls: SelectCall[] = [];
  const editorCalls: EditorCall[] = [];
  const confirmCalls: ConfirmCall[] = [];
  const selectSteps: SelectStep[] = [];
  const editorSteps: EditorStep[] = [];
  const confirmSteps: ConfirmStep[] = [];

  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      select: async (title: string, options: string[]) => {
        const call = { title, options: [...options] };
        selectCalls.push(call);
        const step = selectSteps.shift();
        return typeof step === "function" ? step(call) : step;
      },
      editor: async (title: string, prefill: string) => {
        const call = { title, prefill };
        editorCalls.push(call);
        const step = editorSteps.shift();
        return typeof step === "function" ? step(call) : step;
      },
      confirm: async (title: string, message: string) => {
        const call = { title, message };
        confirmCalls.push(call);
        const step = confirmSteps.shift();
        return typeof step === "function" ? step(call) : (step ?? false);
      },
    },
  };

  const pi = {
    on: (event: string, handler: (event: unknown, context: any) => unknown) => eventHandlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (args: string, context: any) => unknown }) =>
      commands.set(name, command),
    appendEntry: (customType: string, data: any) => {
      const entry = { type: "custom", customType, data } as ReturnType<typeof snapshotEntry>;
      appendedEntries.push(entry);
      branch.push(entry);
    },
  };

  tmuxFeedback(pi as any);

  const invokeEvent = async (name: string) => {
    const handler = eventHandlers.get(name);
    assert.ok(handler, `expected ${name} handler`);
    await handler({}, ctx);
  };

  return {
    appendedEntries,
    notifications,
    statuses,
    selectCalls,
    editorCalls,
    confirmCalls,
    selectSteps,
    editorSteps,
    confirmSteps,
    start: () => invokeEvent("session_start"),
    list: async () => {
      const command = commands.get("feedback-list");
      assert.ok(command, "expected feedback-list command");
      await command.handler("", ctx);
    },
    replaceState: async (notes: FeedbackNote[], nextId: number) => {
      branch.push(snapshotEntry(notes, nextId));
      await invokeEvent("session_tree");
    },
    lastSnapshot: () => {
      const entry = appendedEntries.at(-1);
      assert.ok(entry, "expected an appended snapshot");
      return entry.data;
    },
  };
}

function warnings(harness: ReturnType<typeof createHarness>): Notification[] {
  return harness.notifications.filter(({ type }) => type === "warning");
}

test("edits one note while preserving immutable fields, order, and nextId", async () => {
  const first = note(1, "original");
  const second = note(2, "other feedback");
  const harness = createHarness([first, second], 3);
  harness.selectSteps.push(chooseFirstNote, choose("Edit feedback"), undefined);
  harness.editorSteps.push("  updated\r\nfeedback  ");

  await harness.start();
  await harness.list();

  assert.equal(harness.editorCalls[0]?.prefill, "original");
  assert.deepEqual(harness.lastSnapshot(), {
    action: "snapshot",
    notes: [{ ...first, feedback: "updated\nfeedback" }, second],
    nextId: 3,
  });
  assert.deepEqual(harness.notifications, [{ message: "Updated tmux feedback #1", type: "info" }]);
});

for (const { label, storedFeedback, editorResult } of [
  { label: "cancelled", storedFeedback: "original", editorResult: undefined },
  { label: "empty", storedFeedback: "original", editorResult: " \r\n\t " },
  { label: "unchanged", storedFeedback: "original", editorResult: "original" },
  { label: "CRLF-equivalent", storedFeedback: "line\ntwo", editorResult: "line\r\ntwo" },
]) {
  test(`does not append a snapshot for a ${label} edit`, async () => {
    const harness = createHarness([note(1, storedFeedback)], 2);
    harness.selectSteps.push(chooseFirstNote, choose("Edit feedback"), undefined);
    harness.editorSteps.push(editorResult);

    await harness.start();
    await harness.list();

    assert.equal(harness.appendedEntries.length, 0);
  });
}

test("rejects a note selected from a stale outer selector", async () => {
  const harness = createHarness([note(1, "original")], 2);
  harness.selectSteps.push(async ({ options }) => {
    await harness.replaceState([], 2);
    return options[0];
  });

  await harness.start();
  await harness.list();

  assert.equal(harness.appendedEntries.length, 0);
  assert.deepEqual(warnings(harness), [
    { message: "Selected tmux feedback is no longer available", type: "warning" },
  ]);
});

test("rejects a stale edit when the selected note changes in the editor", async () => {
  const harness = createHarness([note(1, "original")], 2);
  harness.selectSteps.push(chooseFirstNote, choose("Edit feedback"), undefined);
  harness.editorSteps.push(async () => {
    await harness.replaceState([note(1, "changed elsewhere")], 2);
    return "my stale edit";
  });

  await harness.start();
  await harness.list();

  assert.equal(harness.appendedEntries.length, 0);
  assert.deepEqual(warnings(harness), [
    { message: "Tmux feedback #1 changed. Reopen it and try again.", type: "warning" },
  ]);
});

test("removes one confirmed note and preserves the remaining note and nextId", async () => {
  const first = note(1);
  const second = note(2);
  const harness = createHarness([first, second], 3);
  harness.selectSteps.push(chooseFirstNote, choose("Remove note"), undefined);
  harness.confirmSteps.push(true);

  await harness.start();
  await harness.list();

  assert.deepEqual(harness.lastSnapshot(), { action: "snapshot", notes: [second], nextId: 3 });
  assert.deepEqual(harness.notifications, [{ message: "Removed tmux feedback #1", type: "info" }]);
});

test("removing the highest ID does not decrease nextId", async () => {
  const first = note(1);
  const harness = createHarness([first, note(2)], 3);
  harness.selectSteps.push(
    ({ options }) => options.find((option) => option.startsWith("#2")),
    choose("Remove note"),
    undefined,
  );
  harness.confirmSteps.push(true);

  await harness.start();
  await harness.list();

  assert.deepEqual(harness.lastSnapshot(), { action: "snapshot", notes: [first], nextId: 3 });
});

test("cancelled removal returns to the same note action menu", async () => {
  const harness = createHarness([note(1)], 2);
  harness.selectSteps.push(chooseFirstNote, choose("Remove note"), choose("Back"), undefined);
  harness.confirmSteps.push(false);

  await harness.start();
  await harness.list();

  assert.equal(harness.appendedEntries.length, 0);
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(harness.selectCalls.filter(({ title }) => title.startsWith("Tmux feedback #1")).length, 2);
});

test("removing the final note exits before opening another selector", async () => {
  const harness = createHarness([note(4)], 5);
  harness.selectSteps.push(chooseFirstNote, choose("Remove note"));
  harness.confirmSteps.push(true);

  await harness.start();
  await harness.list();

  assert.deepEqual(harness.lastSnapshot(), { action: "snapshot", notes: [], nextId: 5 });
  assert.ok(harness.notifications.some(({ message }) => message === "No queued tmux feedback"));
  assert.equal(harness.selectCalls.length, 2);
});

test("rejects a stale removal when the selected note changes during confirmation", async () => {
  const harness = createHarness([note(1, "original")], 2);
  harness.selectSteps.push(chooseFirstNote, choose("Remove note"), undefined);
  harness.confirmSteps.push(async () => {
    await harness.replaceState([note(1, "changed elsewhere")], 2);
    return true;
  });

  await harness.start();
  await harness.list();

  assert.equal(harness.appendedEntries.length, 0);
  assert.deepEqual(warnings(harness), [
    { message: "Tmux feedback #1 changed. Reopen it and try again.", type: "warning" },
  ]);
});
