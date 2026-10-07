import type { SimpleElement, SimpleNode } from '@simple-dom/interface';

import type { Bounds } from '../dom/bounds.js';
import type { Arguments, CapturedArguments } from './arguments.js';

export type RenderNodeType =
  | 'outlet'
  | 'engine'
  | 'route-template'
  | 'component'
  | 'modifier'
  | 'keyword';

export interface RenderNode {
  type: RenderNodeType;
  name: string;
  args: CapturedArguments;
  instance: unknown;
}

export interface CapturedRenderNode {
  id: string;
  type: RenderNodeType;
  name: string;
  args: Arguments;
  instance: unknown;
  bounds: null | {
    parentElement: SimpleElement;
    firstNode: SimpleNode;
    lastNode: SimpleNode;
  };
  children: CapturedRenderNode[];
}

export interface DebugRenderTree<Bucket extends object = object> {
  begin(): void;

  create(state: Bucket, node: RenderNode): void;

  update(state: Bucket): void;

  didRender(state: Bucket, bounds: Bounds): void;

  willDestroy(state: Bucket): void;

  commit(): void;

  capture(): CapturedRenderNode[];

  /** Return the current depth of the internal stack (for error boundary rollback). */
  getDepth(): number;

  /** Pop entries from the internal stack down to the given depth (for error boundary rollback). */
  rollbackTo(depth: number): void;
}
