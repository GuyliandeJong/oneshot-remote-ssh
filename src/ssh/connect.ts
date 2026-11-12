import type { ParsedKey } from 'ssh2-streams';

import * as cp from 'child_process';
import * as fs from 'fs';
import * as stream from 'stream';
import * as ssh2 from 'ssh2';
import type { Logger } from '../common/logger';
import { exists as fileExists } from '../common/files';
import SSHConnection from './sshConnection';
import type { SSHExecChannel } from './sshClient';
import { loadKnownHosts, matchHostKey, appendHostKey, replaceHostKey, removeHostFromEntry, findConflictingEntries, keyFingerprint, keyTypeOf, KnownHosts, KnownHostsEntry, KnownHostsFilesConfig } from './knownHosts';
import { gatherIdentityFiles, SSHKey } from './identityFiles';

// This module must stay free of the `vscode` API: the background connection
// holder runs it in a plain Node process. Everything taken from settings or
// ssh_config is resolved by the extension beforehand and passed in as a
// `ConnectPlan`; prompts go through `ConnectionUI`.

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export type HostVerificationPolicy = 'accept' | 'ask' | 'reject';

/** One SSH host to authenticate against: a `ProxyJump` hop or the target. */
export interface HopPlan {
    /** Address to dial, i.e. the interpolated `HostName`. */
    hostName: string;
    port: number;
    user: string;
    /** Interpolated, untildified `IdentityFile` values. */
    identityFiles: string[];
    identitiesOnly: boolean;
    agentForward: boolean;
    knownHosts: KnownHostsFilesConfig;
}

/** How the target is reached when it is not dialed directly. */
export interface ProxyCommandPlan {
    command: string;
    args: string[];
    options: Pick<cp.SpawnOptionsWithoutStdio, 'shell' | 'windowsHide' | 'windowsVerbatimArguments'>;
}

/**
 * Everything needed to open the connection. Plain JSON on purpose: it is
 * sent to the background holder as is, and its hash identifies the holder.
 */
export interface ConnectPlan {
    /** `ProxyJump` hops in connection order; empty for a direct connection. */
    jumps: HopPlan[];
    target: HopPlan;
    proxyCommand?: ProxyCommandPlan;
    preferredAuthentications: string[];
    agentSock?: string;
    /** In seconds. */
    connectTimeout: number;
    /** In milliseconds; 0 disables SSH keepalives. */
    keepaliveInterval: number;
    verifyUnknownHosts: HostVerificationPolicy;
    verifyKnownHosts: HostVerificationPolicy;
}

/** The prompts a connection may need, answered by whoever opened it. */
export interface ConnectionUI {
    /** Ask for a value (a passphrase, password or keyboard-interactive answer); undefined when dismissed. */
    input(title: string, password: boolean): Promise<string | undefined>;
    /** Modal warning with a single action; true when that action was picked. */
    confirm(message: string, action: string): Promise<boolean>;
    /** Non-modal error notification. */
    error(message: string): void;
}

export interface OpenedSSHConnection {
    connection: SSHConnection;
    /** Close the connection, every jump connection under it and the ProxyCommand. */
    dispose(): void;
}

/**
 * Open and authenticate the connection described by `plan`, through its
 * `ProxyJump` hops or `ProxyCommand` when it has them.
 */
export async function openSSHConnection(plan: ConnectPlan, ui: ConnectionUI, logger: Logger): Promise<OpenedSSHConnection> {
    const proxyConnections: SSHConnection[] = [];
    let proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;
    let connection: SSHConnection | undefined;

    const dispose = () => {
        // If there's proxy connections then just close the parent connection
        if (proxyConnections.length) {
            proxyConnections[0].close();
        } else {
            connection?.close();
        }
        proxyCommandProcess?.kill();
    };

    try {
        let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;

        // Create proxy jump connections if any
        for (let i = 0; i < plan.jumps.length; i++) {
            const hop = plan.jumps[i];
            const proxyConnection = await createConnection(plan, hop, proxyStream, ui, logger);
            proxyConnections.push(proxyConnection);

            const next = plan.jumps[i + 1] ?? plan.target;
            proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, next.hostName, next.port);
        }

        if (!plan.jumps.length && plan.proxyCommand) {
            const { command, args, options } = plan.proxyCommand;
            logger.trace(`Spawning ProxyCommand: ${[command, ...args].join(' ')}`);

            const child = cp.spawn(command, args, options);
            proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
            proxyCommandProcess = child;
        }

        connection = await createConnection(plan, plan.target, proxyStream, ui, logger);
        await connection.connect();
    } catch (e) {
        dispose();
        throw e;
    }

    return { connection, dispose };
}

