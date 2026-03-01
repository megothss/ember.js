import {
  AbstractStrictTestCase,
  assertHTML,
  buildOwner,
  clickElement,
  defComponent,
  moduleFor,
  runDestroy,
} from 'internal-test-helpers';

import { ErrorBoundary } from '@ember/component';
import { on } from '@glimmer/runtime';
import { tracked } from '@glimmer/tracking';
import GlimmerishComponent from '../../utils/glimmerish-component';

import { run } from '@ember/runloop';
import { associateDestroyableChild, registerDestructor } from '@glimmer/destroyable';
import { renderComponent, type RenderResult } from '../../../lib/renderer';
import type Owner from '@ember/owner';

// --- Test helper components ---

const Throwing = defComponent('{{this.boom}}', {
  component: class extends GlimmerishComponent {
    get boom(): never {
      throw new Error('render error');
    }
  },
});

const MaybeThrow = defComponent('{{this.value}}', {
  component: class extends GlimmerishComponent {
    get value() {
      if ((this as any).args.shouldThrow) {
        throw new Error('conditional error');
      }
      return 'ok';
    }
  },
});

// --- Test case base class ---

class ErrorBoundaryTestCase extends AbstractStrictTestCase {
  declare component: (RenderResult & { rerender: () => void }) | undefined;
  owner: Owner;

  constructor(assert: QUnit['assert']) {
    super(assert);
    this.owner = buildOwner({});
    associateDestroyableChild(this, this.owner);
  }

  get element() {
    return document.querySelector('#qunit-fixture')!;
  }

  assertChange({ change, expect }: { change: () => void; expect: string }) {
    run(() => change());
    assertHTML(expect);
    this.assertStableRerender();
  }

  renderComponent(
    component: object,
    options: { args?: Record<string, unknown>; expect: string }
  ) {
    let { owner } = this;

    run(() => {
      const result = renderComponent(component, {
        owner,
        args: options.args ?? {},
        env: { document: document, isInteractive: true, hasDOM: true },
        into: this.element,
      });
      this.component = {
        ...result,
        rerender() {
          // unused, but asserted against
        },
      };
      registerDestructor(this, () => result.destroy());
    });

    assertHTML(options.expect);
    this.assertStableRerender();
  }
}

// --- Tests ---

moduleFor(
  'ErrorBoundary',
  class extends ErrorBoundaryTestCase {
    afterEach() {
      if (this.component) {
        runDestroy(this);
      }
    }

    '@test renders default block when no error'() {
      let Root = defComponent(
        '<ErrorBoundary><:default>hello</:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary } }
      );

      this.renderComponent(Root, { expect: 'hello' });
    }

    '@test catches error during initial render and shows error block'() {
      let Root = defComponent(
        '<ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: 'caught' });
    }

    '@test passes error object to error block'() {
      let Root = defComponent(
        '<ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error during rerender'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });
    }

    '@test retry re-renders default content after error is fixed'() {
      class State {
        @tracked shouldThrow = true;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|><button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state, on } }
      );

      this.renderComponent(Root, { expect: '<button>Retry</button>' });

      state.shouldThrow = false;

      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test nested boundaries — inner catches, outer unaffected'() {
      let Root = defComponent(
        '<ErrorBoundary><:default>outer ok <ErrorBoundary><:default><Throwing /></:default><:error as |err|>inner caught</:error></ErrorBoundary></:default><:error as |err|>outer caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: 'outer ok inner caught' });
    }

    '@test renders nothing when no error block provided'() {
      let Root = defComponent('<ErrorBoundary><Throwing /></ErrorBoundary>', {
        scope: { ErrorBoundary, Throwing },
      });

      this.renderComponent(Root, { expect: '<!---->' });
    }
  }
);
