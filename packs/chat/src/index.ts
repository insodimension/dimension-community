// Chat is a LAYOUT plugin: its whole contribution is DATA - four slots and a
// space whose fillings are bound to packs that ship the real components.
// Zero pixels, zero runtime, nothing hardcoded in the app.
//
// What this space is FOR: the personal assistant. Aether (the cross-project
// companion, whose sessions live in the `inso-personal` home workspace) gets
// a room with no repo in it: the rail lists only that desk's sessions
// (`workspace.scope`), the thread draws only the conversation and a quiet
// "Worked for" line (`chat-thread`), and the `artifact-view` column opens a
// tab for each document the assistant makes (`viewer`, an artifactory).
//
// Why the top bar publishes `sound` alone: an absent `workspace.actions` means
// "no opinion" and shows every affordance, including `environment` - the repo /
// branch card and the start surface's worktree choice, both wrong here.
export {};
