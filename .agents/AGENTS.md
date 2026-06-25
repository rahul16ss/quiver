# Quiver Design Guidelines

* **Adhere to DESIGN.md Spec**: Always consult and follow the Google Labs DESIGN.md specification (https://github.com/google-labs-code/design.md) when defining visual identities, colors, typography, or component design tokens.
* **Format Structure**:
  * Use YAML front matter at the top of design files for machine-readable tokens (colors, typography, components).
  * Use Markdown prose in the body with standard header hierarchy (Overview, Colors, Typography, Layout, Shapes, Components) to explain design rationale.
* **Token Definitions**: Refer to tokens as semantic roles rather than hardcoded variables (e.g., use `{colors.primary}` instead of raw hex values inside components).
* **Validation**: Run validation checks via CLI whenever design system tokens are modified:
  ```bash
  npx @google/design.md lint DESIGN.md
  ```
