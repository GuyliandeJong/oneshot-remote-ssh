import { EventEmitter } from 'events';
import type * as net from 'net';

/** Refuse a single message larger than this, so a broken peer can't exhaust memory. */
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

type Message =
    | { t: 'req'; id: number; op: string; p?: unknown }
    | { t: 'res'; id: number; r?: unknown }
    | { t: 'err'; id: number; m: string }
    | { t: 'evt'; op: string; p?: unknown };

export type RequestHandler = (op: string, params: unknown) => Promise<unknown>;

/**
 * A symmetric request/response channel over a socket, framed as one JSON
 * object per line. Both ends can issue requests: the extension asks the
 * holder to connect or run commands, and the holder asks the extension to
 * show prompts while it authenticates.
 *
 * Emits `event` (op, params) for notifications and `close` once.
 */
export class RpcPeer extends EventEmitter {
    private nextId = 1;
    private buffer = '';
    private closed = false;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

    constructor(private readonly socket: net.Socket, private handler: RequestHandler = () => Promise.reject(new Error('No handler'))) {
        super();
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('error', () => this.onClose());
        socket.on('close', () => this.onClose());
    }

    get isClosed() {
        return this.closed;
    }

    setHandler(handler: RequestHandler) {
        this.handler = handler;
    }

    request<T>(op: string, params?: unknown): Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error('Connection to the SSH connection holder is closed'));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            this.send({ t: 'req', id, op, p: params });
        });
    }

    notify(op: string, params?: unknown) {
        if (!this.closed) {
            this.send({ t: 'evt', op, p: params });
        }
    }

    close() {
        this.socket.end();
        this.onClose();
    }

    private send(message: Message) {
        this.socket.write(JSON.stringify(message) + '\n');
    }

    private onData(chunk: string) {
        this.buffer += chunk;
        if (this.buffer.length > MAX_MESSAGE_LENGTH && !this.buffer.includes('\n')) {
            this.socket.destroy();
            return;
        }

        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line) {
                this.onMessage(line);
            }
        }
    }

    private onMessage(line: string) {
        let message: Message;
        try {
            message = JSON.parse(line);
        } catch {
            this.socket.destroy();
            return;
        }

        switch (message.t) {
            case 'req':
                this.handler(message.op, message.p).then(
                    r => !this.closed && this.send({ t: 'res', id: message.id, r }),
                    e => !this.closed && this.send({ t: 'err', id: message.id, m: e instanceof Error ? e.message : String(e) })
                );
                break;
            case 'res':
            case 'err': {
                const pending = this.pending.get(message.id);
                if (pending) {
                    this.pending.delete(message.id);
                    if (message.t === 'res') {
                        pending.resolve(message.r);
                    } else {
                        pending.reject(new Error(message.m));
                    }
                }
                break;
            }
            case 'evt':
                this.emit('event', message.op, message.p);
                break;
        }
    }

    private onClose() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const { reject } of this.pending.values()) {
            reject(new Error('Connection to the SSH connection holder was closed'));
        }
        this.pending.clear();
        this.emit('close');
    }
}
