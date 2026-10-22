# Getting started

From nothing to a working remote window in VSCodium or Code - OSS. Allow about ten minutes.

1. [Check your server](#1-check-your-server)
2. [Set up SSH on your computer](#2-set-up-ssh-on-your-computer)
3. [Install the extension](#3-install-the-extension)
4. [Configure the host](#4-configure-the-host)
5. [Connect](#5-connect)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Check your server

Nothing has to be installed on the server in advance: the extension downloads and starts its
own server component on the first connection. The server needs:

| Requirement | How to check |
|---|---|
| SSH login works | `ssh user@server` from your computer |
| TCP forwarding allowed (default) | `sudo sshd -T \| grep -i allowtcpforwarding` prints `yes` |
| A supported system with `bash` | Linux x86_64 / ARM64 / ARMv7, macOS, FreeBSD, Windows 10+ (see [README](../README.md#ssh-host-requirements)) |
| Outbound HTTPS to `github.com` | `curl -sI https://github.com \| head -1` on the server |
| About 200 MB free in your home directory | `df -h ~` |

If `AllowTcpForwarding` is `no`, set it to `yes` in `/etc/ssh/sshd_config` and reload sshd
(`sudo systemctl reload ssh` on Debian/Ubuntu, `sshd` elsewhere).

Alpine Linux additionally needs:

```bash
sudo apk add bash libstdc++
```

No internet on the server? Download the matching
`vscodium-reh-<os>-<arch>-<version>.tar.gz` from
[VSCodium releases](https://github.com/VSCodium/vscodium/releases), host it somewhere the server
can reach, and point `remote.SSH.serverDownloadUrlTemplate` at it.

## 2. Set up SSH on your computer

### 2a. A host entry

Add the server to `~/.ssh/config` (Windows: `C:\Users\<you>\.ssh\config`). The `Host` name is
what you will pick in the editor and use in the settings below.

```
Host myserver
    HostName 203.0.113.10
    User alice
```

Check it from a terminal:

```bash
ssh myserver
```

### 2b. Key-based login (recommended)

Without a key you type your password on every connection.

```bash
ssh-keygen -t ed25519           # accept the defaults, set a passphrase
ssh-copy-id myserver            # Windows: see note below
```

Windows has no `ssh-copy-id`; use:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh myserver "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

If your key has a passphrase, load it into an SSH agent before starting the editor so you are
not asked for it on every connection:

```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519
```

On Windows, start the "OpenSSH Authentication Agent" service and run `ssh-add`.

## 3. Install the extension

Requires **VSCodium** or **Code - OSS**. Microsoft's VS Code does not allow the proposed API this
extension needs.

**Close the editor completely**, then run the installer.

Linux / macOS:

```bash
curl -fsSLO https://raw.githubusercontent.com/GuyliandeJong/oneshot-remote-ssh/main/install/install.sh
bash install.sh
```

Windows (PowerShell):

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/GuyliandeJong/oneshot-remote-ssh/main/install/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

- downloads the latest `oneshot-remote-ssh.vsix` from
  [Releases](https://github.com/GuyliandeJong/oneshot-remote-ssh/releases),
- removes Open Remote - SSH and Microsoft Remote-SSH if present (they register the same
  `ssh-remote` connections; keep them with `--keep-others` / `-KeepOthers`),
- installs the extension,
- adds `"enable-proposed-api": ["guyliandejong.oneshot-remote-ssh"]` to
  `~/.vscode-oss/argv.json` (a backup is made first).

Start the editor again and check:

```bash
codium --list-extensions | grep oneshot      # or: code --list-extensions
```

<details>
<summary>Manual install instead of the script</summary>

1. Download `oneshot-remote-ssh.vsix` from
   [Releases](https://github.com/GuyliandeJong/oneshot-remote-ssh/releases).
2. `codium --install-extension oneshot-remote-ssh.vsix`
3. Command palette (`Ctrl+Shift+P`) → **Preferences: Configure Runtime Arguments** and add:

   ```json
   "enable-proposed-api": ["guyliandejong.oneshot-remote-ssh"]
   ```

4. Uninstall Open Remote - SSH / Microsoft Remote-SSH if installed.
5. Restart the editor.

</details>

## 4. Configure the host

Open your user settings as JSON: command palette → **Preferences: Open User Settings (JSON)**.

### Only if your server asks for MFA on every SSH session

This is the reason this fork exists. With Duo `login_duo` (or similar) as a `ForceCommand`,
each setup step costs one prompt. Tell the extension the server's platform and architecture so
setup runs as a single command:

```json
"remote.SSH.remotePlatform": { "myserver": "linux" },
"remote.SSH.remoteArch":     { "myserver": "x86_64" }
```

- The key (`myserver`) must match the `Host` name from step 2a exactly, including case.
- `remotePlatform`: `linux`, `macos` or `windows`.
- `remoteArch`: what `uname -m` prints on the server, for example `x86_64`, `aarch64`, `armv7l`.

Without these settings everything still works; it just costs four prompts instead of one.

### Only if you use Code - OSS (not VSCodium)

Code - OSS has no server build of its own, so use VSCodium's:

```json
"remote.SSH.serverBinaryName": "codium-server",
"remote.SSH.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz",
"remote.SSH.serverVersion": "latest",
"remote.SSH.serverValidation": "force"
```

## 5. Connect

1. Command palette → **OneShot SSH: Connect to Host…** → `myserver`
   (or the **SSH Targets** list in the Remote Explorer).
2. Approve the MFA prompt if your server uses one.
3. The first connection downloads the server (a few seconds to a minute). The status bar shows
   `SSH: myserver` when you are in.
4. **File → Open Folder…** now browses the server.

To get back to a project quickly, save it as a workspace (**File → Save Workspace As…**). A
workspace file stored on your own computer needs `uri` entries, not `path`:

```json
{
    "remoteAuthority": "ssh-remote+myserver",
    "folders": [
        { "name": "home", "uri": "vscode-remote://ssh-remote+myserver/home/alice" }
    ]
}
```

## 6. Troubleshooting

All connection details are in **Output** → choose **OneShot Remote SSH** in the dropdown.

| Symptom | Cause and fix |
|---|---|
| Error mentioning *proposed API* | The `argv.json` entry is missing or the editor was not fully restarted. See step 3. |
| Still several MFA prompts | `remotePlatform` / `remoteArch` keys don't match the host name you connected with. In the log, `Detected platform` and `Detected architecture` must have the same timestamp. |
| *Couldn't install vscode server … non-zero exit status* | Read the `Server install command stdout:` block above the error in the log; it names the failing step. |
| *Downloaded tarball is corrupt or incomplete* | The download URL does not exist (GitHub "Not Found"). Code - OSS: add the settings from step 4. Check the `Found release for "latest"` line in the log. |
| *No tool to download server binary* | Install `wget` or `curl` on the server. |
| *Missing libstdc++* | Alpine: `sudo apk add bash libstdc++`. |
| Connection refused / timeout | Test `ssh myserver` in a terminal first; fix SSH before the editor. |
| Asked for the key passphrase every time | Load the key into an SSH agent (step 2b) before starting the editor. |
| Folder opens in *Restricted Mode* | Trust the folder: click **Restricted Mode** in the status bar → **Trust**. |

Still stuck? [Open an issue](https://github.com/GuyliandeJong/oneshot-remote-ssh/issues) with the
log from the Output panel (remove host names and IP addresses you don't want to share).
