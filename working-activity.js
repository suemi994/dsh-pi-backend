export function createPiWorkingActivity(ActivityTracker) {
    const listeners = new Set();
    let view = { phase: 'idle', line: '' };
    let timer;

    function publish(next) {
        view = next;
        for (const listener of listeners) listener(view);
    }

    function stop() {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
        if (view.phase !== 'idle' || view.line !== '') publish({ phase: 'idle', line: '' });
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            listener(view);
            return () => { listeners.delete(listener); };
        },
        think(turnStartedAt) {
            if (timer !== undefined) return;
            const tracker = new ActivityTracker({ phrases: true });
            tracker.onEvent({ kind: 'turn-start', at: turnStartedAt });
            tracker.applyLiveState({ firstTokenAt: Date.now() });
            const refresh = () => {
                const next = tracker.render();
                if (next.line !== view.line) publish(next);
            };
            timer = setInterval(refresh, 500);
            timer.unref();
            refresh();
        },
        run(line) {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            if (view.phase === 'waiting' && view.line === line) return;
            publish({ phase: 'waiting', line });
        },
        stop,
    };
}
