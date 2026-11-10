# Fix five P1 findings from the Keryx Shell product review

## Intent statement

An operator can resume the correct conversation, stop or dismiss pending work, and approve shell commands deliberately in the terminal UI.

The product review reproduced context truncation, transcript and usage crossing a session boundary, Escape dispatching to Side-1, ineffective Escape interruption, and Enter approving a shell command by default. Repair those five behaviors and verify them against the real CLI with a deterministic local provider.

Scope covers agent TUI, chat TUI where the interrupt hint applies, and the existing readline approval behavior. The P2 findings and remote integrations are outside this flow.
