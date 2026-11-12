import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import type { Logger } from '../common/logger';
import { isWindows } from '../common/platform';
import type { ConnectionUI, ConnectPlan } from '../ssh/connect';
import type { SSHClient } from '../ssh/sshClient';
import type { ConnectResult } from './holder';
import { RpcPeer } from './rpc';
import { getHolderPaths, PROTOCOL_VERSION, readHolderState, type HolderPaths, type HolderSession } from './shared';

/** How long to wait for a freshly started holder to accept connections. */
const SPAWN_TIMEOUT = 10 * 1000;
const SPAWN_POLL_INTERVAL = 100;

/** The holder could not be reached or started; connecting in-process is the fallback. */
export class HolderUnavailableError extends Error {
}

export interface AttachOptions {
    dir: string;
    key: string;
    /** The bundled holder entry point (`lib/holder.js`). */
    holderScript: string;
    /** Seconds the holder keeps the connection once no window is attached. */
    idleTimeout: number;
    logger: Logger;
}

/**
 * A window's handle on the background connection holder. Closing it (or the
 * window's extension host going away) detaches the window; the connection
 * stays up for the next one.
 */
export class HolderClient {
    private nextXid = 1;

    /** Use `HolderClient.attach`. */
    constructor(private readonly peer: RpcPeer, readonly paths: HolderPaths, logger: Logger) {
        peer.on('event', (op: string, params: unknown) => {
            if (op === 'log') {
                const { level, message, data } = params as { level: 'trace' | 'info' | 'error'; message: string; data?: string };
                logger[level](`[holder] ${message}`, data);
            }
        });
    }

    /** Attach to the holder for `key`, starting it first if it isn't running. */
    static async attach(options: AttachOptions): Promise<HolderClient> {
        const paths = getHolderPaths(options.dir, options.key);

        const existing = await tryAttach(paths, options);
        if (existing) {
            options.logger.info(`Attached to the background SSH connection holder ${paths.socket}`);
            return existing;
        }

        if (!fs.existsSync(options.holderScript)) {
            throw new HolderUnavailableError(`${options.holderScript} not found`);
        }
        // sun_path holds 104 (macOS) to 108 (Linux) bytes including the terminator
        if (!isWindows && Buffer.byteLength(paths.socket) > 103) {
            throw new HolderUnavailableError(`The socket path ${paths.socket} is too long for a Unix socket`);
        }

        options.logger.info(`Starting a background SSH connection holder (log: ${paths.log})`);
        const child = cp.spawn(process.execPath, [options.holderScript, '--dir', options.dir, '--key', options.key], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.on('error', e => options.logger.error('Could not start the SSH connection holder', e));
        child.unref();

        const deadline = Date.now() + SPAWN_TIMEOUT;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, SPAWN_POLL_INTERVAL));
            const client = await tryAttach(paths, options);
            if (client) {
                return client;
            }
        }

        throw new HolderUnavailableError(`The SSH connection holder did not start; see ${paths.log}`);
    }

    get isClosed() {
        return this.peer.isClosed;
    }

    onClose(listener: () => void) {
        this.peer.once('close', listener);
    }

    /** Open the SSH connection, or reuse the holder's. Prompts while logging in go to `ui`. */
    connect(plan: ConnectPlan, ui: ConnectionUI): Promise<ConnectResult> {
        this.peer.setHandler(async (op, params) => {
            if (op !== 'prompt') {
                throw new Error(`Unknown operation: ${op}`);
            }
            const prompt = params as { kind: 'input'; title: string; password: boolean } | { kind: 'confirm'; message: string; action: string };
            return prompt.kind === 'input' ? ui.input(prompt.title, prompt.password) : ui.confirm(prompt.message, prompt.action);
        });
        const onError = (op: string, params: unknown) => {
            if (op === 'error') {
                ui.error((params as { message: string }).message);
            }
        };
        this.peer.on('event', onError);
        return this.peer.request<ConnectResult>('connect', { plan }).finally(() => this.peer.removeListener('event', onError));
    }

    /** The server set up earlier with the same `setupKey`, if it is still running. */
    getSession(setupKey: string): Promise<HolderSession | null> {
        return this.peer.request('session', { setupKey });
    }

    setSession(session: HolderSession): Promise<void> {
        return this.peer.request('setSession', { session });
    }

    /** A local port forwarding to the remote server, kept by the holder across reloads. */
    async openTunnel(remote: number | string): Promise<number> {
        const { localPort } = await this.peer.request<{ localPort: number }>('tunnel', { remote });
        return localPort;
    }

    shutdown(): Promise<void> {
        return this.peer.request('shutdown');
    }

    close() {
        this.peer.close();
    }

    /** Runs commands on the holder's connection, for the server install step. */
    readonly exec: Pick<SSHClient, 'exec' | 'execPartial'> = {
        exec: (cmd: string, params?: string[]) => {
            return this.peer.request<{ stdout: string; stderr: string }>('exec', { cmd: cmd + (params ? ' ' + params.join(' ') : '') });
        },
        execPartial: (cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: string[]) => {
            const xid = this.nextXid++;
            return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                let stdout = '';
                let stderr = '';
                let settled = false;

                const settle = () => {
                    settled = true;
                    this.peer.removeListener('event', onEvent);
                    this.peer.removeListener('close', onClose);
                    resolve({ stdout, stderr });
                };
                const onEvent = (op: string, data: { xid: number; stdout?: string; stderr?: string }) => {
                    if (settled || data?.xid !== xid) {
                        return;
                    }
                    if (op === 'execData') {
                        stdout += data.stdout ?? '';
                        stderr += data.stderr ?? '';
                        if (tester(stdout, stderr)) {
                            this.peer.notify('execDone', { xid });
                            settle();
                        }
                    } else if (op === 'execClose') {
                        settle();
                    }
                };
                const onClose = () => !settled && reject(new Error('The SSH connection holder went away while running a command'));

                this.peer.on('event', onEvent);
                this.peer.once('close', onClose);
                this.peer.request('execPartial', { cmd: cmd + (params ? ' ' + params.join(' ') : ''), xid }).catch(e => {
                    if (!settled) {
                        settled = true;
                        this.peer.removeListener('event', onEvent);
                        reject(e);
                    }
                });
            });
        },
    };

    /** Ask every holder in `dir` to close its connection. Returns how many were asked. */
    static async shutdownAll(dir: string, logger: Logger): Promise<number> {
        let count = 0;
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
            const key = file.slice(0, -'.json'.length);
            const client = await tryAttach(getHolderPaths(dir, key), { idleTimeout: 0, logger });
            if (client) {
                await client.shutdown().catch(() => undefined);
                client.close();
                count++;
            }
        }
        return count;
    }
}

async function tryAttach(paths: HolderPaths, options: Pick<AttachOptions, 'idleTimeout' | 'logger'>): Promise<HolderClient | undefined> {
    const state = readHolderState(paths.state);
    if (!state?.token || !state.socket || state.protocol !== PROTOCOL_VERSION) {
        return undefined;
    }

    const socket = await new Promise<net.Socket | undefined>(resolve => {
        const s = net.connect(state.socket!);
        s.once('connect', () => {
            s.removeAllListeners('error');
            resolve(s);
        });
        s.once('error', () => resolve(undefined));
    });
    if (!socket) {
        return undefined;
    }

    const peer = new RpcPeer(socket);
    try {
        await peer.request('hello', { token: state.token, protocol: PROTOCOL_VERSION, idleTimeout: options.idleTimeout });
    } catch {
        peer.close();
        return undefined;
    }
    return new HolderClient(peer, paths, options.logger);
}
