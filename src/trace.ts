// Step timings for working out where a job spends its time, or where it stopped. Off unless FLOW_MCP_TRACE is set
// (to anything); then each step is written to stderr with the seconds since the step before it, which for the
// background service means logs/studio.log. Nothing here ever includes a prompt or a file's contents.
const ON = Boolean(process.env.FLOW_MCP_TRACE);
let last = Date.now();

export function trace(step: string): void {
  if (!ON) return;
  const now = Date.now();
  console.error(`${new Date(now).toISOString().slice(11, 23)} +${((now - last) / 1000).toFixed(1)}s ${step}`);
  last = now;
}
