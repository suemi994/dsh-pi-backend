import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dshInjectSocketPath(sessionId, dataDir = join(homedir(), '.dsh-tui', 'inject')) {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\dsh-tui-inject-${sessionId}`;
    }
    return join(dataDir, `${sessionId}.sock`);
}

export function createPiPromptInjector({
    sessionId,
    dataDir,
    timeoutMs = 2000,
    onError,
    connectSocket = connect,
}) {
    const socketPath = dshInjectSocketPath(sessionId, dataDir);
    return text => {
        if (typeof text !== 'string' || text === '') return Promise.resolve(false);
        return new Promise(resolve => {
            let socket;
            let settled = false;
            const finish = (ok, error) => {
                if (settled) return;
                settled = true;
                socket?.destroy();
                if (!ok && error) onError?.(`Pi editor prefill failed: ${error}`);
                resolve(ok);
            };
            try {
                socket = connectSocket(socketPath);
            } catch (error) {
                finish(false, error);
                return;
            }
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => {
                socket.end(`${JSON.stringify({ type: 'prompt.append', text })}\n`, () => finish(true));
            });
            socket.once('timeout', () => finish(false, 'dsh-tui input channel timed out'));
            socket.once('error', error => finish(false, error));
            socket.once('close', () => finish(false, 'dsh-tui input channel closed before prefill completed'));
        });
    };
}
