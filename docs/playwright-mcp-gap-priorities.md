# Playwright MCP Gap Priorities

## Positioning

This project should not become an Appium-style UI test framework first. Its stronger direction is an Android device-control MCP for agents:

- The agent often does not know the current screen structure ahead of time.
- The agent needs to inspect, decide, act, and recover interactively.
- Android native apps, system UI, permission dialogs, launchers, and cross-app workflows matter more than browser-only test features.

The most useful Playwright MCP idea to borrow is the `snapshot -> ref -> action` loop:

```text
observe structured screen snapshot
  -> choose stable element reference
  -> perform action against that reference
  -> return updated state or actionable failure context
```

Playwright MCP's browser-specific capabilities such as network mocking, cookies, localStorage, JavaScript evaluation, tabs, and PDF export are useful in the browser domain, but they are not the right near-term benchmark for this Android MCP.

## Priority 1: Stable Semantic Snapshot

Strengthen `android_get_semantic_screen` into the primary observation API, similar in spirit to Playwright MCP's accessibility snapshot.

Goals:

- Return a compact, LLM-readable list of visible and actionable nodes.
- Give every node a short, stable-enough `ref` for the current screen.
- Prefer accessibility nodes, then merge OCR nodes when the accessibility tree is sparse.
- Rank nodes by likely usefulness: clickable controls, editable fields, navigation items, visible labels, then passive text.
- Deduplicate overlapping accessibility and OCR nodes.
- Include enough metadata for action decisions without flooding context.

Suggested node shape:

```json
{
  "ref": "a12",
  "role": "button",
  "text": "Login",
  "contentDesc": "Login",
  "resourceId": "com.example:id/login",
  "bounds": [120, 900, 520, 980],
  "center": [320, 940],
  "clickable": true,
  "editable": false,
  "source": "accessibility",
  "score": 0.94
}
```

Implementation notes:

- Keep the existing `nodes` output compatible if possible, but add `ref`, `role`, `editable`, and `score`.
- Generate refs per snapshot from deterministic traversal order, such as `a1`, `a2`, `o1`.
- Return `snapshotId` so action tools can detect stale refs later.
- Keep raw XML/OCR hidden unless debug options are explicitly enabled.

## Priority 2: Ref-Based Actions

Add action tools that operate on semantic refs instead of forcing the agent to calculate coordinates.

Recommended tools:

- `android_tap_ref`
- `android_long_press_ref`
- `android_fill_ref`
- `android_perform_action_ref`

Current status: these ref tools are implemented for accessibility refs. `android_perform_action_ref` accepts predefined action names and custom action labels exposed by the target node. OCR refs remain observation-only.

Example:

```json
{
  "snapshotId": "screen-1748510000",
  "ref": "a12"
}
```

Why this matters:

- It matches the Playwright MCP interaction model.
- It reduces coordinate mistakes.
- It lets the MCP server choose the best action strategy: accessibility action first, coordinate fallback second.
- It creates a cleaner recovery path when the ref is stale or ambiguous.

Failure response should include:

- Whether the snapshot was stale.
- Whether the referenced node still exists.
- Candidate replacement nodes when possible.
- Current screenshot path and a compact updated snapshot.

## Priority 3: Text And Locator Convenience Actions

Add higher-level action tools for common agent tasks when the agent has not explicitly selected a ref.

Recommended tools:

- `android_tap_text`
- `android_tap_content_desc`
- `android_fill_near_label`
- `android_click`

Example `android_click` input:

```json
{
  "text": "Login",
  "role": "button",
  "fuzzy": true,
  "timeoutMs": 5000
}
```

Rules:

- Internally call the same semantic snapshot path.
- If exactly one strong candidate exists, act on it.
- If multiple candidates exist, do not guess blindly; return candidates with refs and reasons.
- Prefer accessibility action over raw tap when the target supports it.

This is not meant to become a full Appium locator DSL. Keep it small and agent-oriented.

## Priority 4: Wait And Recovery Primitives

Add explicit waiting tools and make action tools optionally wait after acting.

Recommended tools:

- `android_wait_for_text`
- `android_wait_for_ref_gone`
- `android_wait_for_package`
- `android_wait_for_screen_change`
- `android_current_app`

Action tools should support:

```json
{
  "after": {
    "waitForText": "Home",
    "timeoutMs": 5000
  }
}
```

Why this matters:

