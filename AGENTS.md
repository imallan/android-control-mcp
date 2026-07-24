# Test Fixtures

Keep all test fixture strings synthetic and feature-neutral.

- Do not use labels, package names, people, organizations, or workflows copied from a local emulator, a production app, or a real product surface.
- Prefer short generic labels such as `Sample`, `First`, `Second`, `Third`, `Fourth`, `Primary action`, and `Confirm`.
- Use generic IDs that match the fixture label; avoid product or feature names in IDs, comments, test names, and assertions when they are not required by the behavior under test.
- Preserve the semantic behavior under test—roles, states, hierarchy, geometry, collection layout, and interaction—not the real-world wording.
- Before submitting test changes, scan fixture files for product-specific strings and replace incidental examples with generic equivalents.
