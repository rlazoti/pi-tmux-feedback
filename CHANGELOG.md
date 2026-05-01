# Changelog

## 1.0.0 (2026-05-01)

Initial release.

- Tmux copy-mode `Y` binding for selecting text to annotate.
- `/feedback-capture` — reads tmux buffer, opens editor, queues feedback note.
- `/feedback-send` — sends all queued notes as one message to the assistant.
- `/feedback-list` — reviews queued notes in a read-only editor.
- `/feedback-clear` — discards queued notes with confirmation.
- `/feedback-install-tmux-binding` — installs the `Y` binding in the running tmux server.
- `/feedback-help` — shows workflow documentation.
- Session-persisted state that survives restarts and tree navigation.
- Status bar indicator showing queued note count.
- Follow-up delivery when the assistant is mid-stream.
