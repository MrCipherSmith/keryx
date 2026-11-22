# Plan

Use one read-only Core API and fixed Tauri commands for the current project window. Load a bounded catalog once per view, build local indexes for adjacency and typeahead, fetch page bodies and symbol neighborhoods on demand. Use Cytoscape.js Canvas for bounded graph projections and a text alternative. A deterministic small-neighborhood layout avoids a dependency on a layout engine before native profiling; compare ELK/Sigma if the measured budget requires it.

| State | Selection or query | Reload | Switch project or leave |
| --- | --- | --- | --- |
| Loading catalog | Controls identify the pending initial load | Restart the same request | Discard requests from the old window, AC4 |
| Ready | Preserve search and focus, show directional neighbors, AC2–3 | Keep readable content until replacement arrives | Release graph resources and discard stale responses, AC4 |
| Graph missing or stale | Wiki catalogue and valid pages remain readable, AC5 | Offer explicit rebuild when graph is missing or stale, then reload | Clear project-scoped state, AC4 |
| Initial read fails | Show actionable error and Retry | Retry this checkout | Ignore late result, AC4 |
| Detail or refresh fails | Keep valid previous content for refresh and show error; selection changes never display another document | Retry affected read | Ignore late result, AC4 |

Core, bridge and UI execute in parallel against the shared contract. Integration validates the exact checkout, absent layers, command version compatibility and routes. Verification is divided into GitHub Actions and a native macOS pass. Record native latency separately from automated results.
