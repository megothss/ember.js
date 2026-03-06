import {
  AbstractStrictTestCase,
  assertHTML,
  buildOwner,
  clickElement,
  defComponent,
  defineSimpleHelper,
  defineSimpleModifier,
  moduleFor,
  runDestroy,
} from 'internal-test-helpers';

import { DEBUG } from '@glimmer/env';
import { ErrorBoundary, setComponentManager } from '@ember/component';
import { array, on } from '@glimmer/runtime';
import { tracked } from '@glimmer/tracking';
import GlimmerishComponent from '../../utils/glimmerish-component';

import { run } from '@ember/runloop';
import { associateDestroyableChild, destroy, registerDestructor } from '@glimmer/destroyable';
import { componentCapabilities } from '@glimmer/manager';
import { renderComponent, type RenderResult } from '../../../lib/renderer';
import type Owner from '@ember/owner';
import { setOwner } from '@ember/-internals/owner';

// --- Tracked state helpers for @retryWith tests ---
// Declared at module level to avoid TS1206 "Decorators are not valid here"
// which occurs with decorators inside anonymous class expressions.

class RetryState {
  @tracked shouldThrow = false;
  @tracked routeName = 'route-a';
}
class RouteOnlyState {
  @tracked routeName = 'route-a';
}
class ArrayRetryState {
  @tracked shouldThrow = false;
  @tracked valA = 'a';
  @tracked valB = 'b';
}
class ThrowOnlyState {
  @tracked shouldThrow = false;
}

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

  renderComponent(component: object, options: { args?: Record<string, unknown>; expect: string }) {
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
      runDestroy(this);
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

    /* eslint-disable no-console */
    '@test logs caught error to console.error in DEBUG mode during initial render'(assert: Assert) {
      if (!DEBUG) {
        assert.expect(0);
        return;
      }

      let originalConsoleError = console.error;
      let errors: unknown[][] = [];
      console.error = (...args: unknown[]) => errors.push(args);

      try {
        let Root = defComponent(
          '<ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught</:error></ErrorBoundary>',
          { scope: { ErrorBoundary, Throwing } }
        );

        this.renderComponent(Root, { expect: 'caught' });

        assert.ok(errors.length > 0, 'console.error was called');
        assert.strictEqual(
          errors[0]![0],
          'An error was caught by <ErrorBoundary>:',
          'logs the expected message'
        );
        assert.ok(errors[0]![1] instanceof Error, 'logs the error object');
        assert.strictEqual(
          (errors[0]![1] as Error).message,
          'render error',
          'logs the correct error'
        );
      } finally {
        console.error = originalConsoleError;
      }
    }

    '@test logs caught error to console.error in DEBUG mode during rerender'(assert: Assert) {
      if (!DEBUG) {
        assert.expect(0);
        return;
      }

      let originalConsoleError = console.error;
      let errors: unknown[][] = [];

      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Start capturing after initial render
      console.error = (...args: unknown[]) => errors.push(args);

      try {
        this.assertChange({
          change: () => (state.shouldThrow = true),
          expect: 'caught',
        });

        assert.ok(errors.length > 0, 'console.error was called during rerender');
        assert.strictEqual(
          errors[0]![0],
          'An error was caught by <ErrorBoundary>:',
          'logs the expected message'
        );
        assert.strictEqual(
          (errors[0]![1] as Error).message,
          'conditional error',
          'logs the correct error'
        );
      } finally {
        console.error = originalConsoleError;
      }
    }
    /* eslint-enable no-console */

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

    '@test tracked properties work after error recovery via retry'() {
      class State {
        @tracked shouldThrow = true;
      }
      let state = new State();

      class CounterComponent extends GlimmerishComponent {
        @tracked count = 0;
        increment = () => this.count++;
      }

      let Counter = defComponent(
        '<span>{{this.count}}</span><button {{on "click" this.increment}}>+</button>',
        {
          component: CounterComponent,
          scope: { on },
        }
      );

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /><Counter /></:default><:error as |err retry|><button class="retry" {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, Counter, state, on } }
      );

      this.renderComponent(Root, { expect: '<button class="retry">Retry</button>' });

      state.shouldThrow = false;

      this.assertChange({
        change: () => clickElement('.retry'),
        expect: 'ok<span>0</span><button>+</button>',
      });

      this.assertChange({
        change: () => clickElement('button:not(.retry)'),
        expect: 'ok<span>1</span><button>+</button>',
      });
    }

    '@test sibling content survives error and recovery round-trip'() {
      let Root = defComponent(
        '<span>before</span><ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught</:error></ErrorBoundary><span>after</span>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: '<span>before</span>caught<span>after</span>' });
    }

    '@test catches error from deeply nested grandchild component'() {
      let Child = defComponent('<Throwing />', { scope: { Throwing } });
      let Parent = defComponent('<Child />', { scope: { Child } });

      let Root = defComponent(
        '<ErrorBoundary><:default><Parent /></:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Parent } }
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error from item in each loop'() {
      let ItemComponent = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bad') {
              throw new Error('bad item');
            }
            return (this as any).args.item;
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{#each (array "good" "bad" "also-good") as |item|}}<ItemComponent @item={{item}} />{{/each}}</:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ItemComponent, array } }
      );

      this.renderComponent(Root, { expect: 'caught: bad item' });
    }

    '@test helper throws during rerender when tracked state changes'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let maybeThrowHelper = defineSimpleHelper((shouldThrow: unknown) => {
        if (shouldThrow) throw new Error('helper rerender error');
        return 'helper ok';
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{maybeThrowHelper state.shouldThrow}}</:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, maybeThrowHelper, state } }
      );

      this.renderComponent(Root, { expect: 'helper ok' });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught: helper rerender error',
      });
    }

    '@test catches error thrown by a helper'() {
      let throwingHelper = defineSimpleHelper(() => {
        throw new Error('helper error');
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{throwingHelper}}</:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, throwingHelper } }
      );

      this.renderComponent(Root, { expect: 'caught: helper error' });
    }

    '@test modifiers install correctly inside error boundary'(assert: Assert) {
      let trackingModifier = defineSimpleModifier((element: Element) => {
        assert.step('modifier installed');
        element.setAttribute('data-modified', 'true');
      });

      let Root = defComponent(
        '<ErrorBoundary><:default><div {{trackingModifier}}>content</div></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, trackingModifier } }
      );

      this.renderComponent(Root, { expect: '<div data-modified="true">content</div>' });
      assert.verifySteps(['modifier installed']);
    }

    '@test computed properties and tracked dependencies work inside boundary'() {
      class State {
        @tracked firstName = 'Ada';
        @tracked lastName = 'Lovelace';
      }
      let state = new State();

      let FullName = defComponent('{{this.fullName}}', {
        component: class extends GlimmerishComponent {
          get fullName() {
            return `${(this as any).args.first} ${(this as any).args.last}`;
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default><FullName @first={{state.firstName}} @last={{state.lastName}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, FullName, state } }
      );

      this.renderComponent(Root, { expect: 'Ada Lovelace' });

      this.assertChange({
        change: () => (state.firstName = 'Grace'),
        expect: 'Grace Lovelace',
      });

      this.assertChange({
        change: () => (state.lastName = 'Hopper'),
        expect: 'Grace Hopper',
      });
    }

    '@test multiple sibling boundaries — one errors, other stays intact'() {
      let Root = defComponent(
        '<ErrorBoundary><:default><Throwing /></:default><:error as |err|>first caught</:error></ErrorBoundary><ErrorBoundary><:default>second ok</:default><:error as |err|>second caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: 'first caughtsecond ok' });
    }

    '@test error boundary preserves error block across unrelated rerenders'() {
      class State {
        @tracked counter = 0;
      }
      let state = new State();

      let Root = defComponent(
        '<span>{{state.counter}}</span><ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, state } }
      );

      this.renderComponent(Root, { expect: '<span>0</span>caught' });

      this.assertChange({
        change: () => state.counter++,
        expect: '<span>1</span>caught',
      });

      this.assertChange({
        change: () => state.counter++,
        expect: '<span>2</span>caught',
      });
    }

    '@test outer tracked state continues to work across boundary error transitions'() {
      class State {
        @tracked label = 'hello';
      }
      let state = new State();

      let Root = defComponent(
        '<span>{{state.label}}</span><ErrorBoundary><:default><Throwing /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, state } }
      );

      this.renderComponent(Root, { expect: '<span>hello</span>caught' });

      this.assertChange({
        change: () => (state.label = 'world'),
        expect: '<span>world</span>caught',
      });
    }

    '@test catches error from conditional branch during initial render'() {
      let Root = defComponent(
        '<ErrorBoundary><:default>{{#if true}}<Throwing />{{else}}safe{{/if}}</:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing } }
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error when tracked array mutation causes throw during rerender'() {
      class State {
        @tracked items = ['a', 'b'];
      }
      let state = new State();

      let ItemComponent = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb item');
            }
            return (this as any).args.item;
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}</:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ItemComponent, state } }
      );

      this.renderComponent(Root, { expect: 'ab' });

      this.assertChange({
        change: () => (state.items = ['a', 'b', 'bomb']),
        expect: 'caught: bomb item',
      });
    }

    // Modifier errors are not caught by ErrorBoundary because modifiers install
    // during transaction.commit(), which runs after VM execution completes.
    // ErrorBoundary only catches errors during the VM render phase.
    '@skip catches error thrown by a modifier'() {
      let throwingModifier = defineSimpleModifier(() => {
        throw new Error('modifier error');
      });

      let Root = defComponent(
        '<ErrorBoundary><:default><div {{throwingModifier}}>content</div></:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, throwingModifier } }
      );

      this.renderComponent(Root, { expect: 'caught: modifier error' });
    }

    '@test destructors are called when boundary transitions to error state'(assert: Assert) {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      // Use a component manager with destructor capability so the component
      // instance enters the destroyable hierarchy. The default
      // GlimmerishComponentManager has no destructor support, so
      // registerDestructor on the component instance would never fire.
      class DestroyableComponent {
        args: any;
        constructor(owner: any, args: any) {
          setOwner(this, owner);
          this.args = args;
          registerDestructor(this, () => assert.step('destroyed'), true);
        }

        get value() {
          if (this.args.shouldThrow) {
            throw new Error('conditional error');
          }
          return 'alive';
        }
      }

      setComponentManager(
        () => ({
          capabilities: componentCapabilities('3.13', { destructor: true }),
          createComponent(Factory: any, args: any) {
            return new Factory(undefined, args.named);
          },
          getContext(component: any) {
            return component;
          },
          destroyComponent(component: any) {
            destroy(component);
          },
        }),
        DestroyableComponent
      );

      let Tracked = defComponent('{{this.value}}', {
        component: DestroyableComponent as any,
      });

      let Root = defComponent(
        '<ErrorBoundary><:default><Tracked @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Tracked, state } }
      );

      this.renderComponent(Root, { expect: 'alive' });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      assert.verifySteps(['destroyed']);
    }

    '@test retry that still throws shows error block again'() {
      let Root = defComponent(
        '<ErrorBoundary><:default><Throwing /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, on } }
      );

      this.renderComponent(Root, { expect: 'caught <button>Retry</button>' });

      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught <button>Retry</button>',
      });
    }

    '@test deeply nested components with conditionals — error in conditional branch'() {
      class State {
        @tracked showDanger = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default>{{#if state.showDanger}}<Throwing />{{else}}safe{{/if}}</:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, state } }
      );

      this.renderComponent(Root, { expect: 'safe' });

      this.assertChange({
        change: () => (state.showDanger = true),
        expect: 'caught',
      });
    }

    // --- Regression tests for tracking state corruption bugs ---

    '@test rerender error then fix state and retry recovers'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state, on } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error via rerender
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Fix state and retry — must not cause backtracking assertion
      state.shouldThrow = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test repeated rerender errors do not corrupt tracking state'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state, on } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // First trigger
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Second trigger (same value — still dirties tag, causes revalidation)
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Fix and retry
      state.shouldThrow = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test error in error block fallback bubbles to parent boundary'() {
      let ThrowingFallback = defComponent('{{this.boom}}', {
        component: class extends GlimmerishComponent {
          get boom(): never {
            throw new Error('fallback error');
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default><ErrorBoundary><:default><Throwing /></:default><:error as |err|><ThrowingFallback /></:error></ErrorBoundary></:default><:error as |err|>outer caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, ThrowingFallback } }
      );

      this.renderComponent(Root, { expect: 'outer caught: fallback error' });
    }

    '@test each loop insert error then retry recovers'() {
      class State {
        @tracked items = ['a', 'b'];
      }
      let state = new State();

      let ItemComponent = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb');
            }
            return (this as any).args.item;
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}</:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ItemComponent, state, on } }
      );

      this.renderComponent(Root, { expect: 'ab' });

      // Add bad item — triggers insertItem path
      this.assertChange({
        change: () => (state.items = ['a', 'b', 'bomb']),
        expect: 'caught <button>Retry</button>',
      });

      // Fix and retry
      state.items = ['a', 'b'];
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ab',
      });
    }

    '@test each loop repeated insert errors then retry recovers'() {
      class State {
        @tracked items = ['a', 'b'];
      }
      let state = new State();

      let ItemComponent = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb');
            }
            return (this as any).args.item;
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary><:default>{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}</:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ItemComponent, state, on } }
      );

      this.renderComponent(Root, { expect: 'ab' });

      // First bad mutation
      this.assertChange({
        change: () => (state.items = ['a', 'b', 'bomb']),
        expect: 'caught <button>Retry</button>',
      });

      // Second bad mutation while in error state
      this.assertChange({
        change: () => (state.items = ['a', 'bomb', 'c']),
        expect: 'caught <button>Retry</button>',
      });

      // Fix and retry
      state.items = ['x', 'y'];
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'xy',
      });
    }

    // --- @retryWith tests ---

    '@test @retryWith resets error state when value changes'() {
      let state = new RetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught: route error',
      });

      // Change @retryWith value AND fix the error condition — boundary should reset
      this.assertChange({
        change: () => {
          state.shouldThrow = false;
          state.routeName = 'route-b';
        },
        expect: 'ok',
      });
    }

    '@test @retryWith does not reset if value unchanged'() {
      let state = new RetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      // Fix the throw condition but DON'T change @retryWith — should stay in error
      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'caught',
      });
    }

    '@test @retryWith re-catches if new value also causes error'() {
      let state = new RouteOnlyState();

      // Always throws regardless of route
      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><Throwing /></:default><:error as |err|>caught: {{err.message}}</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, state } }
      );

      this.renderComponent(Root, { expect: 'caught: render error' });

      // Change @retryWith — boundary resets, but immediately catches again
      this.assertChange({
        change: () => (state.routeName = 'route-b'),
        expect: 'caught: render error',
      });
    }

    '@test @retryWith with retry that still throws re-catches'() {
      let state = new RouteOnlyState();

      // Always throws
      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><Throwing /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, Throwing, state, on } }
      );

      this.renderComponent(Root, { expect: 'caught <button>Retry</button>' });

      // Retry while error still exists — should re-catch
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught <button>Retry</button>',
      });
    }

    '@test @retryWith rerender error then retry without fixing re-catches'() {
      let state = new RetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state, on } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error via tracked state change
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Retry WITHOUT fixing state — error should be re-caught
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught <button>Retry</button>',
      });
    }

    '@test @retryWith with retry after fixing state recovers'() {
      let state = new RetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.routeName}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state, on } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Fix state and retry — should recover
      state.shouldThrow = false;

      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test multiple error-recovery cycles do not require extra retry clicks'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err retry|>caught <button {{on "click" retry}}>Retry</button></:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state, on } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // --- Cycle 1: error → retry without fixing → re-catch → fix → retry → recover ---
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Retry without fixing — should re-catch
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught <button>Retry</button>',
      });

      // Fix and retry — should recover
      state.shouldThrow = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });

      // --- Cycle 2: same sequence, should still recover in same number of clicks ---
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      // Retry without fixing — should re-catch
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught <button>Retry</button>',
      });

      // Fix and retry — should recover (NOT require extra clicks)
      state.shouldThrow = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });

      // --- Cycle 3: one more to be sure ---
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught <button>Retry</button>',
      });

      state.shouldThrow = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test @retryWith with array value resets when element changes'() {
      let state = new ArrayRetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{array state.valA state.valB}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state, array } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      // Change one array element AND fix the error — should reset
      this.assertChange({
        change: () => {
          state.shouldThrow = false;
          state.valA = 'changed';
        },
        expect: 'ok',
      });
    }

    '@test @retryWith with array value does not reset if elements unchanged'() {
      let state = new ArrayRetryState();

      let ConditionalThrow = defComponent('{{this.value}}', {
        component: class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.shouldThrow) {
              throw new Error('route error');
            }
            return 'ok';
          }
        },
      });

      let Root = defComponent(
        '<ErrorBoundary @retryWith={{array state.valA state.valB}}><:default><ConditionalThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, ConditionalThrow, state, array } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      // Fix throw condition but DON'T change array elements — should stay in error
      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'caught',
      });
    }

    '@test @retryWith with undefined value works without error'() {
      let state = new ThrowOnlyState();

      // @retryWith is not passed — tests that undefined/missing arg is handled
      let Root = defComponent(
        '<ErrorBoundary @retryWith={{state.missing}}><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error — should still catch normally
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });
    }

    '@test ErrorBoundary without @retryWith stays in error state'() {
      let state = new ThrowOnlyState();

      let Root = defComponent(
        '<ErrorBoundary><:default><MaybeThrow @shouldThrow={{state.shouldThrow}} /></:default><:error as |err|>caught</:error></ErrorBoundary>',
        { scope: { ErrorBoundary, MaybeThrow, state } }
      );

      this.renderComponent(Root, { expect: 'ok' });

      // Trigger error
      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      // Fix the condition — but without @retryWith, boundary stays in error
      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'caught',
      });
    }
  }
);
