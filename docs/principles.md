# Quiver principles

Quiver is infrastructure for controlled, source-backed work. It drafts; a
professional remains responsible for judgment and final sign-off.

## 1. Users own their memory

Memory is human-readable text and structured facts on the user's machine.
Facts carry provenance and begin in a pending review queue. Only a user
accepting, editing, or pinning a fact makes it active context. There is no
opaque vector store on the default path.

## 2. Users control what the AI uses

The context manifest makes the loaded memory, skills, tools, conversation,
inputs, endpoint, and sensitivity route inspectable. The consent gate blocks
the model call until the user approves the context. The finance-client profile
enables this gate by default.

## 3. Users can inspect what the AI did

Quantitative claims must be source-backed or explicitly unresolved. Evidence
records preserve source locations, approval state, and provenance; Office
deliverables require a structurally valid evidence companion before final
sign-off. Audit records are local and tamper-evident.

## Associate / VP operating model

The maker (Associate) drafts. The checker (VP) independently evaluates the
result using deterministic acceptance checks and, where configured, a separate
model. An infrastructure failure, empty result, missing evidence file, or
unsupported check is a visible failure—not an approval.

## Honesty and boundaries

- Safety properties live in enforced gates, path policy, sensitivity routing,
  and approval state—not in prompt instructions alone.
- Remote model or external-data calls occur only within engagement
  configuration and user approval. Missing or invalid sensitivity configuration
  fails closed.
- Standard OpenXML output is designed to work with Microsoft 365 storage;
  tenant policy, sync behavior, OAuth, and co-authoring remain engagement
  concerns.
- Quiver documents foundations, integration shapes, and runnable demos
  separately. A scaffold is not marketed as a production-ready workflow.

See [capabilities.md](capabilities.md) for implementation status and
[knowledge-and-storage.md](knowledge-and-storage.md) for PKM/M365 details.
