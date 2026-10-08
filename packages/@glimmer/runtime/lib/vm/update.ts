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
  RenderAttempt,
  ResettableBlock,
  Scope,
  SimpleComment,
  SimpleNode,
  Tag,
  UpdatingOpcode,
  UpdatingVM as IUpdatingVM,
} from '@glimmer/interfaces';
import type { OpaqueIterationItem, OpaqueIterator } from '@glimmer/reference/lib/iterable';
import type { Reference } from '@glimmer/reference/lib/reference';
import { expect, unwrap } from '@glimmer/debug-util/lib/platform-utils';
import {
  associateDestroyableChild,
  destroy,
  destroyChildren,
  registerDestructor,
} from '@glimmer/destroyable';
import { DESTROYABLE_META_KEY } from '@glimmer/util/lib/destroyable-key';
import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';
import { updateRef, valueForRef } from '@glimmer/reference/lib/reference';
import { logStep } from '@glimmer/util/lib/debug-steps';
import { StackImpl as Stack } from '@glimmer/util/lib/collections';
import { debug } from '@glimmer/validator/lib/debug';
import {
  beginErrorBoundary,
  beginTrackFrame,
  consumeTag,
  endErrorBoundary,
  endTrackFrame,
  getTrackingDepth,
  resetTracking,
  unwindTrackingTo,
} from '@glimmer/validator/lib/tracking';

import type { Closure } from './append';
import type { AppendingBlockList, ResettableBlockImpl } from './element-builder';
import type { TryState } from './try-state';

import { clear, move as moveBounds } from '../bounds';
import { NewTreeBuilder, RemoteBlock } from './element-builder';

export class UpdatingVM implements IUpdatingVM {
  public env: Environment;
  public dom: GlimmerTreeChanges;
  public alwaysRevalidate: boolean;

  private frameStack: Stack<UpdatingVMFrame> = new Stack<UpdatingVMFrame>();

  /** Open `{{#try}}` frames. While there are none, opcodes run unguarded. */
  #boundaryFrames = 0;

  /** Tracking depth when this update started, restored if an error escapes a boundary. */
  #startTrackingDepth = 0;

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

    this.#startTrackingDepth = getTrackingDepth();
    this.try(opcodes, handler);

    try {
      while (!frameStack.isEmpty()) {
        let opcode = this.frame.nextStatement();

        if (opcode === undefined) {
          this.#popFrame(true);
          continue;
        }

        if (this.#boundaryFrames === 0) {
          opcode.evaluate(this);
          continue;
        }

        let trackingDepth = getTrackingDepth();

        try {
          opcode.evaluate(this);
        } catch (error) {
          // Keep what the failed opcode read; the boundary that recovers
          // collects it from the enclosing frames.
          consumeTag(unwindTrackingTo(trackingDepth));
          this.#recover(error);
        }
      }
    } finally {
      // An error nobody caught abandons the remaining frames.
      while (!frameStack.isEmpty()) {
        let { boundary } = this.frame;
        this.frameStack.pop();

        if (boundary) {
          this.#boundaryFrames--;
          endErrorBoundary();
          boundary.exit();
          boundary.didAbandonChildren();
        }
      }
    }
  }

  /**
   * Hands a JavaScript error to the innermost `{{#try}}` rendering its body.
   * A boundary showing its fallback does not catch, and one whose fallback
   * fails while recovering passes the new error outward.
   */
  #recover(error: unknown) {
    let { frameStack } = this;

    while (!frameStack.isEmpty()) {
      let boundary = this.frame.boundary;

      if (boundary?.isProtecting) {
        try {
          boundary.handleCaughtError(error);
          this.#popFrame(false);
          return;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }

      this.#popFrame(false);
    }

    // Nothing caught it. Close the frames the passed boundaries and their
    // children left open, as recovery would have. In DEBUG, `execute` resets
    // tracking itself and needs the open frames to label its log.
    if (!DEBUG) {
      unwindTrackingTo(this.#startTrackingDepth);
    }

    throw error;
  }

  #popFrame(completed: boolean) {
    let frame = this.frame;

    if (frame.boundary) {
      this.#boundaryFrames--;
      endErrorBoundary();
      frame.boundary.exit();

      if (completed) {
        frame.boundary.didCompleteChildren();
      } else {
        frame.boundary.didAbandonChildren();
      }
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
    this.frameStack.push(new UpdatingVMFrame(ops, handler, null));
  }

  /** Pushes the frame for a `{{#try}}`'s children. */
  tryBoundary(boundary: TryBlockOpcode) {
    this.#boundaryFrames++;
    beginErrorBoundary();
    boundary.enter();
    this.frameStack.push(new UpdatingVMFrame(boundary.children, boundary, boundary));
  }

  throw() {
    this.frame.handleException();
    this.#popFrame(false);
  }
}

