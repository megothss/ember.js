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
import { expect, unreachable, unwrap } from '@glimmer/debug-util';
import { associateDestroyableChild, destroy, destroyChildren } from '@glimmer/destroyable';
import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';
import { updateRef, valueForRef } from '@glimmer/reference';
import { logStep, Stack } from '@glimmer/util';
import { debug, getTrackingDepth, resetTracking, restoreTrackingTo } from '@glimmer/validator';

import type { SimpleElement } from '@simple-dom/interface';

import type { ErrorBoundaryState } from '../component/error-boundary';
import type { Closure } from './append';
import type { AppendingBlockList } from './element-builder';

import { clear, move as moveBounds } from '../bounds';
import { NewTreeBuilder } from './element-builder';

export class UpdatingVM implements IUpdatingVM {
  public env: Environment;
  public dom: GlimmerTreeChanges;
  public alwaysRevalidate: boolean;

  private frameStack: Stack<UpdatingVMFrame> = new Stack<UpdatingVMFrame>();
  private _errorBoundaryDepth = 0;

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
        this._popFrame();
        continue;
      }

      if (this._errorBoundaryDepth > 0) {
        // Only pay the try-catch cost when inside an error boundary.
        let trackingDepth = getTrackingDepth();

        try {
          opcode.evaluate(this);
        } catch (error) {
          // Restore tracking frames to the depth before the failed opcode.
          restoreTrackingTo(trackingDepth);

          // Walk up the frame stack to find an error boundary that can handle
          // JavaScript errors.
          let handled = false;

          while (!frameStack.isEmpty()) {
            if (this.frame.handleCaughtError(error)) {
              this._popFrame();
              handled = true;
              break;
            }
            this._popFrame();
          }

          if (!handled) {
            throw error;
          }
        }
      } else {
        opcode.evaluate(this);
      }
    }
  }

  private _popFrame() {
    let frame = this.frameStack.current;
    if (frame && frame.isErrorBoundary) {
      this._errorBoundaryDepth--;
    }
    this.frameStack.pop();
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

  tryErrorBoundary(ops: UpdatingOpcode[], handler: ExceptionHandler) {
    this._errorBoundaryDepth++;
    this.frameStack.push(new UpdatingVMFrame(ops, handler, true));
  }

  throw() {
    this.frame.handleException();
    this._popFrame();
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

  handleCaughtError(_error: unknown) {
    unreachable('handleCaughtError called on TryOpcode');
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

/**
 * Remove all DOM nodes from `from` up to (but not including) `to`.
 * If `to` is null, removes all remaining siblings after `from`.
 */
export function clearDOMRange(
  parent: SimpleElement,
  from: SimpleNode | null,
  to: SimpleNode | null
): void {
  let current = from;
  while (current && current !== to) {
    let next: SimpleNode | null = current.nextSibling;
    parent.removeChild(current);
    current = next;
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
  // may detach cachedFirstNode from the DOM via bounds.reset() before the error
  // reaches us.
  private cachedFirstNode: SimpleNode | null = null;
  private cachedPreviousSibling: SimpleNode | null = null;
  private cachedNextSibling: SimpleNode | null = null;
  private cachedRenderTreeDepth = 0;
  private cachedTrackingDepth = 0;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: ResettableBlock,
    children: UpdatingOpcode[],
    private errorState: ErrorBoundaryState
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
    this.cachedFirstNode = this.bounds.firstNode();
    this.cachedPreviousSibling = this.cachedFirstNode.previousSibling;
    this.cachedNextSibling = this.bounds.lastNode().nextSibling;
    this.cachedRenderTreeDepth = vm.env.debugRenderTree?.getDepth() ?? 0;
    this.cachedTrackingDepth = getTrackingDepth();

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

    vm.tryErrorBoundary(this.children, this);
  }

  /**
   * Restore tracking frames and consumed tags to the state captured in
   * evaluate(), before children ran. This prevents stale tracking frames
   * (opened by BeginTrackFrameOpcode but never closed) from leaking into
   * OPEN_TRACK_FRAMES / TRANSACTION_STACK, which would cause spurious
   * backtracking assertions on later mutations.
   */
  private restoreTracking() {
    restoreTrackingTo(this.cachedTrackingDepth);
    if (DEBUG) {
      debug.resetConsumedTags?.();
    }
  }

  /**
   * Resolve the start node for DOM cleanup. Handles the case where
   * cachedFirstNode may have been detached by an inner TryOpcode's
   * bounds.reset(), falling back to the cached previousSibling or
   * the parent's firstChild.
   */
  private resolveCachedStart(parent: SimpleElement): SimpleNode | null {
    if (this.cachedFirstNode && this.cachedFirstNode.parentNode === parent) {
      return this.cachedFirstNode;
    } else if (this.cachedPreviousSibling) {
      return this.cachedPreviousSibling.nextSibling;
    } else {
      return parent.firstChild;
    }
  }

  /**
   * Re-render the boundary's template into its block. Used by both the
   * happy-path re-render (handleException) and error-state transitions
   * (handleCaughtError). Assumes the block has already been cleaned up
   * (destroyChildren + DOM cleared + resetPartial).
   */
  private renderIntoBlock(): void {
    let {
      bounds,
      context: { env },
    } = this;
    let tree = NewTreeBuilder.beginBlock(env, bounds, this.cachedNextSibling);
    let vm = this.state.evaluate(tree);
    let children = (this.children = []);
    let result = vm.executeGuarded((vm) => {
      vm.updateWith(this);
      vm.pushUpdating(children);
    });
    associateDestroyableChild(this, result.drop);
  }

  /**
   * Null out cached DOM references after an error transition. The cached
   * nodes pointed at pre-error content which has been removed; fresh
   * values are captured in the next evaluate().
   */
  private clearCachedNodes(): void {
    this.cachedFirstNode = null;
    this.cachedPreviousSibling = null;
    this.cachedNextSibling = null;
  }

  override handleException() {
    let {
      bounds,
      context: { env },
    } = this;
    let parent = bounds.parentElement();

    this.restoreTracking();
    let trackingDepth = this.cachedTrackingDepth;

    destroyChildren(this);

    // Clear DOM directly using cached node references instead of
    // NewTreeBuilder.resume() (which walks the bounds delegation chain).
    // The delegation chain — block.firstNode() → child.firstNode() → ... —
    // can become stale when inner TryOpcodes or ListBlockOpcodes modify
    // their blocks during the same update cycle, leading to crashes or
    // incomplete DOM cleanup. Using concrete cached references avoids this.
    if (this.cachedFirstNode) {
      clearDOMRange(parent, this.resolveCachedStart(parent), this.cachedNextSibling);
    }

    // Reset block state without DOM cleanup (already done above).
    bounds.resetPartial();

    try {
      this.renderIntoBlock();
    } catch (error) {
      // Restore tracking frames opened by the failed re-render attempt.
      restoreTrackingTo(trackingDepth);

      // Roll back stale debug render tree entries.
      env.debugRenderTree?.rollbackTo(this.cachedRenderTreeDepth);

      // Remove partial DOM nodes left by the failed re-render.
      let start: SimpleNode | null = this.cachedPreviousSibling
        ? this.cachedPreviousSibling.nextSibling
        : parent.firstChild;
      clearDOMRange(parent, start, this.cachedNextSibling);

      bounds.resetPartial();

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('An error was caught by <ErrorBoundary>:', error);
      }
      this.errorState.setError(error);

      this.renderIntoBlock();
      this.clearCachedNodes();
    }
  }

  /**
   * Handle a JavaScript error that escaped during updating evaluation.
   * Called directly by the UpdatingVM when a JS exception occurs,
   * skipping inner TryOpcode handlers that would corrupt block state.
   */
  handleCaughtError(error: unknown) {
    let {
      bounds,
      context: { env },
    } = this;

    this.restoreTracking();

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

    if (this.cachedFirstNode) {
      clearDOMRange(parent, this.resolveCachedStart(parent), this.cachedNextSibling);
    }

    // Roll back the debug render tree stack to discard stale entries left by
    // DebugRenderTreeUpdateOpcodes that pushed but never got their matching
    // DebugRenderTreeDidRenderOpcode pop due to the error.
    env.debugRenderTree?.rollbackTo(this.cachedRenderTreeDepth);

    bounds.resetPartial();
    this.renderIntoBlock();
    this.clearCachedNodes();
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
    private exceptionHandler: Nullable<ExceptionHandler>,
    readonly isErrorBoundary = false
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
  handleCaughtError(error: unknown): boolean {
    if (this.isErrorBoundary && this.exceptionHandler) {
      this.exceptionHandler.handleCaughtError(error);
      return true;
    }
    return false;
  }
}