- Playwright MCP benefits from the browser automation stack's waiting behavior.
- Android UI state often changes asynchronously after taps, launches, permission dialogs, and keyboard actions.
- LLM agents need clear feedback: changed, unchanged, timed out, or blocked by another screen.

Failure responses should be designed for the next agent step, not just for logging.

> **Current status:** `android_wait_for_text`, `android_wait_for_package`,
> `android_wait_for_screen_change`, and `android_current_app` are implemented.
> `android_wait_for_ref_gone` and `after.waitForText` / `after.waitForPackage`
> post-action conditions are **not yet implemented**.

## Priority 5: Action Result Should Return Fresh Context

Most mutating tools should return enough updated state for the agent to continue without immediately making another observation call.

For example, `android_tap_ref` should return:

- `success`
- `actionStrategy`: `accessibility_action`, `coordinate_tap`, or `fallback`
- `beforeSnapshotId`
- `afterSnapshotId`
- `screenChanged`
- `currentPackage`
- optional compact `nodes`
- optional `imagePath`

This makes the MCP more like an agent loop and less like a thin ADB wrapper.

## Priority 6: Trace For Agent Debugging

Add task-level trace capture focused on recovery and inspection, not test reporting.

Recommended tools:

- `android_trace_start`
- `android_trace_stop`
- `android_trace_status`

Trace each step:

- timestamp
- tool name and sanitized input
- result or error
- screenshot path
- semantic snapshot
- elapsed time

Keep traces local. A simple directory of JSON files and PNGs is enough for v1.

Suggested path:

```text
/tmp/android-ui-mcp/traces/<trace-id>/
```

> **Current status:** Not yet implemented.

## Priority 7: Capability Groups

Split MCP tools into capability groups so clients do not always load every schema.

Suggested groups:

- `core`: snapshot, tap ref, fill ref, swipe, key, screenshot
- `ocr`: OCR screen, force OCR, OCR debug
- `apps`: list apps, launch app, current app
- `debug`: dump tree, dump compact, bridge ping, bridge exit
- `trace`: trace start/stop/status
- `vision`: raw coordinate tap, raw coordinate long press, raw coordinate mouse-like tools

This mirrors Playwright MCP's capability approach and helps reduce tool confusion and token cost.

> **Current status:** Not yet implemented.

## Priority 8: Android System Workflow Helpers

These are Android-specific advantages over Playwright MCP and should become part of the product identity.

Recommended tools:

- `android_open_notifications`
- `android_open_quick_settings`
- `android_close_keyboard`
- `android_grant_permission_dialog`
- `android_go_home`
- `android_open_recents`
- `android_switch_recent_app`
- `android_current_app`

These tools make the MCP useful for real-device tasks that browser MCPs cannot cover.

> **Current status:** `android_current_app` is implemented. All other system
> workflow helpers listed above are **not yet implemented**.

## Priority 9: Test And Fake-Bridge Coverage

Add tests around the agent-facing contract before expanding the tool surface too far.

Highest-value tests:

- Semantic node ranking and deduplication.
- Ref generation stability within a snapshot.
- Stale ref failure response.
- Candidate disambiguation for duplicate text.
- OCR/accessibility merge behavior.
- Desktop MCP input validation.
- Fake bridge integration tests that do not require a device.
- Real-device smoke tests for launch, snapshot, tap ref, fill ref, wait for text, and screenshot.

The goal is not a full UI test framework. The goal is confidence that the MCP gives agents reliable observations, actions, and recovery data.

> **Current status:** Automated tests and fake-bridge integration tests are
> not yet implemented.

## Lower Priority Or Out Of Scope For Now

Defer these unless a concrete user need appears:

- Appium-compatible locator DSL.
- Full assertion DSL.
- Test runner, retries, sharding, reports.
- Network interception for arbitrary apps.
- Deep app storage/session management.
- Large CV/object-detection models.
- Cloud OCR or screenshot upload.

## Near-Term Implementation Order

1. Add `ref`, `snapshotId`, `editable`, `role`, and `score` to `android_get_semantic_screen`.
2. Add `android_tap_ref` with accessibility action first and coordinate fallback.
3. Add `android_fill_ref` for editable nodes.
4. Add candidate-returning `android_tap_text`.
5. Add `android_wait_for_text` and `android_wait_for_screen_change`.
6. Make mutating tools optionally return a fresh compact snapshot.
7. Add local trace capture.
8. Split tools into capability groups.

> **Status:** Items 1–6 are implemented. Items 7 (trace capture) and 8
> (capability groups) are not yet implemented.
