type ProgressWatcher = (state: ProgressState) => void;

type ProgressOptions = {
  parent?: Progress;
  watchers?: ProgressWatcher[];
  title?: string;
  forkJoin?: boolean;
};

type ProgressState = {
  done: boolean; // true if job is done
  current: number; // the current progress value
  end?: number; // the value of current where we expect to be done
};

/**
 * Utility class for computing the progress of complex tasks.
 *
 * Watchers are invoked with a ProgressState object.
 */
export class Progress {
  public readonly title?: string;
  public readonly startTime = Date.now();
  public readonly taskId: string;

  private parent: Progress | null;
  private allTasks: Progress[] = [];
  private selfState: ProgressState = { current: 0, done: false };
  private state: ProgressState = { current: 0, done: false };
  private isDone = false;
  private watchers: ProgressWatcher[];
  private forkJoin: boolean;

  constructor(options: ProgressOptions = {}) {
    this.parent = options.parent || null;
    this.watchers = options.watchers || [];
    this.forkJoin = !!options.forkJoin;

    if ((this.title = options.title)) {
      // Capitalize job titles when displayed in the progress bar.
      this.title = this.title[0].toUpperCase() + this.title.slice(1);
    }

    // Multi-bar support: generate unique task ID
    this.taskId = Math.random().toString(36).substring(2, 15);
  }

  toString() {
    return "Progress [state=" + JSON.stringify(this.state) + "]";
  }

  reportProgressDone() {
    const state = {
      ...this.selfState,
      done: true,
    };

    if (typeof state.end !== 'undefined') {
      if (state.current > state.end) {
        state.end = state.current;
      }
      state.current = state.end;
    }

    this.reportProgress(state);
  }

  // Tries to determine which is the 'current' job in the tree
  // This is very heuristical... we use some hints, like:
  // don't descend into fork-join jobs; we know these execute concurrently,
  // so we assume the top-level task has the title
  // i.e. "Downloading packages", not "downloading supercool-1.0"
  getCurrentProgress(): Progress | null {
    const isRoot = !this.parent;

    if (this.isDone) {
      // A done task cannot be the active task
      return null;
    }

    if (!this.state.done && (this.state.current !== 0) && this.state.end &&
        !isRoot) {
      // We are not done and we have interesting state to report
      return this;
    }

    if (this.forkJoin) {
      // Don't descend into fork-join tasks (by choice)
      return this;
    }

    if (this.allTasks.length) {
      const active = this.allTasks
        .map(task => task.getCurrentProgress())
        .filter(Boolean);

      if (active.length) {
        // pick one to display, somewhat arbitrarily
        return active[active.length - 1];
      }

      // No single active task, return self
      return this;
    }

    return this;
  }

  // Creates a subtask that must be completed as part of this (bigger) task
  addChildTask(options: ProgressOptions) {
    options = {
      parent: this,
      ...options,
    };
    const child = new Progress(options);
    this.allTasks.push(child);
    this.reportChildState();
    return child;
  }

  // Dumps the tree, for debug
  dump(
    stream: any,
    options?: { skipDone: boolean },
    prefix?: string,
  ) {
    if (options && options.skipDone && this.isDone) {
      return;
    }

    if (prefix) {
      stream.write(prefix);
    }
    const end = this.state.end || '?';
    stream.write("Task [" + this.title + "] " + this.state.current + "/" + end
      + (this.isDone ? " done" : "") +"\n");
    if (this.allTasks.length) {
      this.allTasks.forEach(child => {
        child.dump(stream, options, (prefix || '') + '  ');
      });
    }
  }

  // Receives a state report indicating progress of self
  reportProgress(state: ProgressState) {
    this.selfState = state;

    this.updateTotalState();

    // Nudge the spinner/progress bar, but don't yield (might not be safe to yield)
    // Use eval to avoid TypeScript issues with require in strict mode
    const Console = eval('require("./console.js")').Console;
    Console.nudge();

    this.notifyState();
  }

  // Subscribes a watcher to changes
  addWatcher(watcher: ProgressWatcher) {
    this.watchers.push(watcher);
  }

  // Notifies watchers & parents
  private notifyState() {
    if (this.parent) {
      this.parent.reportChildState();
    }

    if (this.watchers.length) {
      this.watchers.forEach(watcher => {
        watcher(this.state);
      });
    }
  }

