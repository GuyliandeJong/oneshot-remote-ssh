import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HolderClient } from '../src/holder/client';
import { ConnectionHolder, type Connector, type HeldSSHConnection } from '../src/holder/holder';
import { getHolderPaths, PROTOCOL_VERSION, type HolderSession } from '../src/holder/shared';
import type { ConnectionUI, ConnectPlan } from '../src/ssh/connect';

const logger = { info: vi.fn(), error: vi.fn(), trace: vi.fn() };

const PLAN: ConnectPlan = {
    jumps: [],
    target: { hostName: 'example', port: 22, user: 'me', identityFiles: [], identitiesOnly: false, agentForward: false, knownHosts: {} },
    preferredAuthentications: ['publickey'],
    connectTimeout: 60,
    keepaliveInterval: 0,
    verifyUnknownHosts: 'ask',
    verifyKnownHosts: 'reject',
};

const SESSION: HolderSession = { setupKey: 'setup-a', listeningOn: 44243, connectionToken: 'secret', envVariables: {} };

const ui: ConnectionUI = {
    input: vi.fn(async () => 'passphrase'),
    confirm: vi.fn(async () => true),
    error: vi.fn(),
};

class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    closed = false;
    close() {
        this.closed = true;
        this.emit('close');
    }
}

class FakeConnection extends EventEmitter {
    probe: 'ok' | 'refused' | 'hang' = 'ok';
    channel = new FakeChannel();

    exec = vi.fn(async (cmd: string) => ({ stdout: `ran ${cmd}`, stderr: '' }));
    execChannel = vi.fn(async () => this.channel);
    addTunnel = vi.fn(async (config: object) => ({ ...config, localPort: 4242, server: {} }));
    forwardOut = vi.fn(() => this.probeResult());
    forwardOutStreamLocal = vi.fn(() => this.probeResult());

    private probeResult() {
        if (this.probe === 'hang') {
            return new Promise<never>(() => undefined);
        }
        return this.probe === 'ok' ? Promise.resolve({ destroy: vi.fn() }) : Promise.reject(new Error('Connection refused'));
    }
}

let dir: string;
let key = 0;
let holder: ConnectionHolder;
let connection: FakeConnection;
let connector: ReturnType<typeof vi.fn<Connector>>;
let server: net.Server;
let exitReason: string | undefined;
const clients: HolderClient[] = [];

async function startHolder(token = 'token') {
    const paths = getHolderPaths(dir, String(++key));
    connection = new FakeConnection();
    connector = vi.fn<Connector>(async (_plan, connectUI) => {
        await connectUI.input('Enter passphrase for id_rsa', true);
        return { connection: connection as unknown as HeldSSHConnection, dispose: vi.fn() };
    });
    exitReason = undefined;
    holder = new ConnectionHolder({ token, connector, logger, onExit: reason => exitReason = reason, probeTimeout: 50 });
    server = net.createServer(socket => holder.attach(socket));
    await new Promise<void>(resolve => server.listen(paths.socket, resolve));
    fs.writeFileSync(paths.state, JSON.stringify({ pid: process.pid, protocol: PROTOCOL_VERSION, token, socket: paths.socket }));
    return String(key);
}

async function attach(holderKey: string, idleTimeout = 60) {
    const client = await HolderClient.attach({ dir, key: holderKey, holderScript: '/nonexistent/holder.js', idleTimeout, logger });
    clients.push(client);
    return client;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-test-'));
});

afterEach(async () => {
    clients.splice(0).forEach(c => c.close());
    holder.shutdown('test done');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
});