export interface VMState {
  readonly pc: number;
  readonly scope: Scope;
  readonly dynamicScope: DynamicScope;
  readonly stack: unknown[];
}

export abstract class BlockOpcode implements UpdatingOpcode, Bounds {
  [DESTROYABLE_META_KEY]: object | undefined;

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

    let result = vm.execute((vm) => {
      vm.updateWith(this);
      vm.pushUpdating(children);
    });

    associateDestroyableChild(this, result.drop);
  }
}

/**
 * The boundaries currently rendering, innermost last. Each one, not just the
 * innermost, must be able to remove the remote content rendered under it.
 * `null` is a root render's barrier: an independent root rendered from inside
 * an attempt owns its remote content, so no enclosing boundary may remove it.
 */
const ACTIVE_BOUNDARIES: Nullable<TryBlockOpcode>[] = [];

/** Registers a `{{#in-element}}` block with every boundary rendering it. */
export function trackRemoteBlock(block: Bounds): void {
  if (!(block instanceof RemoteBlock)) {
    return;
  }

  for (let i = ACTIVE_BOUNDARIES.length - 1; i >= 0; i--) {
    let boundary = ACTIVE_BOUNDARIES[i];

    if (!boundary) {
      return;
    }

    boundary.trackRemoteBlock(block);
  }
}

export function beginRootBoundaryBarrier(): void {
  ACTIVE_BOUNDARIES.push(null);
}

export function endRootBoundaryBarrier(): void {
  ACTIVE_BOUNDARIES.splice(ACTIVE_BOUNDARIES.lastIndexOf(null));
}

/**
 * The updating side of a `{{#try}}`. Every attempt, whether the body or the
 * fallback, renders in a sub-VM from the same closure, so a throw unwinds only
 * the attempt. A failed attempt is removed by DOM range between two nodes that
 * lie outside the boundary (`#left` and `#right`), because the attempt's own
 * bounds may never have been initialized.
 */
export class TryBlockOpcode extends TryOpcode {
  override type = 'try-block';

  declare protected bounds: ResettableBlockImpl;

  /** The node before the boundary's content, or `null` at the parent's start. */
  #left: Nullable<SimpleNode> = null;

  /** The node after the boundary's content, or `null` at the parent's end. */
  #right: Nullable<SimpleNode> = null;

  #trackingDepth = 0;
  #renderTreeDepth = 0;

  /** Whether the rendered content is the body, whose errors this boundary catches. */
  #protecting = false;

  /** Lifecycle work queued by the children while they update. */
  #childrenAttempt: Nullable<RenderAttempt> = null;

