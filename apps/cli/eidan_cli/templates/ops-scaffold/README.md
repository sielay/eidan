# <YOUR DEPLOYMENT NAME>

Operator-private ops repo for an eidan deployment. Everything here
is yours — eidan upstream never touches this directory. Use it to
track your nodes, encrypted secrets, and any operator notes.

## Layout

| File | Purpose |
|---|---|
| `topology.yml` | Source of truth for every node. Vault-encrypt secrets before committing. |
| `.vault-pass` | Ansible-vault password file. **gitignored**. `chmod 0600`. |
| `.vault-pass.example` | Placeholder; copy to `.vault-pass` and edit. |
| `.gitignore` | Excludes `.vault-pass` + runtime artefacts. |

## First-time setup

1. Edit `topology.yml` — fill in your nodes, replace `REPLACE-ME` placeholders.
2. Generate the master key once: `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`. Record it offline (1Password / paper) and paste into `auth_master_key` for every node sharing the same Postgres.
3. Set up the vault password:

   ```bash
   cp .vault-pass.example .vault-pass
   $EDITOR .vault-pass         # replace with a long random passphrase
   chmod 0600 .vault-pass
   ```

4. Encrypt the sensitive scalars:

   ```bash
   ansible-vault encrypt_string --vault-id default@.vault-pass \
     'sk-ant-...' --name 'api_key'
   # paste the !vault |... output into topology.yml under the right field
   ```

5. Commit (with the vault layer in place):

   ```bash
   git init
   git add .
   git commit -m "initial topology"
   git remote add origin git@github.com:<you>/<this-repo>.git
   git push -u origin main
   ```

## Day-to-day

```bash
# Reconcile every node:
eidan deploy

# One node at a time:
eidan deploy --node kasha

# Enable / disable a plugin on a node:
eidan plugin disable imap --node kasha
eidan plugin enable  imap --node kasha

# Inspect:
eidan node list
eidan node show kasha
```

## Backups

Treat `.vault-pass` as the master key — losing it means every
secret in `topology.yml` is unrecoverable. Back it up to a separate
location from this repo (password manager, hardware key, paper in a
safe). The git repo itself is fine to host on a private GitHub /
self-hosted Forgejo / etc.
