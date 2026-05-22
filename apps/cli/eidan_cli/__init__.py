"""Eidan CLI.

`eidan` runs as the authenticated operator (login, repl).
`eidan admin` runs as the unauthenticated operator process (migrations,
plugin install/list/remove). The split is intentional — admin commands
are env-var driven and never touch the user's stored JWT.
"""

__version__ = "0.1.0"
