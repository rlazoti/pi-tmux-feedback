import assert from "node:assert/strict";
import test from "node:test";

import { reconstructFeedbackState, type FeedbackNote } from "../extensions/tmux-feedback/index.ts";

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
