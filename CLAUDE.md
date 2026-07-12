# context-daemon

## Finding code in this repo

Always use the `context-daemon` `search_context` tool FIRST when you need to
find or understand code here — describe what you want in plain language. It
returns the relevant functions (and their dependencies) as a compact
ghost-file view of the source file, which keeps context small and token cost
low.

Only read a whole file when `search_context` returns nothing, or when you
genuinely need the entire file (for example, its full top-level wiring beyond
what the ghost-file header shows).

This is also a dogfooding example: this project *is* the daemon, so working
on it through its own `search_context` is the intended workflow.
