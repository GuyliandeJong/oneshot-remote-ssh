import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWindows } from '../common/platform';
import type { ConnectPlan } from '../ssh/connect';

/** Bumped whenever the messages between extension and holder change. */
export const PROTOCOL_VERSION = 1;

/** What a window needs to attach to the server the holder's connection already set up. */
export interface HolderSession {
    /** Identifies the client build and server settings the server was set up for. */
    setupKey: string;
    listeningOn: number | string;
    connectionToken: string;
    envVariables: Record<string, string>;
}

/** Contents of `<key>.json`, which doubles as the holder's single-instance lock. */
export interface HolderState {
    pid: number;
    protocol?: number;
    token?: string;
    socket?: string;
}

export interface HolderPaths {
    state: string;
    socket: string;
    log: string;
}

/**
 * The per-user directory holding the holders' state files, sockets and logs.
 * Its permissions are the access control: anyone who can reach a socket can
 * use that authenticated connection, as with an OpenSSH ControlMaster socket.
 */
export function getHolderDir(): string {
    if (isWindows) {
        // %TEMP% is under the user's profile, which other users can't read
        const dir = path.join(os.tmpdir(), 'oneshot-remote-ssh');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    const uid = process.getuid!();
    const dir = process.env.XDG_RUNTIME_DIR
        ? path.join(process.env.XDG_RUNTIME_DIR, 'oneshot-remote-ssh')
        : path.join(os.tmpdir(), `oneshot-remote-ssh-${uid}`);

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
        throw new Error(`${dir} is not a directory owned by the current user`);
    }
    if (stat.mode & 0o077) {
        fs.chmodSync(dir, 0o700);
    }

    return dir;
}

/**
 * Identifies the holder for a connection: windows that would open the same
 * connection share a holder, any difference (host, user, keys, proxies,
 * verification policy, extension version) gets its own.
 */
export function getHolderKey(plan: ConnectPlan, extensionVersion: string): string {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ protocol: PROTOCOL_VERSION, extensionVersion, plan }))
        .digest('hex')
        .slice(0, 16);
}

export function getHolderPaths(dir: string, key: string): HolderPaths {
    return {
        state: path.join(dir, `${key}.json`),
        // Named pipes live in their own namespace on Windows. Unix socket
        // paths are capped at ~104 bytes, which a 16 char key keeps clear of.
        socket: isWindows ? `\\\\.\\pipe\\oneshot-remote-ssh-${os.userInfo().username}-${key}` : path.join(dir, `${key}.sock`),
        log: path.join(dir, `${key}.log`),
    };
}

export function readHolderState(file: string): HolderState | undefined {
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof state?.pid === 'number' ? state : undefined;
    } catch {
        return undefined;
    }
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: it exists, it just isn't ours to signal
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
