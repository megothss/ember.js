import { DEBUG } from '@glimmer/env';
import type {
  AppendingBlock,
  Bounds,
  DynamicScope,
  Environment,
  EvaluationContext,
  ExceptionHandler,
  GlimmerTreeChanges,
  Nullable,
  ResettableBlock,
  Scope,
  SimpleComment,
  SimpleNode,
  UpdatingOpcode,
  UpdatingVM as IUpdatingVM,
} from '@glimmer/interfaces';
import type { OpaqueIterationItem, OpaqueIterator, Reference } from '@glimmer/reference';
import { expect, unwrap } from '@glimmer/debug-util';
import { associateDestroyableChild, destroy, destroyChildren } from '@glimmer/destroyable';
import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';
import { updateRef, valueForRef } from '@glimmer/reference';
import { logStep, Stack } from '@glimmer/util';
import { debug, getTrackingDepth, resetTracking, restoreTrackingTo } from '@glimmer/validator';

import type { ErrorBoundaryStateInterface } from '../component/error-boundary';
import type { Closure } from './append';
import type { AppendingBlockList } from './element-builder';

import { clear, move as moveBounds } from '../bounds';
import { NewTreeBuilder } from './element-builder';

export class UpdatingVM implements IUpdatingVM {
  public env: Environment;
  public dom: GlimmerTreeChanges;
  public alwaysRevalidate: boolean;

  private frameStack: Stack<UpdatingVMFrame> = new Stack<UpdatingVMFrame>();

  constructor(env: Environment, { alwaysRevalidate = false }) {
    this.env = env;
    this.dom = env.getDOM();
    this.alwaysRevalidate = alwaysRevalidate;
  }

  execute(opcodes: UpdatingOpcode[], handler: ExceptionHandler) {
    if (DEBUG) {
      let hasErrored = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
        debug.runInTrackingTransaction!(
          () => this._execute(opcodes, handler),
          '- While rendering:'
        );

        // using a boolean here to avoid breaking ergonomics of "pause on uncaught exceptions"
        // which would happen with a `catch` + `throw`
        hasErrored = false;
      } finally {
        if (hasErrored) {
          // eslint-disable-next-line no-console
          console.error(`\n\nError occurred:\n\n${resetTracking()}\n\n`);
        }
      }
    } else {
      this._execute(opcodes, handler);
    }
  }

  private _execute(opcodes: UpdatingOpcode[], handler: ExceptionHandler) {
    let { frameStack } = this;

    this.try(opcodes, handler);

    while (!frameStack.isEmpty()) {
      let opcode = this.frame.nextStatement();

      if (opcode === undefined) {
        frameStack.pop();
        continue;
      }

      // Save tracking frame depth so we can discard stale frames if the
      // opcode throws a JS exception (e.g., a tracked getter throwing).
      let trackingDepth = getTrackingDepth();

      try {
        opcode.evaluate(this);
      } catch (error) {
        // Restore tracking frames to the depth before the failed opcode.
        // Without this, stale frames corrupt the parent's tracking context.
        restoreTrackingTo(trackingDepth);

        // Walk up the frame stack to find an error boundary that can handle
        // JavaScript errors. We skip regular TryOpcode handlers because they
        // would reset their block and re-render, which corrupts parent block
        // references if the re-render also fails.
        let handled = false;

        while (!frameStack.isEmpty()) {
          if (this.frame.handleError(error)) {
            frameStack.pop();
            handled = true;
            break;
          }
          frameStack.pop();
        }

        if (!handled) {
          throw error;
        }
      }
    }
  }

  private get frame() {
    return expect(this.frameStack.current, 'bug: expected a frame');
  }

  goto(index: number) {
    this.frame.goto(index);
  }

  try(ops: UpdatingOpcode[], handler: Nullable<ExceptionHandler>) {
    this.frameStack.push(new UpdatingVMFrame(ops, handler));
  }

  throw() {
    this.frame.handleException();
    this.frameStack.pop();
  }
}

export interface VMState {
  readonly pc: number;
  readonly scope: Scope;
  readonly dynamicScope: DynamicScope;
  readonly stack: unknown[];
}

export abstract class BlockOpcode implements UpdatingOpcode, Bounds {
  public children: UpdatingOpcode[];

  protected readonly bounds: AppendingBlock;