  /**
   * `{{#in-element}}` blocks rendered under this boundary. Their destructors
   * run later, after a fallback may already render into the same destination,
   * so the boundary removes their content itself when it discards them.
   */
  #remoteBlocks = new Set<RemoteBlock>();

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: ResettableBlockImpl,
    private tryState: TryState
  ) {
    super(state, context, bounds, []);
  }

  get isProtecting(): boolean {
    return this.#protecting;
  }

  /** The first render, inserting before `nextSibling` in the parent. */
  renderInitial(nextSibling: Nullable<SimpleNode>): void {
    this.#right = nextSibling;
    this.#left = nextSibling ? nextSibling.previousSibling : this.bounds.parentElement().lastChild;
    this.#saveDepths();
    this.#render();
    this.tryState.consumeTags();
  }

  override evaluate(vm: UpdatingVM): void {
    // Taken before the children run: they may add content at either edge.
    this.#left = this.bounds.firstNode().previousSibling;
    this.#right = this.bounds.lastNode().nextSibling;
    this.#saveDepths();
    this.tryState.consumeTags();

    if (this.tryState.shouldRetry()) {
      this.#rerender();
      return;
    }

    this.#protecting = !this.tryState.hasError;

    // The children's frame: if one of them throws, `handleCaughtError` turns
    // what they read into the retry tag.
    beginTrackFrame();
    this.#childrenAttempt = this.context.env.beginAttempt();
    vm.tryBoundary(this);
  }

  didCompleteChildren(): void {
    this.context.env.commitAttempt(this.#childrenAttempt);
    consumeTag(endTrackFrame());
  }

  /** The children's frame was unwound before they finished. */
  didAbandonChildren(): void {
    this.context.env.abortAttempt(this.#childrenAttempt);
  }

  /** `hasError` flipped, from `retry()`: render the other branch. */
  override handleException(): void {
    this.didAbandonChildren();
    unwindTrackingTo(this.#trackingDepth);
    this.#rerender();
  }

  /** A child threw while the body was updating. */
  handleCaughtError(error: unknown): void {
    this.didAbandonChildren();
    let failedTag = unwindTrackingTo(this.#trackingDepth);
    this.#abort();
    this.#fail(error, failedTag);
    this.tryState.consumeTags();
  }

  trackRemoteBlock(block: RemoteBlock): void {
    this.#remoteBlocks.add(block);
    registerDestructor(block, () => this.#remoteBlocks.delete(block));
  }

  /** Marks this boundary as rendering, for `trackRemoteBlock`. */
  enter(): void {
    ACTIVE_BOUNDARIES.push(this);
  }

  exit(): void {
    ACTIVE_BOUNDARIES.splice(ACTIVE_BOUNDARIES.lastIndexOf(this), 1);
  }

  #clearRemoteBlocks(): void {
    for (let block of this.#remoteBlocks) {
      block.clearForAbort();
    }

    this.#remoteBlocks.clear();
  }

  #saveDepths(): void {
    this.#trackingDepth = getTrackingDepth();
    this.#renderTreeDepth = this.context.env.debugRenderTree?.getDepth() ?? 0;
  }

  #rerender(): void {
    this.#clearRemoteBlocks();
    destroyChildren(this);
    this.#clear();
    this.bounds.forget();
    this.#render();
    this.tryState.consumeTags();
  }

  /** Renders whichever branch `hasError` selects, falling back if the body throws. */
  #render(): void {
    let depth = getTrackingDepth();

    try {
      this.#attempt();
    } catch (error) {
      let failedTag = unwindTrackingTo(depth);
      this.#abort();

      if (!this.#protecting) {
        // The fallback itself failed: keep what it read for the boundary that
        // catches the error, so that boundary retries when any of it changes.
        consumeTag(failedTag);
        throw error;
      }

      this.#fail(error, failedTag);
    }
  }

  #fail(error: unknown, failedTag: Tag): void {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('An error was caught by {{#try}}:', error);
    }

    this.tryState.setError(error, failedTag);

    let depth = getTrackingDepth();

    try {
      this.#attempt();
    } catch (fallbackError) {
      consumeTag(unwindTrackingTo(depth));
      this.#abort();
      throw fallbackError;
    }
  }

  #attempt(): void {
    let { bounds, context } = this;

    this.#protecting = !this.tryState.hasError;

    let attempt = context.env.beginAttempt();
    let completed = false;

    beginErrorBoundary();
    beginTrackFrame();
    this.enter();

    try {
      let tree = NewTreeBuilder.beginBlock(context.env, bounds, this.#right);
      let vm = this.state.evaluate(tree);
      let children = (this.children = []);

      let result = vm.executeAttempt((vm) => {
        vm.updateWith(this);
        vm.pushUpdating(children);
      });

      associateDestroyableChild(this, result.drop);
      consumeTag(endTrackFrame());
      completed = true;
    } finally {
      this.exit();
      endErrorBoundary();

      if (completed) {
        context.env.commitAttempt(attempt);
      } else {
        context.env.abortAttempt(attempt);
      }
    }
  }

  /** Removes a failed attempt: its destroyables, its DOM and its debug nodes. */
  #abort(): void {
    this.#clearRemoteBlocks();
    destroyChildren(this);
    this.#clear();
    this.context.env.debugRenderTree?.rollbackTo(this.#renderTreeDepth);
    this.bounds.forget();
  }

  #clear(): void {
    let parent = this.bounds.parentElement();
    let right = this.#right;
    let node = this.#left ? this.#left.nextSibling : parent.firstChild;

    while (node !== null && node !== right) {
      let next = node.nextSibling;
      parent.removeChild(node);
      node = next;
    }
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

    vm.execute((vm) => {
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
    readonly boundary: Nullable<TryBlockOpcode>
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
}
