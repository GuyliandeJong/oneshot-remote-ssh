import type * as net from 'net';
import type { ClientChannel } from 'ssh2';
import type { Logger } from '../common/logger';
import { openAgentForwardSession, type ConnectionUI, type ConnectPlan } from '../ssh/connect';
import type SSHConnection from '../ssh/sshConnection';
import type { SSHExecChannel } from '../ssh/sshClient';
import { RpcPeer } from './rpc';
import { PROTOCOL_VERSION, type HolderSession } from './shared';

/** How long a new holder waits for its first window before giving up. */
const STARTUP_TIMEOUT = 30 * 1000;
/** A server probe that takes longer than this means the SSH connection is gone. */
const PROBE_TIMEOUT = 10 * 1000;

export type HeldSSHConnection = Pick<SSHConnection, 'exec' | 'execChannel' | 'forwardOut' | 'forwardOutStreamLocal' | 'addTunnel' | 'on'>;

export interface HeldConnection {
    connection: HeldSSHConnection;
    dispose(): void;
}

export type Connector = (plan: ConnectPlan, ui: ConnectionUI, logger: Logger) => Promise<HeldConnection>;

export interface ConnectResult {
    /** True when the connection already existed, i.e. no new SSH login happened. */
    reused: boolean;
    agentSock?: string;
}

export interface HolderOptions {
    token: string;
    connector: Connector;
    logger: Logger;
    /** Called once, after everything is closed. */
    onExit: (reason: string) => void;
    startupTimeout?: number;
    probeTimeout?: number;
}

type LogLevel = 'trace' | 'info' | 'error';

/**
 * Owns one authenticated SSH connection on behalf of every window attached
 * to it, so that reloading a window, switching its folder or opening a second
 * window to the same host reuses the connection instead of logging in again.
 *
 * Shuts down when the SSH connection drops, or when no window has been
 * attached for the idle timeout the windows asked for.
 */
export class ConnectionHolder {
    private readonly clients = new Set<RpcPeer>();
    private held: HeldConnection | undefined;
    private connecting: Promise<ConnectResult> | undefined;
    private agentChannel: SSHExecChannel | undefined;
    private agentSock: string | undefined;
    private session: HolderSession | undefined;
    private idleTimeout = 600;
    private idleTimer: NodeJS.Timeout | undefined;
    private exited = false;

    readonly logger: Logger;

    constructor(private readonly options: HolderOptions) {
        const log = (level: LogLevel) => (message: string, data?: unknown) => {
            options.logger[level](message, data);
            for (const client of this.clients) {
                client.notify('log', { level, message, data: data === undefined ? undefined : String(data instanceof Error ? data.stack ?? data.message : data) });
            }
        };
        this.logger = { trace: log('trace'), info: log('info'), error: log('error') };
        this.idleTimer = setTimeout(() => this.shutdown('no window attached after startup'), options.startupTimeout ?? STARTUP_TIMEOUT);
    }

    attach(socket: net.Socket) {
        if (this.exited) {
            socket.destroy();
            return;
        }

        const peer = new RpcPeer(socket);
        let authenticated = false;

        peer.setHandler(async (op, params) => {
            if (!authenticated) {
                if (op !== 'hello') {
                    throw new Error('Expected hello');
                }
                const hello = params as { token: string; protocol: number; idleTimeout: number };
                if (hello.token !== this.options.token || hello.protocol !== PROTOCOL_VERSION) {
                    setImmediate(() => peer.close());
                    throw new Error('Rejected');
                }
                authenticated = true;
                this.clients.add(peer);
                this.idleTimeout = hello.idleTimeout;
                this.clearIdleTimer();
                return { pid: process.pid };
            }
            return this.handle(peer, op, params);
        });

        peer.on('close', () => {
            if (this.clients.delete(peer) && !this.clients.size && !this.exited) {
                this.logger.info(`No window attached; closing the connection in ${this.idleTimeout}s unless one attaches`);
                this.idleTimer = setTimeout(() => this.shutdown('idle timeout'), this.idleTimeout * 1000);
            }
        });
    }

    shutdown(reason: string) {
        if (this.exited) {
            return;
        }
        this.exited = true;
        this.clearIdleTimer();
        this.logger.info(`Shutting down: ${reason}`);

        this.agentChannel?.close();
        this.held?.dispose();
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this.options.onExit(reason);
    }

    private clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private async handle(peer: RpcPeer, op: string, params: unknown): Promise<unknown> {
        switch (op) {
            case 'connect':
                return this.connect(peer, (params as { plan: ConnectPlan }).plan);
            case 'session':
                return this.getSession((params as { setupKey: string }).setupKey);
            case 'setSession':
                this.session = (params as { session: HolderSession }).session;
                return null;
            case 'exec':
                return this.connection().exec((params as { cmd: string }).cmd);
            case 'execPartial':
                return this.execPartial(peer, params as { cmd: string; xid: number });
            case 'tunnel':
                return this.openTunnel((params as { remote: number | string }).remote);
            case 'shutdown':
                setImmediate(() => this.shutdown('requested by a window'));
                return null;
            default:
                throw new Error(`Unknown operation: ${op}`);
        }
    }