  constructor(
    protected state: Closure,
    protected context: EvaluationContext,
    bounds: AppendingBlock,
    children: UpdatingOpcode[]
  ) {
    this.children = children;
    this.bounds = bounds;
  }

  parentElement() {
    return this.bounds.parentElement();
  }

  firstNode() {
    return this.bounds.firstNode();
  }

  lastNode() {
    return this.bounds.lastNode();
  }

  evaluate(vm: UpdatingVM) {
    vm.try(this.children, null);
  }
}

export class TryOpcode extends BlockOpcode implements ExceptionHandler {
  public type = 'try';

  declare protected bounds: ResettableBlock; // Shadows property on base class

  override evaluate(vm: UpdatingVM) {
    vm.try(this.children, this);
  }

  handleException() {
    let {
      state,
      bounds,
      context: { env },
    } = this;

    destroyChildren(this);

    let tree = NewTreeBuilder.resume(env, bounds);
    let vm = state.evaluate(tree);

    let children = (this.children = []);

    // Use executeGuarded() instead of execute() to prevent resetTracking()
    // from being called if the re-render throws. resetTracking() wipes ALL
    // tracking state (including parent frames), which corrupts the UpdatingVM's
    // tracking context and causes "attempted to close a tracking frame, but one
    // was not open" errors. With executeGuarded(), errors propagate to the
    // UpdatingVM's catch handler, which can route them to an error boundary.
    let result = vm.executeGuarded((vm) => {
      vm.updateWith(this);
      vm.pushUpdating(children);
    });

    associateDestroyableChild(this, result.drop);
  }
}

export class ErrorBoundaryOpcode extends TryOpcode {
  public type = 'error-boundary';

