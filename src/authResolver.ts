import type { ServerVersion } from './server-config/types';

import * as net from 'net';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import { Log } from './common/logger';
import SSHDestination from './ssh/sshDestination';
import { SSHTunnelConfig } from './ssh/sshConnection';
import NativeSSHConnection, { isGssapiAuthenticationRequested } from './ssh/nativeClient';
import type { SSHClient, SSHExecChannel } from './ssh/sshClient';
import SSHConfiguration, { getSSHConfigPath, type HostConfiguration } from './ssh/sshConfig';
import { openSSHConnection, openAgentForwardSession, type ConnectionUI, type ConnectPlan, type HopPlan, type HostVerificationPolicy, type OpenedSSHConnection, type ProxyCommandPlan } from './ssh/connect';
import { untildify } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError, findServerInstallPath, type ServerInstallResult } from './serverSetup';
import type { RemotePlatform } from './types';
import { isWindows } from './common/platform';
import * as os from 'os';

export type { HostVerificationPolicy } from './ssh/connect';

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

/**
 * Convert a glob-style pattern (used in SendEnv) to a regular expression.
 * Supports * (matches any characters) and ? (matches single character).
 */
function globToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Convert glob wildcards to regex
    const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`);
}

/**
 * Filter environment variables based on SendEnv patterns.
 * Patterns can include wildcards like LC_* or exact names like LANG.
 */
function filterEnvBySendEnv(sendEnvPatterns: string[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const pattern of sendEnvPatterns) {
        const regex = globToRegex(pattern);
        for (const [key, value] of Object.entries(process.env)) {
            if (regex.test(key) && value !== undefined) {
                result[key] = value;
            }
        }
    }

    return result;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

/**
 * Split a ProxyCommand value into argv tokens.
 *
 * ssh-config v5.0.0 reassembles ProxyCommand's value into a single string (to
 * preserve quoting across the param boundary), but the spawn code expects
 * individual argv tokens. Calling `[].concat(someString)` does NOT split the
 * string — it wraps it, so `spawn()` ends up receiving the whole command
 * line as the executable path and fails with ENOENT. See
 * https://github.com/jeanp413/open-remote-ssh/issues/271 and
 * https://github.com/jeanp413/open-remote-ssh/issues/273.
 *
 * This helper mirrors OpenSSH's own ProxyCommand tokenization:
 * - whitespace separates tokens (outside quotes)
 * - double quotes group a single token
 * - backslash escapes the next character (on non-Windows platforms)
 *
 * On Windows, backslash is the path separator and is NOT treated as an
 * escape character. This matches the behavior of Windows OpenSSH, which
 * does not support backslash escaping in ProxyCommand values.
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
function splitProxyCommand(value: string | string[]): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (!isWindows && ch === '\\' && i + 1 < value.length) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            i += 1;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
            i += 1;
            continue;
        }
        cur += ch;
        hasToken = true;
        i += 1;
    }
    if (hasToken) {out.push(cur);}
    return out;
}

/**
 * Throw if a `%h`, `%n` or `%r` token in a ProxyCommand line meant for a shell
 * expands to more than a plain host or user name. These values can come from
 * the remote authority (cf. OpenSSH 9.6, CVE-2023-51385). Unused tokens are
 * skipped, so e.g. a user name with a space only matters if the line uses `%r`.
 */
function assertShellSafeProxyCommand(line: string, values: Record<string, string>) {
    for (const [, token] of line.matchAll(/%(.)/g)) {
        if ('hnr'.includes(token) && !/^[\w.@:[\]-]*$/.test(values[token])) {
            throw new Error(`ProxyCommand: %${token} expands to '${values[token]}', which contains characters other than letters, digits and '_.@:[]-'`);
        }
    }
}

/**
 * The port a `ProxyJump` hop listens on.
 *
 * A jump host does not inherit the target's `Port`; ssh falls back to 22 for it.
 * Both the connection made to a hop and the `forwardOut` that reaches the next
 * one must agree on this, otherwise the first hop of a target declared on a
 * non-default port is dialed on that port instead of its own.
 */
export function getProxyJumpPort(dest: SSHDestination, config: Record<string, string>): number {
    return (config['Port'] && parseInt(config['Port'], 10)) || dest.port || 22;
}

export const MAX_PROXY_JUMPS = 10;

export type ProxyJumpHop = [SSHDestination, HostConfiguration];

/**
 * The hops of a `ProxyJump` value, in the order they have to be connected to.
 *
 * A jump host can declare a `ProxyJump` of its own, which has to be traversed
 * before that host is reachable, so the chain is expanded depth first. `path`
 * carries the hosts already being resolved, so a config that jumps back to one
 * of them is reported instead of recursing forever.
 */
export function resolveProxyJumps(
    value: string,
    getHostConfiguration: (host: string) => Record<string, string>,
    path: string[] = []
): ProxyJumpHop[] {
    const hops: ProxyJumpHop[] = [];

    for (const entry of value.split(',').filter(i => !!i.trim())) {
        const dest = SSHDestination.parse(entry);
        const config = getHostConfiguration(dest.hostname);
        const host = dest.hostname.toLowerCase();

        if (path.includes(host)) {
            throw new Error(`ProxyJump loops back to '${dest.hostname}' (${[...path, host].join(' -> ')})`);
        }

        if (path.length >= MAX_PROXY_JUMPS) {
            throw new Error(`ProxyJump chain is longer than ${MAX_PROXY_JUMPS} hops`);
        }

        if (config['ProxyJump']) {
            hops.push(...resolveProxyJumps(config['ProxyJump'], getHostConfiguration, [...path, host]));
        }

        hops.push([dest, config]);
    }

    return hops;
}

/** Where the window reaches the remote server, and what its extension host needs. */
interface ResolvedServer {
    localPort: number;
    connectionToken: string;
    envVariables: Record<string, string | null>;
}

type InstallServer = (conn: Pick<SSHClient, 'exec' | 'execPartial'>) => Promise<ServerInstallResult>;

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private openedConnection: OpenedSSHConnection | undefined;
    private sshConnection: SSHClient | undefined;
    private sshAgentSock: string | undefined;
    private agentForwardSession: SSHExecChannel | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private labelFormatterDisposable: vscode.Disposable | undefined;

    private readonly connectionUI: ConnectionUI = {
        input: (title, password) => Promise.resolve(vscode.window.showInputBox({ title, password, ignoreFocusOut: true })),
        confirm: async (message, action) => await vscode.window.showWarningMessage(message, { modal: true }, action) === action,
        error: message => void vscode.window.showErrorMessage(message),
    };

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const serverVersion = remoteSSHconfig.get<ServerVersion>('serverVersion', 'match');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, RemotePlatform>>('remotePlatform', {});
        const remoteArchMap = remoteSSHconfig.get<Record<string, string>>('remoteArch', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const serverInstallPathMap = remoteSSHconfig.get<Record<string, string>>('serverInstallPath', {});
        const verifyUnknownHosts = remoteSSHconfig.get<HostVerificationPolicy>('verifyUnknownHosts', 'ask')!;
        const verifyKnownHosts = remoteSSHconfig.get<HostVerificationPolicy>('verifyKnownHosts', 'reject')!;

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? SSHConfiguration.interpolate(sshHostConfig['HostName'], { '%': '%', 'h': sshDest.hostname }) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);

                const valuesToInterpolate = {
                    '%': '%',
                    'd': os.homedir(),
                    'h': sshHostName,
                    'i': os.userInfo().uid.toString(),
                    'k': sshHostConfig['HostKeyAlias'] || sshDest.hostname,
                    'L': os.hostname(),
                    'l': os.hostname(),
                    'n': sshDest.hostname,
                    'p': (sshDest.port || 22).toString(),
                    'r': sshUser,
                    'u': os.userInfo().username || '',
                };
                const interpolatePath = (value: string) => SSHConfiguration.interpolate(value, valuesToInterpolate);

                const identityAgent = sshHostConfig['IdentityAgent'] ? interpolatePath(sshHostConfig['IdentityAgent']) : undefined;
                this.sshAgentSock = identityAgent || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';

                // Extract SendEnv configuration and filter local environment variables
                this.logger.trace(`SSH config raw SendEnv value: ${JSON.stringify(sshHostConfig['SendEnv'])}`);
                const sendEnvRaw = sshHostConfig['SendEnv'];
                const sendEnvPatterns: string[] = sendEnvRaw
                    ? (Array.isArray(sendEnvRaw) ? sendEnvRaw : [sendEnvRaw])
                    : [];
                this.logger.trace(`SendEnv patterns after normalization: ${JSON.stringify(sendEnvPatterns)}`);
                const sendEnvVars = sendEnvPatterns.length > 0 ? filterEnvBySendEnv(sendEnvPatterns) : {};
                if (sendEnvPatterns.length > 0) {
                    if (Object.keys(sendEnvVars).length > 0) {
                        this.logger.info(`SendEnv: Sending ${Object.keys(sendEnvVars).length} environment variable(s) to remote: ${Object.keys(sendEnvVars).join(', ')}`);
                    } else {
                        this.logger.trace(`SendEnv: No local environment variables matched patterns: ${sendEnvPatterns.join(', ')}`);
                    }
                }

                // Find the custom install path for this hostname (supports wildcards)
                const customInstallPath = findServerInstallPath(sshDest.hostname, serverInstallPathMap);

                const installServer: InstallServer = conn => installCodeServer(
                    conn,
                    serverDownloadUrlTemplate,
                    serverVersion,
                    defaultExtensions,
                    [],
                    sendEnvVars,
                    remotePlatformMap[sshDest.hostname],
                    remoteServerListenOnSocket,
                    customInstallPath,
                    this.logger,
                    this.context.extensionPath,
                    remoteArchMap[sshDest.hostname]
                );

                // The bundled ssh2 library cannot perform the SSH
                // gssapi-with-mic method, which needs access to the platform's
                // Kerberos credentials. When the host config asks for GSSAPI,
                // delegate the connection to the local ssh client: it supports
                // GSSAPI natively and applies the user's own ssh_config for
                // everything else (ProxyJump, ProxyCommand, ForwardAgent, ...).
                const useNativeClient = isGssapiAuthenticationRequested(sshHostConfig);

                let resolved: ResolvedServer | undefined;

                if (!useNativeClient) {
                    const plan: ConnectPlan = {
                        jumps: [],
                        target: {
                            hostName: sshHostName,
                            port: sshPort,
                            user: sshUser,
                            identityFiles: (sshHostConfig['IdentityFile']?.map(f => untildify(interpolatePath(f)))) || [],
                            identitiesOnly: (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes',
                            agentForward,
                            knownHosts: pickKnownHostsConfig(sshHostConfig),
                        },
                        preferredAuthentications: sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'],
                        agentSock: this.sshAgentSock,
                        connectTimeout,
                        keepaliveInterval: 0,
                        verifyUnknownHosts,
                        verifyKnownHosts,
                    };

                    if (sshHostConfig['ProxyJump']) {
                        const proxyJumps = resolveProxyJumps(
                            sshHostConfig['ProxyJump'],
                            (host) => sshconfig.getHostConfiguration(host)
                        );
                        plan.jumps = proxyJumps.map(([proxy, proxyHostConfig]): HopPlan => ({
                            hostName: proxyHostConfig['HostName'] ? SSHConfiguration.interpolate(proxyHostConfig['HostName'], { '%': '%', 'h': proxy.hostname }) : proxy.hostname,
                            port: getProxyJumpPort(proxy, proxyHostConfig),
                            user: proxyHostConfig['User'] || proxy.user || sshUser,
                            identityFiles: (proxyHostConfig['IdentityFile']?.map(f => untildify(interpolatePath(f)))) || [],
                            identitiesOnly: (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes',
                            agentForward: enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes',
                            knownHosts: pickKnownHostsConfig(proxyHostConfig),
                        }));
                    } else if (sshHostConfig['ProxyCommand']) {
                        plan.proxyCommand = buildProxyCommand(sshHostConfig['ProxyCommand'], {
                            '%': '%',
                            'h': sshHostName,
                            'n': sshDest.hostname,
                            'p': sshPort.toString(),
                            'r': sshUser,
                        });
                    }

                    if (!resolved) {
                        this.openedConnection = await openSSHConnection(plan, this.connectionUI, this.logger);
                        this.sshConnection = this.openedConnection.connection;
                    }
                } else {
                    this.logger.info(`GSSAPI authentication requested for ${sshDest.hostname}; connecting via the local SSH client`);
                    this.sshConnection = new NativeSSHConnection({
                        destination: sshDest.user ? `${sshDest.user}@${sshDest.hostname}` : sshDest.hostname,
                        port: sshDest.port,
                        configFile: getSSHConfigPath(),
                        dynamicForwarding: enableDynamicForwarding,
                        readyTimeout: connectTimeout * 1000,
                        logger: this.logger
                    });
                }

                if (!resolved) {
                    resolved = await this.setupInProcess(agentForward, enableDynamicForwarding, installServer);
                }

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(resolved.envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', resolved.localPort, resolved.connectionToken);
                resolvedResult.extensionHostEnv = resolved.envVariables;
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    /** Set up the server over the connection this window opened itself. */
    private async setupInProcess(agentForward: boolean, enableDynamicForwarding: boolean, installServer: InstallServer): Promise<ResolvedServer> {
        await this.sshConnection!.connect();

        const envVariables: Record<string, string | null> = {};
        if (agentForward) {
            // The agent-forwarding socket sshd creates is scoped to the ssh channel that
            // requested it and is torn down as soon as that channel closes. The server
            // install/start script runs on its own short-lived exec channel, so any
            // SSH_AUTH_SOCK it reports is already stale by the time we get here. Keep a
            // dedicated channel open for the lifetime of the connection instead, and use
            // its socket path everywhere else (terminals, extension host). Agent
            // forwarding is best-effort: a failure here must not prevent connecting.
            try {
                const { channel, sock } = await openAgentForwardSession(this.sshConnection!, this.logger);
                this.agentForwardSession?.close();
                this.agentForwardSession = channel;
                if (sock) {
                    envVariables['SSH_AUTH_SOCK'] = sock;
                }
            } catch (e) {
                this.logger.error(`Failed to setup agent forwarding`, e);
            }
        }

        const installResult = await installServer(this.sshConnection!);

        if (enableDynamicForwarding) {
            const socksPort = await findRandomPort();
            this.socksTunnel = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_socks_${socksPort}`,
                localPort: socksPort,
                socks: true
            });
        }

        const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
        this.tunnels.push(tunnelConfig);

        return { localPort: tunnelConfig.localPort, connectionToken: installResult.connectionToken, envVariables };
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort, '127.0.0.1');
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.sshConnection?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    dispose() {
        disposeAll(this.tunnels);
        this.agentForwardSession?.close();
        this.agentForwardSession = undefined;
        if (this.openedConnection) {
            this.openedConnection.dispose();
        } else {
            this.sshConnection?.close();
        }
        this.labelFormatterDisposable?.dispose();
    }
}

