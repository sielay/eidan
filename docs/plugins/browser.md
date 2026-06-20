# Browser · matbot engine plugin

The `browser` plugin supplies the platform pieces the matbot web build needs to run entirely in a browser tab, with no `matbot.yaml`, no filesystem, and no package manager. It provides a storage backend over IndexedDB (for sessions, settings, and other stores) plus an OPFS-backed file store, and a WebCrypto-backed vault for secrets. It is the browser analogue of the node app's filesystem stores and built-in `plugin` tool, shipped as a plugin so the web build is assembled purely from plugins over a platform-neutral core.

This is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. It is browser-only — on node its `setup()` throws and the loader skips it, leaving the host's real filesystem backend in place. Because the browser has no config file, this plugin also owns the durable list of user-added plugins: it persists them into its own settings (IndexedDB) and replays them on boot so a session's installed plugins survive a realm reload.

## Tools

| Tool | Purpose |
|------|---------|
| `plugin` | Manage matbot plugins live in the browser process. Inputs depend on `action`: `list` (configured + loaded plugins, with their types and tools); `discover_local` (plugins bundled into this build but not yet loaded); `add` (`specifier`: a bundled package name or a URL to raw source — confirmed out-of-band, then loaded and persisted); `remove` (`specifier`: package name preferred, or configured specifier — deactivates and forgets); `reload` (`specifier`: re-import to pick up code changes); `store-key` (`key`: store a secret a plugin/provider reported missing, value entered out-of-band into the WebCrypto vault). No config file is edited and no package manager runs. |

## Example

```
plugin({ action: "discover_local" })   → [{ name, specifier, description }, …]
plugin({ action: "add", specifier: "@matatbread/matbot-tool-http" })
  → confirm dialog → "… installed and is now active."
```

## Notes

- Backends provided: `IDBStore` (IndexedDB `Store`), `OPFSFileStore` (OPFS `FileStore`), and `WebCryptoVault` / `LocalStorageVault`, assembled as `BrowserStorageBackend`.
- `add` and `store-key` confirm out-of-band (a confirm dialog / separate value prompt) so a malicious prompt cannot self-install plugins or exfiltrate secrets through the conversation.
- Added plugins persist across reloads; where possible the canonical package name is stored (re-resolves via the import map) rather than an ephemeral synthetic id or http-only path.
- `remove`/`reload` accept the plugin's package.json name (preferred, unambiguous) or its configured specifier.