async function createConnection(plan: ConnectPlan, hop: HopPlan, sock: ssh2.ClientChannel | stream.Duplex | undefined, ui: ConnectionUI, logger: Logger): Promise<SSHConnection> {
    const identityKeys = await gatherIdentityFiles(hop.identityFiles, plan.agentSock, hop.identitiesOnly, logger);
    const agent = hop.agentForward && plan.agentSock ? new ssh2.OpenSSHAgent(plan.agentSock) : undefined;
    const authHandler = getSSHAuthHandler(hop.user, hop.hostName, identityKeys, plan.preferredAuthentications, plan.agentSock, ui, logger);

    return new SSHConnection({
        host: !sock ? hop.hostName : undefined,
        port: !sock ? hop.port : undefined,
        sock,
        username: hop.user,
        readyTimeout: plan.connectTimeout * 1000,
        keepaliveInterval: plan.keepaliveInterval,
        strictVendor: false,
        agentForward: hop.agentForward,
        agent,
        hostVerifier: createHostVerifier(hop.hostName, hop.port, hop.knownHosts, plan.verifyUnknownHosts, plan.verifyKnownHosts, ui, logger),
        authHandler: (arg0, arg1, arg2) => (authHandler(arg0, arg1, arg2), undefined),
    });
}

// @types/ssh2 predates the current runtime and types the key as a string;
// without `hostHash` set, ssh2 actually passes the raw key blob and
// supports an async verify callback.
function createHostVerifier(hostname: string, port: number, hostConfig: KnownHostsFilesConfig, unknownPolicy: HostVerificationPolicy, knownPolicy: HostVerificationPolicy, ui: ConnectionUI, logger: Logger) {
    return ((rawKey: Buffer, verify: (valid: boolean) => void) => {
        checkHostKey(hostname, port, rawKey, hostConfig, unknownPolicy, knownPolicy, ui, logger)
            .then(verify, e => {
                logger.error(`Error verifying host key for ${hostname}`, e);
                verify(false);
            });
    }) as unknown as ssh2.ConnectConfig['hostVerifier'];
}

// Note: the 'ask' prompts run inside ssh2's handshake, which is bounded by
// readyTimeout. An answer given after the timeout still records the key,
// and the retry then connects against the just-approved entry.
async function checkHostKey(hostname: string, port: number, rawKey: Buffer, hostConfig: KnownHostsFilesConfig, unknownPolicy: HostVerificationPolicy, knownPolicy: HostVerificationPolicy, ui: ConnectionUI, logger: Logger): Promise<boolean> {
    const keyType = keyTypeOf(rawKey);
    const keyBase64 = rawKey.toString('base64');
    const fingerprint = keyFingerprint(rawKey);
    const alias = hostConfig['HostKeyAlias'];

    const knownHosts = await loadKnownHosts(hostConfig, logger);
    const verdict = matchHostKey(knownHosts.entries, hostname, port, keyType, keyBase64, alias);

    switch (verdict.status) {
        case 'match':
            logger.trace(`Host key for ${hostname} matches ${verdict.entry.file}:${verdict.entry.line + 1} (${keyType} ${fingerprint})`);
            return true;
        case 'revoked':
            // Marked @revoked in known_hosts: refused unconditionally, no
            // setting overrides this — same as OpenSSH
            logger.error(`Host key for ${hostname} is REVOKED by ${verdict.entry.file}:${verdict.entry.line + 1} (${keyType} ${fingerprint})`);
            return false;
        case 'unknown': {
            // A read failure means recorded keys may be missing, so
            // 'unknown' cannot be trusted: never auto-accept it
            const trustStoreIncomplete = knownHosts.readFailures.length > 0;

            if (unknownPolicy === 'accept' && !trustStoreIncomplete) {
                await rememberHostKey(knownHosts.userFile, hostname, port, keyType, keyBase64, alias, logger);
                return true;
            }
            if (unknownPolicy === 'reject') {
                logger.error(`Rejecting unknown ${keyType} host key for ${hostname} (${fingerprint}) — remote.SSH.verifyUnknownHosts is 'reject'`);
                return false;
            }

            const readFailureNote = trustStoreIncomplete
                ? `\n\nNote: ${knownHosts.readFailures.join(', ')} could not be read, so this host may in fact be recorded there.`
                : '';
            const connect = await ui.confirm(
                `"${hostname}" has an unknown ${keyType} host key.\n\nFingerprint:\n${fingerprint}\n\n${knownHosts.userFile ? 'Connect and remember this key?' : 'Connect? UserKnownHostsFile is \'none\', so this key will not be remembered.'}${readFailureNote}`,
                'Connect'
            );
            if (connect) {
                // Don't persist while the trust store is unreadable: the
                // key may already be recorded in the unreadable file, and
                // appending a duplicate would mask the actual problem
                if (!trustStoreIncomplete) {
                    await rememberHostKey(knownHosts.userFile, hostname, port, keyType, keyBase64, alias, logger);
                }
                return true;
            }
            logger.info(`Connection to ${hostname} cancelled at the host key prompt`);
            return false;
        }
        case 'mismatch': {
            const recordedFingerprint = keyFingerprint(Buffer.from(verdict.entry.keyBase64, 'base64'));
            logger.error(`Host key for ${hostname} does not match the one recorded in ${verdict.entry.file}:${verdict.entry.line + 1}! Recorded ${recordedFingerprint}, received ${fingerprint}`);

            if (knownPolicy === 'accept') {
                return true;
            }
            if (knownPolicy === 'reject') {
                return false;
            }

            const update = await ui.confirm(
                `WARNING: the ${keyType} host key for "${hostname}" has changed!\n\nRecorded fingerprint:\n${recordedFingerprint}\n\nReceived fingerprint:\n${fingerprint}\n\nThis can mean the server was reinstalled — or that the connection is being intercepted.`,
                'Update and Connect'
            );
            if (!update) {
                return false;
            }

            const surviving = await updateHostKey(knownHosts, hostname, port, keyType, keyBase64, alias, logger);
            if (surviving.length) {
                // The old key still verifies, so approving would leave the
                // host trusting both keys — exactly what the warning is
                // about. Refuse and say which line has to go.
                const where = surviving.map(e => `${e.file}:${e.line + 1}`).join(', ');
                logger.error(`Refusing to connect to ${hostname}: the previous key is still recorded in ${where}`);
                ui.error(`"${hostname}" still has a conflicting ${keyType} host key recorded in ${where}. Remove it (ssh-keygen -R) and connect again.`);
                return false;
            }
            return true;
        }
    }
}