/** The known_hosts related directives, which is all host key verification reads. */
function pickKnownHostsConfig(hostConfig: HostConfiguration): HopPlan['knownHosts'] {
    return {
        UserKnownHostsFile: hostConfig['UserKnownHostsFile'],
        GlobalKnownHostsFile: hostConfig['GlobalKnownHostsFile'],
        HostKeyAlias: hostConfig['HostKeyAlias'],
    };
}

function buildProxyCommand(proxyCommandValue: string | string[], proxyCommandValues: Record<string, string>): ProxyCommandPlan {
    const proxyCommandLine = [proxyCommandValue].flat().join(' ');
    const interpolateProxyCommand = (value: string) => SSHConfiguration.interpolate(value, proxyCommandValues);

    // Like OpenSSH: the shell parses the whole line, quoting included.
    let command = interpolateProxyCommand(proxyCommandLine);
    let args: string[] = [];
    let options: ProxyCommandPlan['options'] = { shell: true };
    if (isWindows) {
        // Like Win32-OpenSSH: no shell, except cmd.exe for batch
        // files and program paths with a space.
        args = splitProxyCommand(proxyCommandValue).map(interpolateProxyCommand);
        command = args.shift()!;
        options = {};
        if (/\.(bat|cmd)$/.test(command) || command.includes(' ')) {
            command = `"${command}"`;
            args = args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
            options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
        }
    }

    if (options.shell) {
        assertShellSafeProxyCommand(proxyCommandLine, proxyCommandValues);
    }

    return { command, args, options };
}