  // Cache DOM references from the last successful render so we can clean up
  // even when the bounds tree is corrupted by a failed inner re-render.
  // We cache the first node, its previous sibling, and the nextSibling AFTER
  // the last node, so that cleanup removes everything from firstNode up to
  // (but not including) nextSibling — including any dynamically inserted nodes
  // like list markers. The previousSibling is needed because inner TryOpcodes
  // may detach lastFirstNode from the DOM via bounds.reset() before the error
  // reaches us.
  private lastFirstNode: SimpleNode | null = null;
  private lastPreviousSibling: SimpleNode | null = null;
  private lastNextSibling: SimpleNode | null = null;
  private lastRenderTreeDepth = 0;
  private lastTrackingDepth = 0;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: ResettableBlock,
    children: UpdatingOpcode[],
    private errorState: ErrorBoundaryStateInterface
  ) {
    super(state, context, bounds, children);
  }

  override evaluate(vm: UpdatingVM) {
    // Snapshot current DOM boundaries before child opcodes run.
    if (LOCAL_DEBUG) {
      expect(
        this.bounds.firstNode(),
        'BUG: ErrorBoundaryOpcode.evaluate() called with uninitialized bounds'
      );
    }
    this.lastFirstNode = this.bounds.firstNode();
    this.lastPreviousSibling = this.lastFirstNode.previousSibling;
    this.lastNextSibling = this.bounds.lastNode().nextSibling;
    this.lastRenderTreeDepth = vm.env.debugRenderTree?.getDepth() ?? 0;
    this.lastTrackingDepth = getTrackingDepth();

    // Always consume hasError so its tag is captured in the EB's tracking
    // frame. Without this, after error recovery the EB's JumpIfNotModified
    // combined tag would lose hasError and never detect future changes.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    this.errorState.hasError;

    // Check @retryWith: consumes the retryWith ref's tag (keeping it in the
    // EB's tracking frame) and, if the value changed while in error state,
    // clears the error and returns true to trigger a re-render.
    if (this.errorState.checkRetryWith()) {
      this.handleException();
      return;
    }

    vm.try(this.children, this);
  }

  override handleException() {
    let {
      bounds,
      context: { env },
    } = this;
    let parent = bounds.parentElement();

    // Restore tracking to the depth captured in evaluate(), BEFORE children
    // ran. When vm.throw() is called (e.g. by an Assert opcode), it
    // short-circuits the children's frame — any tracking frames opened by
    // BeginTrackFrameOpcode will never see their matching EndTrackFrameOpcode.
    // Without this, stale frames (and their DEBUG tracking transactions) leak
    // onto OPEN_TRACK_FRAMES / TRANSACTION_STACK, keeping CONSUMED_TAGS alive
    // and causing spurious backtracking assertions on later mutations.
    restoreTrackingTo(this.lastTrackingDepth);
    // Discard consumed-tag entries from the popped tracking frames. The
    // CONSUMED_TAGS WeakMap can't be selectively pruned, so replace it
    // with a fresh one. Without this, stale entries (e.g. a @tracked
    // property consumed during the failed render) cause backtracking
    // assertions when the property is later mutated outside the render.
    if (DEBUG) {
      debug.resetConsumedTags?.();
    }
    let trackingDepth = this.lastTrackingDepth;

    // Save insertion marker: the sibling just before the boundary's content.
    // After resume() removes old DOM via bounds.reset(), any nodes between
    // this marker and lastNextSibling are partial leftovers from a failed render.
    let insertionMarker = this.lastFirstNode ? this.lastFirstNode.previousSibling : null;

    destroyChildren(this);

    try {
      // Attempt a normal re-render like TryOpcode.handleException(), but use
      // executeGuarded() instead of execute(). In DEBUG mode, execute() calls
      // resetTracking() on error, which wipes out the parent UpdatingVM's
      // tracking transaction (TRANSACTION_STACK / CONSUMED_TAGS), causing
      // spurious backtracking assertions on later tracked property mutations.
      let tree = NewTreeBuilder.resume(env, bounds);
      let vm = this.state.evaluate(tree);
      let children = (this.children = []);
      let result = vm.executeGuarded((vm) => {
        vm.updateWith(this);
        vm.pushUpdating(children);
      });
      associateDestroyableChild(this, result.drop);
    } catch (error) {
      // Restore tracking frames opened by the failed re-render attempt.
      restoreTrackingTo(trackingDepth);

      // Roll back stale debug render tree entries.
      env.debugRenderTree?.rollbackTo(this.lastRenderTreeDepth);

      // Remove partial DOM nodes left by the failed re-render.
      // resume() already removed old content via bounds.reset(), so any nodes
      // between insertionMarker and lastNextSibling are from the failed render.
      let cursor: SimpleNode | null = insertionMarker
        ? insertionMarker.nextSibling
        : parent.firstChild;
      let stop = this.lastNextSibling;
      while (cursor && cursor !== stop) {
        let next: SimpleNode | null = cursor.nextSibling;
        parent.removeChild(cursor);
        cursor = next;
      }

      bounds.resetPartial();

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('An error was caught by <ErrorBoundary>:', error);
      }
      this.errorState.setError(error);

      let retryTree = NewTreeBuilder.beginBlock(env, bounds, this.lastNextSibling);
      let retryVM = this.state.evaluate(retryTree);
      let children = (this.children = []);
      let result = retryVM.executeGuarded((vm) => {
        vm.updateWith(this);
        vm.pushUpdating(children);
      });
      associateDestroyableChild(this, result.drop);

      this.lastFirstNode = null;
      this.lastPreviousSibling = null;
      this.lastNextSibling = null;
    }
  }

  /**
   * Handle a JavaScript error that escaped during updating evaluation.
   * Called directly by the UpdatingVM when a JS exception occurs,
   * skipping inner TryOpcode handlers that would corrupt block state.
   */
  handleError(error: unknown) {
    // Restore tracking to the depth from evaluate(), before children ran.
    // _execute's catch only restores to the depth of the failing opcode,
    // which doesn't cover tracking frames opened by earlier opcodes
    // (like BeginTrackFrameOpcode) in the children's frame.
    restoreTrackingTo(this.lastTrackingDepth);
    if (DEBUG) {
      debug.resetConsumedTags?.();
    }
    this.transitionToError(error);
  }

  private transitionToError(error: unknown) {
    let {
      bounds,
      context: { env },
    } = this;

    destroyChildren(this);

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('An error was caught by <ErrorBoundary>:', error);
    }
    this.errorState.setError(error);

    // Clean up DOM manually rather than using bounds.reset() (via resume()),
    // because the bounds tree may be corrupted: inner TryOpcodes or
    // ListBlockOpcodes can leave child blocks with null first/last pointers,
    // and list sync may have inserted temporary marker nodes outside the
    // bounds tree. Walking the DOM directly using cached node references
    // handles both cases.
    let parent = bounds.parentElement();

    if (this.lastFirstNode) {
      // Determine cleanup start: if lastFirstNode is still in the DOM, start
      // there. If it was detached (by an inner TryOpcode's bounds.reset()),
      // use the cached previousSibling to find the current start point.
      let current: SimpleNode | null;
      if (this.lastFirstNode.parentNode === parent) {
        current = this.lastFirstNode;
      } else if (this.lastPreviousSibling) {
        current = this.lastPreviousSibling.nextSibling;
      } else {
        current = parent.firstChild;
      }
      let stop = this.lastNextSibling;

      while (current && current !== stop) {
        let next: SimpleNode | null = current.nextSibling;
        parent.removeChild(current);
        current = next;
      }
    }

    // Roll back the debug render tree stack to discard stale entries left by
    // DebugRenderTreeUpdateOpcodes that pushed but never got their matching
    // DebugRenderTreeDidRenderOpcode pop due to the error.
    env.debugRenderTree?.rollbackTo(this.lastRenderTreeDepth);

    bounds.resetPartial();
    let tree = NewTreeBuilder.beginBlock(env, bounds, this.lastNextSibling);

    let vm = this.state.evaluate(tree);

    let children = (this.children = []);

    let result = vm.executeGuarded((vm) => {
      vm.updateWith(this);
      vm.pushUpdating(children);
    });

    associateDestroyableChild(this, result.drop);

    // Clear cached DOM references — they pointed at the pre-error content
    // which has been removed. Fresh values are captured in the next evaluate().
    this.lastFirstNode = null;
    this.lastPreviousSibling = null;
    this.lastNextSibling = null;
  }
}

