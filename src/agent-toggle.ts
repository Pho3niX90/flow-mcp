// Pure patterns and state classification for Flow's Agent toggle across UI revisions:
// - Classic button: "Agent"
// - Nov 21 button: "Flow Agent" (upstream 770e001)
// - Nov 20 switch/button: "Turn on Flow Agent" / "Turn off Flow Agent" (PR #38)
// Deliberately refuses "Agent instructions" and "Agent settings".
export const AGENT_BUTTON_RE = /^((Flow )?Agent|Turn (on|off) Flow Agent)$/;
export const AGENT_SWITCH_RE = /^((Flow )?Agent|Turn (on|off) Flow Agent)$/i;

export function isAgentToggleName(role: "button" | "switch", name: string): boolean {
  const trimmed = name.trim();
  return role === "button" ? AGENT_BUTTON_RE.test(trimmed) : AGENT_SWITCH_RE.test(trimmed);
}

export interface AgentToggleAttrs {
  ariaPressed?: string | null;
  ariaChecked?: string | null;
  label?: string | null;
}

// Determines whether Agent mode is on from the toggle's ARIA attributes or action label.
// Returns null when the state cannot be determined.
export function classifyAgentToggleState({ ariaPressed, ariaChecked, label }: AgentToggleAttrs): boolean | null {
  const pressed = ariaPressed ?? ariaChecked;
  if (pressed === "true" || pressed === "false") return pressed === "true";
  const name = (label ?? "").trim();
  if (/^Turn off\b/i.test(name)) return true;
  if (/^Turn on\b/i.test(name)) return false;
  return null;
}
