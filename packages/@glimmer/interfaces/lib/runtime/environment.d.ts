import type { SimpleDocument } from '@simple-dom/interface';

import type {
  ComponentDefinitionState,
  ComponentInstance,
  ComponentInstanceState,
} from '../components.js';
import type { Nullable } from '../core.js';
import type { GlimmerTreeChanges, GlimmerTreeConstruction } from '../dom/changes.js';
import type { WithCreateInstance } from '../managers.js';
import type { ClassicResolver } from '../program.js';
import type { DebugRenderTree } from './debug-render-tree.js';
import type { ModifierInstance } from './modifier.js';
import type { Program } from './runtime.js';

export interface EnvironmentOptions {
  document?: SimpleDocument;
  appendOperations?: GlimmerTreeConstruction;
  updateOperations?: GlimmerTreeChanges;
}

export type Transaction = object;

declare const TransactionSymbol: unique symbol;
export type TransactionSymbol = typeof TransactionSymbol;

export type ComponentInstanceWithCreate = ComponentInstance<
  ComponentDefinitionState,
  ComponentInstanceState,
  WithCreateInstance
>;

/** An opaque handle for one `{{#try}}` attempt's queued lifecycle work. */
export interface RenderAttempt {
  readonly entries: unknown[];
}

export interface Environment {
  [TransactionSymbol]: Nullable<Transaction>;

  didCreate(component: ComponentInstanceWithCreate): void;
  didUpdate(component: ComponentInstanceWithCreate): void;

  scheduleInstallModifier(modifier: ModifierInstance): void;
  scheduleUpdateModifier(modifier: ModifierInstance): void;

  begin(): void;
  commit(): void;

  /**
   * Scopes the lifecycle work queued by one `{{#try}}` attempt, so a failed
   * attempt can drop it. Returns `null` outside a transaction.
   */
  beginAttempt(): Nullable<RenderAttempt>;
  commitAttempt(attempt: Nullable<RenderAttempt>): void;
  abortAttempt(attempt: Nullable<RenderAttempt>): void;

  /** Brackets an independent root render, whose work no enclosing attempt owns. */
  beginRootRender(): void;
  endRootRender(): void;

  getDOM(): GlimmerTreeChanges;
  getAppendOperations(): GlimmerTreeConstruction;

  isInteractive: boolean;
  debugRenderTree?: DebugRenderTree | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isArgumentCaptureError?: ((error: any) => boolean) | undefined;
}

export interface RuntimeOptions {
  readonly env: Environment;
  readonly program: Program;
  readonly resolver: ClassicResolver | null;
}