    private connection(): HeldSSHConnection {
        if (!this.held) {
            throw new Error('Not connected');
        }
        return this.held.connection;
    }

    private connect(peer: RpcPeer, plan: ConnectPlan): Promise<ConnectResult> {
        if (this.held) {
            this.logger.info('Reusing the existing SSH connection');
            return Promise.resolve({ reused: true, agentSock: this.agentSock });
        }
        if (this.connecting) {
            // Another window is logging in right now; share its result
            return this.connecting.then(result => ({ ...result, reused: true }));
        }

        const ui: ConnectionUI = {
            input: (title, password) => peer.request<string | undefined>('prompt', { kind: 'input', title, password }).catch(() => undefined),
            confirm: (message, action) => peer.request<boolean>('prompt', { kind: 'confirm', message, action }).catch(() => false),
            error: message => peer.notify('error', { message }),
        };

        this.connecting = (async () => {
            const held = await this.options.connector(plan, ui, this.logger);
            this.held = held;
            held.connection.on('ssh:disconnect', () => this.shutdown('the SSH connection closed'));

            if (plan.target.agentForward) {
                // Agent forwarding is best-effort: a failure here must not prevent connecting.
                try {
                    const { channel, sock } = await openAgentForwardSession(held.connection, this.logger);
                    this.agentChannel = channel;
                    this.agentSock = sock;
                } catch (e) {
                    this.logger.error(`Failed to setup agent forwarding`, e);
                }
            }

            return { reused: false, agentSock: this.agentSock };
        })();

        return this.connecting.finally(() => {
            this.connecting = undefined;
        });
    }

    /**
     * The session set up earlier, provided it was set up for the same client
     * build and settings and the server still accepts connections.
     */
    private async getSession(setupKey: string): Promise<HolderSession | null> {
        const session = this.session;
        if (!session || session.setupKey !== setupKey) {
            return null;
        }

        try {
            await this.probe(session.listeningOn);
            return session;
        } catch (e) {
            if (e instanceof ProbeTimeoutError) {
                // The SSH connection no longer answers; let the window start over
                this.shutdown('the SSH connection stopped responding');
                throw e;
            }
            this.logger.info(`The remote server no longer accepts connections (${e instanceof Error ? e.message : e}); it has to be started again`);
            this.session = undefined;
            return null;
        }
    }

    /**
     * Open and close a forwarded channel to the server. Forwarded channels
     * don't start a session on the remote, so this costs no login (and no
     * `ForceCommand` run, e.g. no MFA prompt).
     */
    private probe(remote: number | string): Promise<void> {
        const connection = this.connection();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new ProbeTimeoutError()), this.options.probeTimeout ?? PROBE_TIMEOUT);
            const channel = typeof remote === 'number'
                ? connection.forwardOut('127.0.0.1', 0, '127.0.0.1', remote)
                : connection.forwardOutStreamLocal(remote);
            channel.then(stream => {
                clearTimeout(timer);
                stream.destroy();
                resolve();
            }, err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    private async openTunnel(remote: number | string): Promise<{ localPort: number }> {
        const tunnel = await this.connection().addTunnel({
            name: `holder_tunnel_${remote}`,
            remoteAddr: '127.0.0.1',
            remotePort: typeof remote === 'number' ? remote : undefined,
            remoteSocketPath: typeof remote === 'string' ? remote : undefined,
            localPort: 0,
        });
        this.logger.trace(`Tunnel ${tunnel.localPort}(local) => ${remote}(remote)`);
        return { localPort: tunnel.localPort! };
    }

    /**
     * Run a command whose end the window decides: output is streamed to it as
     * `execData` events tagged with the window's `xid`, and it sends
     * `execDone` once it has seen enough.
     */
    private async execPartial(peer: RpcPeer, { cmd, xid }: { cmd: string; xid: number }): Promise<null> {
        const channel = await this.connection().execChannel(cmd) as unknown as ClientChannel;

        const onDone = (op: string, params: unknown) => {
            if (op === 'execDone' && (params as { xid: number }).xid === xid) {
                channel.close();
            }
        };
        peer.on('event', onDone);

        channel.on('data', (data: Buffer) => peer.notify('execData', { xid, stdout: data.toString() }));
        channel.stderr.on('data', (data: Buffer) => peer.notify('execData', { xid, stderr: data.toString() }));
        channel.on('close', () => {
            peer.removeListener('event', onDone);
            peer.notify('execClose', { xid });
        });

        return null;
    }
}

class ProbeTimeoutError extends Error {
    constructor() {
        super('Timed out waiting for the SSH connection');
    }
}