  // Recomputes state, incorporating children's states
  private updateTotalState() {
    let allChildrenDone = true;
    const state = { ...this.selfState };
    this.allTasks.forEach(child => {
      const childState = child.state;

      if (!child.isDone) {
        allChildrenDone = false;
      }

      state.current += childState.current;
      if (state.end !== undefined) {
        if (childState.done) {
          state.end += childState.current;
        } else if (childState.end !== undefined) {
          state.end += childState.end;
        } else {
          state.end = undefined;
        }
      }
    });

    this.isDone = allChildrenDone && !!this.selfState.done;
    if (!allChildrenDone) {
      state.done = false;
    }

    // Allow state transitions from done => !done for forkJoin tasks with multi-bar
    // This can happen when new child tasks are added dynamically
    if (!state.done && this.state.done && !this.forkJoin) {
      // This shouldn't happen for non-forkJoin tasks
      throw new Error("Progress transition from done => !done");
    }

    this.state = state;
  }

  // Called by a child when its state changes
  private reportChildState() {
    this.updateTotalState();
    this.notifyState();
  }

  getState() {
    return this.state;
  }

  // Check if this progress task should use multi-bar display
  shouldUseMultiBar(): boolean {
    // Use multi-bar if:
    // 1. This is a fork-join task with multiple children that have progress
    // 2. The children have meaningful titles
    // 3. There are at least 2 children with progress tracking
    if (!this.forkJoin || this.allTasks.length < 2) {
      return false;
    }

    const childrenWithProgress = this.allTasks.filter(task => 
      task.title && 
      (task.state.end !== undefined && task.state.end > 0) &&
      !task.isDone
    );

    // Debug logging
    if (process.env.METEOR_PROGRESS_DEBUG) {
      console.log(`[DEBUG] shouldUseMultiBar: forkJoin=${this.forkJoin}, allTasks=${this.allTasks.length}, childrenWithProgress=${childrenWithProgress.length}`);
      this.allTasks.forEach((task, i) => {
        console.log(`[DEBUG] Task ${i}: title="${task.title}", end=${task.state.end}, isDone=${task.isDone}`);
      });
    }

    return childrenWithProgress.length >= 2;
  }

  // Get children that should be displayed as individual progress bars
  getMultiBarChildren(): Progress[] {
    if (!this.shouldUseMultiBar()) {
      return [];
    }

    return this.allTasks.filter(task => 
      task.title && 
      (task.state.end !== undefined && task.state.end > 0)
    );
  }

  // Enable multi-bar progress tracking for this task's children
  enableMultiBarProgress() {
    if (!this.shouldUseMultiBar()) {
      if (process.env.METEOR_PROGRESS_DEBUG) {
        console.log('[DEBUG] enableMultiBarProgress: shouldUseMultiBar returned false');
      }
      return;
    }

    if (process.env.METEOR_PROGRESS_DEBUG) {
      console.log('[DEBUG] enableMultiBarProgress: Attempting to enable multi-bar progress');
    }

    // Use eval to avoid TypeScript issues with require in strict mode
    try {
      const consoleModule = eval('require("./console.js")');
      const Console = consoleModule.Console;
      Console.nudge();
      
      if (process.env.METEOR_PROGRESS_DEBUG) {
        console.log('[DEBUG] enableMultiBarProgress: Console loaded, _progressDisplay:', !!Console._progressDisplay);
        console.log('[DEBUG] enableMultiBarProgress: Console state - _progressDisplayEnabled:', Console._progressDisplayEnabled, '_pretty:', Console._pretty, '_stream.isTTY:', Console._stream.isTTY);
        console.log('[DEBUG] enableMultiBarProgress: process.stdout.isTTY:', process.stdout.isTTY);
      }
      
      const progressDisplay = Console._progressDisplay;
      if (!progressDisplay || !progressDisplay.addProgressBar) {
        if (process.env.METEOR_PROGRESS_DEBUG) {
          console.log('[DEBUG] enableMultiBarProgress: No progressDisplay or addProgressBar method, display type:', progressDisplay?.constructor?.name);
        }
        return;
      }

      const children = this.getMultiBarChildren();
      
      if (process.env.METEOR_PROGRESS_DEBUG) {
        console.log('[DEBUG] enableMultiBarProgress: Found', children.length, 'children for multi-bar');
      }
      
      // Initialize multi-bar for each child
      children.forEach(child => {
        if (child.title && child.state.end) {
          if (process.env.METEOR_PROGRESS_DEBUG) {
            console.log('[DEBUG] enableMultiBarProgress: Adding progress bar for', child.title);
          }
          
          progressDisplay.addProgressBar(child.taskId, child.title, child.state.end);
          
          // Add watcher to update the progress bar
          child.addWatcher((state) => {
            if (state.end && state.end > 0) {
              progressDisplay.updateProgressBar(
                child.taskId, 
                state.current, 
                state.end, 
                child.title
              );
              
              if (state.done) {
                progressDisplay.completeProgressBar(child.taskId);
              }
            }
          });
        }
      });
    } catch (error) {
      // Fallback to regular progress if there are issues
      if (process.env.METEOR_PROGRESS_DEBUG) {
        console.log('[DEBUG] enableMultiBarProgress error:', error.message);
      }
    }
  }
}