/**
 * Records the new key and clears every entry that still pins an older one:
 * a single-host line is rewritten in place, a line naming several hosts
 * loses just this host. Returns the entries that couldn't be cleared —
 * wildcard lines and files the user doesn't own — which the caller must
 * treat as the old key still being trusted.
 */
async function updateHostKey(knownHosts: KnownHosts, hostname: string, port: number, keyType: string, keyBase64: string, alias: string | undefined, logger: Logger): Promise<KnownHostsEntry[]> {
    const conflicts = findConflictingEntries(knownHosts.entries, hostname, port, keyType, keyBase64, alias);
    const surviving: KnownHostsEntry[] = [];
    let replacedInPlace = false;

    // Descending line order: deleting a line shifts the ones after it
    const ordered = [...conflicts].sort((a, b) => a.file === b.file ? b.line - a.line : a.file.localeCompare(b.file));

    for (const entry of ordered) {
        if (!knownHosts.userFiles.includes(entry.file)) {
            surviving.push(entry);
            continue;
        }
        try {
            if (!replacedInPlace && await replaceHostKey(entry, hostname, port, keyBase64, alias)) {
                replacedInPlace = true;
            } else if (!await removeHostFromEntry(entry, hostname, port, alias)) {
                surviving.push(entry);
            }
        } catch (e) {
            logger.error(`Couldn't update ${entry.file}`, e);
            surviving.push(entry);
        }
    }

    if (!replacedInPlace && !surviving.length) {
        await rememberHostKey(knownHosts.userFile, hostname, port, keyType, keyBase64, alias, logger);
    }

    return surviving;
}

// Failing to write the file shouldn't block the connection
async function rememberHostKey(file: string | undefined, hostname: string, port: number, keyType: string, keyBase64: string, alias: string | undefined, logger: Logger): Promise<void> {
    if (!file) {
        logger.info(`Not recording the ${keyType} host key for ${hostname}: UserKnownHostsFile is 'none'`);
        return;
    }
    logger.info(`Adding ${keyType} host key for ${hostname} to ${file}`);
    try {
        await appendHostKey(file, hostname, port, keyType, keyBase64, alias);
    } catch (e) {
        logger.error(`Couldn't add the host key for ${hostname} to ${file}`, e);
    }
}

function getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[], sshAgentSock: string | undefined, ui: ConnectionUI, logger: Logger) {
    let passwordRetryCount = PASSWORD_RETRY_COUNT;
    let keyboardRetryCount = PASSWORD_RETRY_COUNT;
    identityKeys = identityKeys.slice();
    return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
        if (methodsLeft === null) {
            logger.info(`Trying no-auth authentication`);

            return callback({
                type: 'none',
                username: sshUser,
            });
        }
        if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
            const identityKey = identityKeys.shift()!;

            if (identityKey.parsedKey) {
                logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

                if (identityKey.agentSupport) {
                    const { parsedKey } = identityKey;

                    return callback({
                        type: 'agent',
                        username: sshUser,
                        agent: new class extends ssh2.OpenSSHAgent {
                            // Only return the current key
                            override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                callback(undefined, [parsedKey]);
                            }
                        }(sshAgentSock!)
                    });
                }
                if (identityKey.isPrivate) {
                    return callback({
                        type: 'publickey',
                        username: sshUser,
                        key: identityKey.parsedKey
                    });
                }
            }

            if (!await fileExists(identityKey.filename)) {
                // Try next identity file
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return callback(null as any);
            }

            const keyBuffer = await fs.promises.readFile(identityKey.filename);
            let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
            if (result instanceof Error && result.message.includes('but no passphrase given')) {
                let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                while (result instanceof Error && passphraseRetryCount > 0) {
                    const passphrase = await ui.input(`Enter passphrase for ${identityKey.filename}`, true);
                    if (!passphrase) {
                        break;
                    }
                    result = ssh2.utils.parseKey(keyBuffer, passphrase);
                    passphraseRetryCount--;
                }
            }
            if (!result || result instanceof Error) {
                // Try next identity file
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return callback(null as any);
            }

            const key = Array.isArray(result) ? result[0] : result;
            return callback({
                type: 'publickey',
                username: sshUser,
                key
            });
        }
        if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
            if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                logger.info(`Trying password authentication`);
            }

            const password = await ui.input(`Enter password for ${sshUser}@${sshHostName}`, true);
            passwordRetryCount--;

            return callback(password
                ? {
                    type: 'password',
                    username: sshUser,
                    password
                }
                : false);
        }
        if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
            if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                logger.info(`Trying keyboard-interactive authentication`);
            }

            return callback({
                type: 'keyboard-interactive',
                username: sshUser,
                prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                    const responses: string[] = [];
                    for (const prompt of prompts) {
                        const response = await ui.input(`(${sshUser}@${sshHostName}) ${prompt.prompt}`, !prompt.echo);
                        if (response === undefined) {
                            keyboardRetryCount = 0;
                            break;
                        }
                        responses.push(response);
                    }
                    keyboardRetryCount--;
                    finish(responses);
                }
            });
        }

        callback(false);
    };
}

/**
 * Open the channel that keeps the forwarded agent socket alive and read its
 * path. Resolves with `undefined` when the remote reports no usable path.
 */
export function openAgentForwardSession(connection: { execChannel(cmd: string): Promise<SSHExecChannel> }, logger: Logger): Promise<{ channel: SSHExecChannel; sock: string | undefined }> {
    // No pty here on purpose: a pty echoes back whatever is written to the
    // channel before the remote shell executes it, which would otherwise be
    // mistaken for the command's actual output. `exec cat` keeps the process
    // (and therefore the channel's agent-forwarding socket) alive indefinitely
    // after printing the socket path once.
    return connection.execChannel('echo "$SSH_AUTH_SOCK"; exec cat').then(channel => {
        return new Promise(resolve => {
            let buffer = '';
            let resolved = false;

            const finish = (value: string | undefined) => {
                if (!resolved) {
                    resolved = true;
                    channel.removeListener('data', onData);
                    channel.removeListener('close', onClose);
                    clearTimeout(timer);
                    resolve({ channel, sock: value });
                }
            };

            const onData = (data: Buffer) => {
                buffer += data.toString();
                const newlineIdx = buffer.indexOf('\n');
                if (newlineIdx < 0) {
                    return;
                }
                // A forwarded SSH_AUTH_SOCK is always an absolute path. Anything else
                // (e.g. a non-POSIX remote echoing the command back verbatim) is rejected
                // rather than exported as a bogus value.
                const value = buffer.slice(0, newlineIdx).trim();
                finish(value.startsWith('/') ? value : undefined);
            };

            // On a non-POSIX remote the `echo`d line ends the command and the channel
            // closes without a usable path; resolve now instead of waiting for the timeout.
            const onClose = () => finish(undefined);

            const timer = setTimeout(() => {
                logger.trace('Timed out waiting for remote SSH_AUTH_SOCK');
                finish(undefined);
            }, 5000);

            channel.on('data', onData);
            channel.on('close', onClose);
        });
    });
}