describe.skipIf(process.platform === 'win32')('ConnectionHolder', () => {
    it('logs in once and lets a later window reuse the connection and server', async () => {
        const holderKey = await startHolder();

        const first = await attach(holderKey);
        await expect(first.connect(PLAN, ui)).resolves.toEqual({ reused: false });
        expect(ui.input).toHaveBeenCalledWith('Enter passphrase for id_rsa', true);
        await expect(first.getSession('setup-a')).resolves.toBeNull();
        await first.setSession(SESSION);
        await expect(first.openTunnel(44243)).resolves.toBe(4242);

        // The window reloads: its extension host goes away, a new one attaches
        first.close();
        const second = await attach(holderKey);
        await expect(second.connect(PLAN, ui)).resolves.toEqual({ reused: true });
        await expect(second.getSession('setup-a')).resolves.toEqual(SESSION);

        expect(connector).toHaveBeenCalledTimes(1);
        expect(ui.input).toHaveBeenCalledTimes(1);
        expect(connection.exec).not.toHaveBeenCalled();
        expect(connection.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '127.0.0.1', 44243);
    });

    it('shares one login between windows connecting at the same time', async () => {
        const holderKey = await startHolder();
        const [a, b] = await Promise.all([attach(holderKey), attach(holderKey)]);

        const results = await Promise.all([a.connect(PLAN, ui), b.connect(PLAN, ui)]);

        expect(connector).toHaveBeenCalledTimes(1);
        expect(results.map(r => r.reused).sort()).toEqual([false, true]);
    });

    it('does not reuse a server set up for another client build or settings', async () => {
        const client = await attach(await startHolder());
        await client.connect(PLAN, ui);
        await client.setSession(SESSION);

        await expect(client.getSession('setup-b')).resolves.toBeNull();
    });

    it('forgets the server once it stops accepting connections', async () => {
        const client = await attach(await startHolder());
        await client.connect(PLAN, ui);
        await client.setSession(SESSION);

        connection.probe = 'refused';
        await expect(client.getSession('setup-a')).resolves.toBeNull();
        connection.probe = 'ok';
        await expect(client.getSession('setup-a')).resolves.toBeNull();
    });

    it('shuts down when the SSH connection stops responding', async () => {
        const client = await attach(await startHolder());
        await client.connect(PLAN, ui);
        await client.setSession(SESSION);

        connection.probe = 'hang';
        await expect(client.getSession('setup-a')).rejects.toThrow();
        expect(exitReason).toBe('the SSH connection stopped responding');
    });

    it('shuts down when the SSH connection closes', async () => {
        const client = await attach(await startHolder());
        await client.connect(PLAN, ui);

        connection.emit('ssh:disconnect');
        expect(exitReason).toBe('the SSH connection closed');
    });

    it('closes the connection once no window has been attached for the idle timeout', async () => {
        const client = await attach(await startHolder(), 0.05);
        await client.connect(PLAN, ui);

        client.close();
        await vi.waitFor(() => expect(exitReason).toBe('idle timeout'));
    });

    it('keeps the connection when a window attaches within the idle timeout', async () => {
        const holderKey = await startHolder();
        const client = await attach(holderKey, 0.2);
        await client.connect(PLAN, ui);

        client.close();
        await attach(holderKey, 0.2);
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(exitReason).toBeUndefined();
    });

    it('rejects a window that does not know the token', async () => {
        const holderKey = await startHolder();
        const paths = getHolderPaths(dir, holderKey);
        fs.writeFileSync(paths.state, JSON.stringify({ pid: process.pid, protocol: PROTOCOL_VERSION, token: 'wrong', socket: paths.socket }));

        await expect(attach(holderKey)).rejects.toThrow('/nonexistent/holder.js not found');
    });

    it('runs commands on the held connection, ending them when the window has seen enough', async () => {
        const client = await attach(await startHolder());
        await client.connect(PLAN, ui);

        await expect(client.exec.exec('uname -s')).resolves.toEqual({ stdout: 'ran uname -s', stderr: '' });

        const partial = client.exec.execPartial('install.ps1', stdout => stdout.includes('end'));
        await vi.waitFor(() => expect(connection.execChannel).toHaveBeenCalled());
        connection.channel.emit('data', Buffer.from('start\n'));
        connection.channel.emit('data', Buffer.from('end\n'));

        await expect(partial).resolves.toEqual({ stdout: 'start\nend\n', stderr: '' });
        await vi.waitFor(() => expect(connection.channel.closed).toBe(true));
    });
});
