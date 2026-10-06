import type {
  Destroyable,
  DynamicScope,
  Environment,
  InternalComponentCapabilities,
  InternalComponentManager,
  Nullable,
  Owner,
  VMArguments,
  WithCreateInstance,
} from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference/lib/reference';
import type { VMArgumentsImpl } from '@glimmer/runtime/lib/vm/arguments';
import { DEBUG } from '@glimmer/env';
import { assert } from '@ember/debug';
import { setComponentTemplate } from '@glimmer/manager/lib/public/template';
import { setInternalComponentManager } from '@glimmer/manager/lib/internal/api';
import { createConstRef } from '@glimmer/reference/lib/reference';
import { ErrorBoundaryStateImpl } from '@glimmer/runtime/lib/component/error-boundary';

import type { ErrorBoundaryState } from '@glimmer/runtime/lib/component/error-boundary';

import ErrorBoundaryTemplate from '../templates/error-boundary';

const CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  // Only needed for the DEBUG check of which blocks were passed.
  createArgs: true,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  dynamicScope: false,
  updateHook: false,
  createInstance: true,
  wrapped: false,
  willDestroy: false,
  hasSubOwner: false,
  errorBoundary: true,
};

class ErrorBoundaryManager
  implements InternalComponentManager<ErrorBoundaryState>, WithCreateInstance<ErrorBoundaryState>
{
  getCapabilities(): InternalComponentCapabilities {
    return CAPABILITIES;
  }

  create(
    _owner: Owner,
    _definition: object,
    args: Nullable<VMArguments>,
    _env: Environment,
    _dynamicScope: Nullable<DynamicScope>,
    _caller: Nullable<Reference>,
    hasDefaultBlock: boolean
  ): ErrorBoundaryState {
    if (DEBUG) {
      // Checked here rather than in the layout: the layout renders inside the
      // boundary, which would catch the assertion and show the <:catch> block.
      // Implicit content can't be mixed with named blocks, so a default block
      // next to <:try> or <:catch> is always an explicit <:default>.
      let blocks = (args as VMArgumentsImpl | null)?.blocks;
      let hasNamedBlock = blocks !== undefined && (blocks.has('try') || blocks.has('catch'));
      assert(
        '<ErrorBoundary> accepts a <:default> block only on its own. Use <:try> with <:catch>.',
        !(hasDefaultBlock && hasNamedBlock)
      );
    }

    return new ErrorBoundaryStateImpl();
  }

  didCreate(): void {}
  didUpdate(): void {}
  didRenderLayout(): void {}
  didUpdateLayout(): void {}

  getDebugName(): string {
    return 'ErrorBoundary';
  }

  getSelf(instance: ErrorBoundaryState): Reference {
    return createConstRef(instance, 'this');
  }

  getDestroyable(_instance: ErrorBoundaryState): Nullable<Destroyable> {
    return null;
  }
}

const MANAGER = new ErrorBoundaryManager();

const ErrorBoundary = {
  create() {
    throw new Error('ErrorBoundary does not support .create(). It is managed internally.');
  },
};
setInternalComponentManager(MANAGER, ErrorBoundary);
setComponentTemplate(ErrorBoundaryTemplate, ErrorBoundary);

export default ErrorBoundary;