export class ListItemOpcode extends TryOpcode {
  public retained = false;
  public index = -1;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: ResettableBlock,
    public key: unknown,
    public memo: Reference,
    public value: Reference
  ) {
    super(state, context, bounds, []);
  }

  shouldRemove(): boolean {
    return !this.retained;
  }

  reset() {
    this.retained = false;
  }
}

export class ListBlockOpcode extends BlockOpcode {
  public type = 'list-block';
  declare public children: ListItemOpcode[];

  private opcodeMap = new Map<unknown, ListItemOpcode>();
  private marker: SimpleComment | null = null;
  private lastIterator: OpaqueIterator;

  declare protected readonly bounds: AppendingBlockList;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: AppendingBlockList,
    children: ListItemOpcode[],
    private iterableRef: Reference<OpaqueIterator>
  ) {
    super(state, context, bounds, children);
    this.lastIterator = valueForRef(iterableRef);
  }

  initializeChild(opcode: ListItemOpcode) {
    opcode.index = this.children.length - 1;
    this.opcodeMap.set(opcode.key, opcode);
  }

  override evaluate(vm: UpdatingVM) {
    let iterator = valueForRef(this.iterableRef);

    if (this.lastIterator !== iterator) {
      let { bounds } = this;
      let { dom } = vm;

      let marker = (this.marker = dom.createComment(''));
      dom.insertAfter(
        bounds.parentElement(),
        marker,
        expect(bounds.lastNode(), "can't insert after an empty bounds")
      );

      this.sync(iterator);

      this.parentElement().removeChild(marker);
      this.marker = null;
      this.lastIterator = iterator;
    }

    // Run now-updated updating opcodes
    super.evaluate(vm);
  }

  private sync(iterator: OpaqueIterator) {
    let { opcodeMap: itemMap, children } = this;

    let currentOpcodeIndex = 0;
    let seenIndex = 0;

    this.children = this.bounds.boundList = [];

    while (true) {
      let item = iterator.next();

      if (item === null) break;

      let opcode = children[currentOpcodeIndex];
      let { key } = item;

      // Items that have already been found and moved will already be retained,
      // we can continue until we find the next unretained item
      while (opcode !== undefined && opcode.retained) {
        opcode = children[++currentOpcodeIndex];
      }

      if (opcode !== undefined && opcode.key === key) {
        this.retainItem(opcode, item);
        currentOpcodeIndex++;
      } else if (itemMap.has(key)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
        let itemOpcode = itemMap.get(key)!;

        // The item opcode was seen already, so we should move it.
        if (itemOpcode.index < seenIndex) {
          this.moveItem(itemOpcode, item, opcode);
        } else {
          // Update the seen index, we are going to be moving this item around
          // so any other items that come before it will likely need to move as
          // well.
          seenIndex = itemOpcode.index;

          let seenUnretained = false;

          // iterate through all of the opcodes between the current position and
          // the position of the item's opcode, and determine if they are all
          // retained.
          for (let i = currentOpcodeIndex + 1; i < seenIndex; i++) {
            if (!unwrap(children[i]).retained) {
              seenUnretained = true;
              break;
            }
          }

          // If we have seen only retained opcodes between this and the matching
          // opcode, it means that all the opcodes in between have been moved
          // already, and we can safely retain this item's opcode.
          if (!seenUnretained) {
            this.retainItem(itemOpcode, item);
            currentOpcodeIndex = seenIndex + 1;
          } else {
            this.moveItem(itemOpcode, item, opcode);
            currentOpcodeIndex++;
          }
        }
      } else {
        this.insertItem(item, opcode);
      }
    }

    for (const opcode of children) {
      if (!opcode.retained) {
        this.deleteItem(opcode);
      } else {
        opcode.reset();
      }
    }
  }

  private retainItem(opcode: ListItemOpcode, item: OpaqueIterationItem) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['retain', item.key]);
    }

    let { children } = this;

    updateRef(opcode.memo, item.memo);
    updateRef(opcode.value, item.value);
    opcode.retained = true;

    opcode.index = children.length;
    children.push(opcode);
  }

  private insertItem(item: OpaqueIterationItem, before: ListItemOpcode | undefined) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['insert', item.key]);
    }

    let {
      opcodeMap,
      bounds,
      state,
      children,
      context: { env },
    } = this;
    let { key } = item;
    let nextSibling = before === undefined ? this.marker : before.firstNode();

    let elementStack = NewTreeBuilder.forInitialRender(env, {
      element: bounds.parentElement(),
      nextSibling,
    });

    let vm = state.evaluate(elementStack);

    vm.executeGuarded((vm) => {
      let opcode = vm.enterItem(item);

      opcode.index = children.length;
      children.push(opcode);
      opcodeMap.set(key, opcode);
      associateDestroyableChild(this, opcode);
    });
  }

  private moveItem(
    opcode: ListItemOpcode,
    item: OpaqueIterationItem,
    before: ListItemOpcode | undefined
  ) {
    let { children } = this;

    updateRef(opcode.memo, item.memo);
    updateRef(opcode.value, item.value);
    opcode.retained = true;

    let currentSibling, nextSibling;

    if (before === undefined) {
      moveBounds(opcode, this.marker);
    } else {
      currentSibling = opcode.lastNode().nextSibling;
      nextSibling = before.firstNode();

      // Items are moved throughout the algorithm, so there are cases where the
      // the items already happen to be siblings (e.g. an item in between was
      // moved before this move happened). Check to see if they are siblings
      // first before doing the move.
      if (currentSibling !== nextSibling) {
        moveBounds(opcode, nextSibling);
      }
    }

    opcode.index = children.length;
    children.push(opcode);

    if (LOCAL_DEBUG) {
      let type = currentSibling && currentSibling === nextSibling ? 'move-retain' : 'move';
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', [type, item.key]);
    }
  }

  private deleteItem(opcode: ListItemOpcode) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['delete', opcode.key]);
    }

    destroy(opcode);
    clear(opcode);
    this.opcodeMap.delete(opcode.key);
  }
}

class UpdatingVMFrame {
  private current = 0;

  constructor(
    private ops: UpdatingOpcode[],
    private exceptionHandler: Nullable<ExceptionHandler>
  ) {}

  goto(index: number) {
    this.current = index;
  }

  nextStatement(): UpdatingOpcode | undefined {
    return this.ops[this.current++];
  }

  handleException() {
    if (this.exceptionHandler) {
      this.exceptionHandler.handleException();
    }
  }

  /**
   * Try to handle a JavaScript error (not a tracked-value change).
   * Returns true if the handler accepted the error, false otherwise.
   * Only error boundary handlers accept JavaScript errors.
   */
  handleError(error: unknown): boolean {
    if (this.exceptionHandler?.handleError) {
      this.exceptionHandler.handleError(error);
      return true;
    }
    return false;
  }
}
