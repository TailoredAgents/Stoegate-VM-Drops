# Archived RVM Implementation

The application that preceded Stonegate SMS Outreach is preserved as a
historical snapshot in the Git tag
[`archive/rvm-v1`](https://github.com/TailoredAgents/Stoegate-VM-Drops/tree/archive/rvm-v1).

- Source commit: `c5236465690b5dc3b1bc199a8f347b36cf6ba772`
- Repository commit:
  [TailoredAgents/Stoegate-VM-Drops@c523646](https://github.com/TailoredAgents/Stoegate-VM-Drops/commit/c5236465690b5dc3b1bc199a8f347b36cf6ba772)
- Status: read-only reference; not part of the active build, runtime, worker, or
  Render configuration

Use the archive only for historical behavior, migration analysis, or rollback
research. Do not copy credentials or provider configuration from it into the
active application. Fixes for Stonegate SMS Outreach belong in the active
source tree, not in the archive.

The Render database and service identifiers still contain the previous product
slug so existing resources are preserved. That naming is intentionally stable
and does not make the archived implementation active.
