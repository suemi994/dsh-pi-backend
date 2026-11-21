// Loaded only by the DSH-owned Pi RPC process.
export const bridgeCommand = 'dsh-pi-rpc-bridge';

export default function (pi) {
    let restore;
    const rememberBranch = (ctx, leaf) => {
        if (ctx.sessionManager.getLeafId() !== leaf) {
            // Pi moves the leaf in memory. Append an invisible entry so a
            // later resume starts at the same leaf, even before another prompt.
            pi.appendEntry('dsh-pi-active-branch');
        }
    };
    pi.registerCommand(bridgeCommand, {
        handler: async (args, ctx) => {
            if (ctx.mode !== 'rpc') return;
            const [action, target] = args.trim().split(' ');
            if (action === 'prepare-restore') {
                restore = { ui: ctx.ui, custom: ctx.ui.custom, leaf: ctx.sessionManager.getLeafId() };
                // Extensions with a plain select fallback can use it in RPC.
                // The RPC custom method normally exists but returns undefined.
                ctx.ui.custom = undefined;
            } else if (action === 'finish-restore' && restore) {
                const { ui, custom, leaf } = restore;
                restore = undefined;
                ui.custom = custom;
                rememberBranch(ctx, leaf);
            } else if (action === 'navigate' && target) {
                const leaf = ctx.sessionManager.getLeafId();
                const result = await ctx.navigateTree(target, { summarize: false });
                if (!result.cancelled) rememberBranch(ctx, leaf);
            }
        },
    });
}
