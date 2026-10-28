// Cleanup registry. The harness creates temporary worktrees, snapshots and patch directories,
// and starts child processes. When it is interrupted (Ctrl-C, a hook timeout, a killed push)
// none of the `finally` blocks run, so everything temporary is also registered here and
// removed from a signal handler. A worktree left behind is not just litter: it stays listed in
// the developer's repository.

const tasks = new Set();
let installed = false;

function runAll() {
  for (const task of [...tasks].reverse()) {
    try {
      task();
    } catch {
      /* best effort: one failed cleanup must not stop the others */
    }
  }
  tasks.clear();
}

function install() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => {
      runAll();
      process.exit(code);
    });
  }
}

/**
 * Register `task` to run if the process is interrupted. Returns a function that runs the task
 * now and unregisters it — call that one on the normal path.
 */
export function registerCleanup(task) {
  install();
  tasks.add(task);
  return () => {
    if (!tasks.delete(task)) return;
    task();
  };
}
