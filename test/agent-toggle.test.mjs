import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_BUTTON_RE, AGENT_SWITCH_RE, classifyAgentToggleState, isAgentToggleName } from "../dist/agent-toggle.js";

test("agent toggle patterns accept all valid Flow toggle names and refuse non-toggles", () => {
  for (const valid of ["Agent", "Flow Agent", "Turn on Flow Agent", "Turn off Flow Agent"]) {
    assert.equal(AGENT_BUTTON_RE.test(valid), true, `button should match ${valid}`);
    assert.equal(AGENT_SWITCH_RE.test(valid), true, `switch should match ${valid}`);
    assert.equal(isAgentToggleName("button", valid), true);
    assert.equal(isAgentToggleName("switch", valid), true);
  }
  for (const invalid of ["Agent instructions", "Agent settings", "Flow Agent instructions", "Settings", "Close", ""]) {
    assert.equal(AGENT_BUTTON_RE.test(invalid), false, `button must not match ${invalid}`);
    assert.equal(AGENT_SWITCH_RE.test(invalid), false, `switch must not match ${invalid}`);
    assert.equal(isAgentToggleName("button", invalid), false);
    assert.equal(isAgentToggleName("switch", invalid), false);
  }
});

test("classifyAgentToggleState reads aria-pressed, then aria-checked, then Turn on/off labels", () => {
  assert.equal(classifyAgentToggleState({ ariaPressed: "true" }), true);
  assert.equal(classifyAgentToggleState({ ariaPressed: "false" }), false);
  assert.equal(classifyAgentToggleState({ ariaPressed: null, ariaChecked: "true" }), true);
  assert.equal(classifyAgentToggleState({ ariaPressed: null, ariaChecked: "false" }), false);
  // aria-pressed wins over conflicting label text.
  assert.equal(classifyAgentToggleState({ ariaPressed: "false", label: "Turn off Flow Agent" }), false);
  // Label fallback when ARIA state attributes are absent.
  assert.equal(classifyAgentToggleState({ label: "Turn off Flow Agent" }), true);
  assert.equal(classifyAgentToggleState({ label: "Turn on Flow Agent" }), false);
  assert.equal(classifyAgentToggleState({ label: "Flow Agent" }), null);
  assert.equal(classifyAgentToggleState({}), null);
});
