import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { isWindows } from '../common/platform';
import { toString } from '../utils/to-string';
import { openSSHConnection } from '../ssh/connect';
import { ConnectionHolder } from './holder';
import { getHolderPaths, isProcessAlive, PROTOCOL_VERSION, readHolderState, type HolderState } from './shared';

// Entry point of the background connection holder: a plain Node process
// (the editor's own runtime with ELECTRON_RUN_AS_NODE) started detached by
// the extension, so it outlives window reloads. See `holder.ts`.

function parseArgs(argv: string[]): { dir: string; key: string } {
    const value = (name: string) => {
        const index = argv.indexOf(name);
        if (index < 0 || !argv[index + 1]) {
            throw new Error(`Missing ${name}`);
        }
        return argv[index + 1];
    };
    return { dir: value('--dir'), key: value('--key') };
}

/**
 * Create the state file exclusively, so only one holder runs per key. A file
 * left by a holder that died is taken over.
 */
function acquireLock(file: string): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(file, 'wx', 0o600);
            fs.writeSync(fd, JSON.stringify({ pid: process.pid } satisfies HolderState));
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw e;
            }
            const owner = readHolderState(file);
            if (owner && isProcessAlive(owner.pid)) {
                return false;
            }
            // An unparsable file may be a holder that just created it and
            // hasn't written its pid yet; only remove one that is stale
            if (!owner && Date.now() - fs.statSync(file).mtimeMs < 5000) {
                return false;
            }
            fs.rmSync(file, { force: true });
        }
    }
    return false;
}

function main() {
    const { dir, key } = parseArgs(process.argv);
    const paths = getHolderPaths(dir, key);

    const logFd = fs.openSync(paths.log, 'w', 0o600);
    const write = (level: string, message: string, data?: unknown) => {
        fs.writeSync(logFd, `[${new Date().toISOString()}] [${level}] ${message}\n${data === undefined ? '' : toString(data) + '\n'}`);
    };
    const fileLogger = {
        trace: (message: string, data?: unknown) => write('Trace', message, data),
        info: (message: string, data?: unknown) => write('Info', message, data),
        error: (message: string, data?: unknown) => write('Error', message, data),
    };

    if (!acquireLock(paths.state)) {
        fileLogger.info('Another holder already serves this connection; exiting');
        process.exit(0);
    }

    const token = crypto.randomBytes(32).toString('hex');
    // `holder` is only used once a window connects, after it's assigned below
    const server = net.createServer(socket => holder.attach(socket));

    const holder = new ConnectionHolder({
        token,
        connector: openSSHConnection,
        logger: fileLogger,
        onExit: () => {
            server.close();
            // Only remove what's still ours
            if (readHolderState(paths.state)?.pid === process.pid) {
                fs.rmSync(paths.state, { force: true });
            }
            if (!isWindows) {
                fs.rmSync(paths.socket, { force: true });
            }
            // Let pending writes (replies, log lines) flush before exiting
            setTimeout(() => process.exit(0), 100);
        },
    });

    process.on('uncaughtException', e => {
        holder.logger.error('Uncaught exception', e);
        holder.shutdown('internal error');
    });
    process.on('unhandledRejection', e => holder.logger.error('Unhandled rejection', e));
    process.on('SIGTERM', () => holder.shutdown('terminated'));
    process.on('SIGINT', () => holder.shutdown('interrupted'));
    // The extension host may have handed us a closed stdio; never die on EPIPE
    process.on('SIGPIPE', () => undefined);

    if (!isWindows) {
        // We hold the lock, so a socket file still there is stale
        fs.rmSync(paths.socket, { force: true });
    }

    server.on('error', e => {
        holder.logger.error('Holder socket error', e);
        holder.shutdown('could not listen');
    });
    server.listen(paths.socket, () => {
        if (!isWindows) {
            fs.chmodSync(paths.socket, 0o600);
        }
        const state: HolderState = { pid: process.pid, protocol: PROTOCOL_VERSION, token, socket: paths.socket };
        fs.writeFileSync(paths.state, JSON.stringify(state), { mode: 0o600 });
        holder.logger.info(`Holder ${process.pid} listening on ${paths.socket}`);
    });
}

main();
