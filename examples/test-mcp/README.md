# Test MCP servers

Three dependency-free stdio servers used to exercise lazy loading in the panel:

| server | tools |
|---|---|
| demo-fs | demo_files, demo_read |
| demo-math | demo_add, demo_slow_add (1s delay) |
| demo-sys | demo_time, demo_host |

Add one in the sandbox profile with the MCP tab (transport stdio, command `node`,
args `<repo>/examples/test-mcp/server.mjs demo-fs`), enable it, then use the lazy switch on
that server. A lazy server's tools stay out of the model until loaded with `hub_tools`
(or the Load button).
