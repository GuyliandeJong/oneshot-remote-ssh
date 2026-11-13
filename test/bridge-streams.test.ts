import * as net from 'net';
import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';
import { bridgeStreams } from '../src/ssh/sshConnection';

/** Loopback pair: `client` is the VS Code side, `accepted` is the socket the tunnel server receives. */
async function socketPair(): Promise<{ client: net.Socket; accepted: net.Socket; close: () => void }> {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
    const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
    return { client, accepted: await accepted, close: () => server.close() };
}

describe('bridgeStreams', () => {
    it('survives a client reset (ECONNRESET) and tears down the SSH channel', async () => {
        const { client, accepted, close } = await socketPair();
        const stream = new PassThrough();
        const uncaught: unknown[] = [];
        const onUncaught = (e: unknown) => uncaught.push(e);
        process.on('uncaughtException', onUncaught);

        try {
            bridgeStreams(accepted, stream);
            client.on('error', () => undefined);
            client.resetAndDestroy();

            await new Promise<void>(resolve => stream.once('close', resolve));
            await new Promise(resolve => setImmediate(resolve));

            expect(uncaught).toEqual([]);
            expect(accepted.destroyed).toBe(true);
        } finally {
            process.off('uncaughtException', onUncaught);
            close();
        }
    });

    it('closes the socket when the SSH channel errors', async () => {
        const { client, accepted, close } = await socketPair();
        const stream = new PassThrough();
        client.on('error', () => undefined);

        bridgeStreams(accepted, stream);
        stream.destroy(new Error('channel failed'));

        await new Promise<void>(resolve => accepted.once('close', resolve));
        expect(accepted.destroyed).toBe(true);
        client.destroy();
        close();
    });
});
