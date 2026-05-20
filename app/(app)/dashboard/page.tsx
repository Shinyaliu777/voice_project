// The /dashboard landing UI is now rendered by <RecorderLane /> mounted
// inside (app)/layout.tsx, not here. RecorderLane stays mounted across
// every dashboard sub-route so audio capture / WebSocket / live-translate
// keep running when the user navigates to chat / history / vocabulary /
// etc. — recording is only stopped by an explicit user click on
// "结束录制".
//
// This page deliberately returns null: RecorderLane already fills the
// main viewport when pathname === "/dashboard". Returning anything here
// would render *on top of* the recorder UI and visually duplicate it.
//
// Any unfinished-session hydration (default source/target lang for the
// Recorder's initial state) happens inside layout.tsx; see RecorderLane.

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return null;
}
