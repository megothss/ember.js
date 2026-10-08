import {
  AbstractStrictTestCase,
  assertHTML,
  buildOwner,
  clickElement,
  defineSimpleHelper,
  defineSimpleModifier,
  moduleFor,
  runDestroy,
  runTask,
  RenderingTestCase,
} from 'internal-test-helpers';

import { DEBUG } from '@glimmer/env';
import { precompileTemplate } from '@ember/template-compilation';
import templateOnly from '@ember/component/template-only';
import { setComponentManager } from '@ember/component';
import { array, on, renderComponent as renderGlimmerComponent, renderSync } from '@glimmer/runtime';
import { tracked } from '@glimmer/tracking';
import GlimmerishComponent from '../../utils/glimmerish-component';

import { run } from '@ember/runloop';
import { associateDestroyableChild, destroy, registerDestructor } from '@glimmer/destroyable';
import {
  componentCapabilities,
  modifierCapabilities,
  setModifierManager,
  setComponentTemplate,
} from '@glimmer/manager';
import {
  BaseRenderer,
  renderComponent,
  setRenderer,
  type RenderResult,
} from '../../../lib/renderer';
import type Owner from '@ember/owner';
import { setOwner } from '@ember/-internals/owner';
import type { Arguments, SimpleElement } from '@glimmer/interfaces';
import { getTrackingDepth, isInErrorBoundary } from '@glimmer/validator/lib/tracking';

interface LifecycleCounts {
  created: number;
  installed: number;
  updated: number;
  destroyed: number;
}

/** Observe component creation, deferred lifecycle work, and destruction separately. */
function lifecycleComponent(counts: LifecycleCounts) {
  class Component {
    constructor(public args: Record<string, unknown>) {
      counts.created++;
    }
  }

  setComponentManager(
    () => ({
      capabilities: componentCapabilities('3.13', {
        destructor: true,
        asyncLifecycleCallbacks: true,
        updateHook: true,
      }),
      createComponent(_factory: unknown, args: Arguments) {
        return new Component(args.named);
      },
      getContext(component: Component) {
        return component;
      },
      updateComponent() {},
      didCreateComponent() {
        counts.installed++;
      },
      didUpdateComponent() {
        counts.updated++;
      },
      destroyComponent() {
        counts.destroyed++;
      },
    }),
    Component
  );

  return setComponentTemplate(precompileTemplate('<b>{{@label}}</b>'), Component);
}

/** Count modifier instances even when an attempt aborts before installation. */
function lifecycleModifier(counts: LifecycleCounts) {
  return setModifierManager(
    () => ({
      capabilities: modifierCapabilities('3.22'),
      createModifier() {
        counts.created++;
        return {};
      },
      installModifier() {
        counts.installed++;
      },
      updateModifier() {
        counts.updated++;
      },
      destroyModifier() {
        counts.destroyed++;
      },
    }),
    {}
  );
}

class ThrowOnlyState {
  @tracked shouldThrow = false;
}
class SiblingState {
  @tracked label = 'before';
}
class ConditionalState {
  @tracked show = true;
}
class InnerState {
  @tracked value = 'hello';
}

const Throwing = setComponentTemplate(
  precompileTemplate('{{this.boom}}'),
  class extends GlimmerishComponent {
    get boom(): never {
      throw new Error('render error');
    }
  }
);

const MaybeThrow = setComponentTemplate(
  precompileTemplate('{{this.value}}'),
  class extends GlimmerishComponent {
    get value() {
      if ((this as any).args.shouldThrow) {
        throw new Error('conditional error');
      }
      return 'ok';
    }
  }
);

export class TryCatchTestCase extends AbstractStrictTestCase {
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
    runTask(() => change());
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

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] — prototype semantics',
  class extends TryCatchTestCase {
    afterEach() {
      super.afterEach();
    }

    '@test renders default block when no error'() {
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}hello{{catch as |err|}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({}),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello' });
    }

    '@test renders the try body with a zero-param catch when no error'() {
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}hello{{catch}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({}),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello' });
    }

    '@test renders catch with error and retry when the try body throws'() {
      class State {
        @tracked shouldThrow = true;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}caught: {{err.message}} <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: conditional error <button>Retry</button>' });

      this.assertChange({
        change: () => clickElement('button'),
        expect: 'caught: conditional error <button>Retry</button>',
      });

      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'ok',
      });
    }

    '@test catches error during initial render and shows error block'() {
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}<Throwing />{{catch as |err|}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({ Throwing }),
        }),
        templateOnly()
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
        let Root = setComponentTemplate(
          precompileTemplate('{{#try}}<Throwing />{{catch as |err|}}caught{{/try}}', {
            strictMode: true,
            scope: () => ({ Throwing }),
          }),
          templateOnly()
        );

        this.renderComponent(Root, { expect: 'caught' });

        assert.ok(errors.length > 0, 'console.error was called');
        assert.strictEqual(
          errors[0]![0],
          'An error was caught by {{#try}}:',
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state }) }
        ),
        templateOnly()
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
          'An error was caught by {{#try}}:',
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
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Throwing />{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error during rerender'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}<button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: '<button>Retry</button>' });

      state.shouldThrow = false;

      this.assertChange({
        change: () => clickElement('button'),
        expect: 'ok',
      });
    }

    '@test nested boundaries — inner catches, outer unaffected'() {
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}outer ok {{#try}}<Throwing />{{catch as |err|}}inner caught{{/try}}{{catch as |err|}}outer caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'outer ok inner caught' });
    }

    '@test renders nothing when no error block provided'() {
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}<Throwing />{{/try}}', {
          strictMode: true,
          scope: () => ({ Throwing }),
        }),
        templateOnly()
      );

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

      let Counter = setComponentTemplate(
        precompileTemplate(
          '<span>{{this.count}}</span><button {{on "click" this.increment}}>+</button>',
          { strictMode: true, scope: () => ({ on }) }
        ),
        CounterComponent
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} /><Counter />{{catch as |err retry|}}<button class="retry" {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, Counter, state, on }) }
        ),
        templateOnly()
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
      let Root = setComponentTemplate(
        precompileTemplate(
          '<span>before</span>{{#try}}<Throwing />{{catch as |err|}}caught{{/try}}<span>after</span>',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: '<span>before</span>caught<span>after</span>' });
    }

    '@test catches error from deeply nested grandchild component'() {
      let Child = setComponentTemplate(
        precompileTemplate('<Throwing />', { strictMode: true, scope: () => ({ Throwing }) }),
        templateOnly()
      );
      let Parent = setComponentTemplate(
        precompileTemplate('<Child />', { strictMode: true, scope: () => ({ Child }) }),
        templateOnly()
      );

      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}<Parent />{{catch as |err|}}caught: {{err.message}}{{/try}}', {
          strictMode: true,
          scope: () => ({ Parent }),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error from item in each loop'() {
      let ItemComponent = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bad') {
              throw new Error('bad item');
            }
            return (this as any).args.item;
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#each (array "good" "bad" "also-good") as |item|}}<ItemComponent @item={{item}} />{{/each}}{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ ItemComponent, array }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{maybeThrowHelper state.shouldThrow}}{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ maybeThrowHelper, state }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{throwingHelper}}{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ throwingHelper }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: helper error' });
    }

    '@test modifiers install correctly inside error boundary'(assert: Assert) {
      let trackingModifier = defineSimpleModifier((element: Element) => {
        assert.step('modifier installed');
        element.setAttribute('data-modified', 'true');
      });

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<div {{trackingModifier}}>content</div>{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ trackingModifier }) }
        ),
        templateOnly()
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

      let FullName = setComponentTemplate(
        precompileTemplate('{{this.fullName}}'),
        class extends GlimmerishComponent {
          get fullName() {
            return `${(this as any).args.first} ${(this as any).args.last}`;
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<FullName @first={{state.firstName}} @last={{state.lastName}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ FullName, state }) }
        ),
        templateOnly()
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
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Throwing />{{catch as |err|}}first caught{{/try}}{{#try}}second ok{{catch as |err|}}second caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'first caughtsecond ok' });
    }

    '@test error boundary preserves error block across unrelated rerenders'() {
      class State {
        @tracked counter = 0;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '<span>{{state.counter}}</span>{{#try}}<Throwing />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, state }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '<span>{{state.label}}</span>{{#try}}<Throwing />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: '<span>hello</span>caught' });

      this.assertChange({
        change: () => (state.label = 'world'),
        expect: '<span>world</span>caught',
      });
    }

    '@test catches error from conditional branch during initial render'() {
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#if true}}<Throwing />{{else}}safe{{/if}}{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: render error' });
    }

    '@test catches error when tracked array mutation causes throw during rerender'() {
      class State {
        @tracked items = ['a', 'b'];
      }
      let state = new State();

      let ItemComponent = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb item');
            }
            return (this as any).args.item;
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ ItemComponent, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'ab' });

      this.assertChange({
        change: () => (state.items = ['a', 'b', 'bomb']),
        expect: 'caught: bomb item',
      });
    }

    // Modifier install errors are not caught by try because modifiers install
    // during transaction.commit(), which runs after VM execution completes.
    // try only catches errors during the VM render phase.
    '@skip catches error thrown by a modifier'() {
      let throwingModifier = defineSimpleModifier(() => {
        throw new Error('modifier error');
      });

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<div {{throwingModifier}}>content</div>{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ throwingModifier }) }
        ),
        templateOnly()
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

      let Tracked = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        DestroyableComponent as any
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Tracked @shouldThrow={{state.shouldThrow}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ Tracked, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'alive' });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      assert.verifySteps(['destroyed']);
    }

    '@test retry that still throws shows error block again'() {
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Throwing />{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, on }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#if state.showDanger}}<Throwing />{{else}}safe{{/if}}{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'safe' });

      this.assertChange({
        change: () => (state.showDanger = true),
        expect: 'caught',
      });
    }

    '@test rerender error then fix state and retry recovers'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
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

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
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
      let ThrowingFallback = setComponentTemplate(
        precompileTemplate('{{this.boom}}'),
        class extends GlimmerishComponent {
          get boom(): never {
            throw new Error('fallback error');
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#try}}<Throwing />{{catch as |err|}}<ThrowingFallback />{{/try}}{{catch as |err|}}outer caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, ThrowingFallback }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'outer caught: fallback error' });
    }

    '@test each loop insert error then retry recovers'() {
      class State {
        @tracked items = ['a', 'b'];
      }
      let state = new State();

      let ItemComponent = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb');
            }
            return (this as any).args.item;
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ ItemComponent, state, on }) }
        ),
        templateOnly()
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

      let ItemComponent = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        class extends GlimmerishComponent {
          get value() {
            if ((this as any).args.item === 'bomb') {
              throw new Error('bomb');
            }
            return (this as any).args.item;
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#each state.items as |item|}}<ItemComponent @item={{item}} />{{/each}}{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ ItemComponent, state, on }) }
        ),
        templateOnly()
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

    '@test recovers when state read by the failed initial render changes'() {
      class State {
        @tracked shouldThrow = true;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught' });

      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'ok',
      });
    }

    '@test recovers when state read by the failed rerender changes'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'ok' });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      this.assertChange({
        change: () => (state.shouldThrow = false),
        expect: 'ok',
      });

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });
    }

    '@test does not retry when state the failed render never read changes'(assert: Assert) {
      class State {
        @tracked label = 'a';
      }
      let state = new State();
      let attempts = 0;

      let CountedThrow = setComponentTemplate(
        precompileTemplate('{{this.boom}}'),
        class extends GlimmerishComponent {
          get boom(): never {
            attempts++;
            throw new Error('render error');
          }
        }
      );

      // The default block throws before it reaches `state.label`, so only the
      // error block depends on it. Changing it must update the fallback
      // without re-attempting the default block.
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<CountedThrow />{{state.label}}{{catch}}caught {{state.label}}{{/try}}',
          { strictMode: true, scope: () => ({ CountedThrow, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught a' });
      assert.strictEqual(attempts, 1, 'default block attempted once on initial render');

      this.assertChange({
        change: () => (state.label = 'b'),
        expect: 'caught b',
      });
      assert.strictEqual(attempts, 1, 'unrelated state change does not re-attempt');
    }

    '@test retries when state read before the throw changes, and re-catches if still failing'(
      assert: Assert
    ) {
      class State {
        @tracked count = 1;
      }
      let state = new State();
      let attempts = 0;

      let FailsWhilePositive = setComponentTemplate(
        precompileTemplate('{{this.value}}'),
        class extends GlimmerishComponent {
          get value() {
            attempts++;
            let count = (this as any).args.count;
            if (count > 0) {
              throw new Error(`count is ${count}`);
            }
            return 'ok';
          }
        }
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<FailsWhilePositive @count={{state.count}} />{{catch as |err|}}caught: {{err.message}}{{/try}}',
          { strictMode: true, scope: () => ({ FailsWhilePositive, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught: count is 1' });
      assert.strictEqual(attempts, 1);

      this.assertChange({
        change: () => (state.count = 2),
        expect: 'caught: count is 2',
      });
      assert.strictEqual(attempts, 2, 'retried once and caught the new error');

      this.assertChange({
        change: () => (state.count = 0),
        expect: 'ok',
      });
      assert.strictEqual(attempts, 3, 'retried once and recovered');
    }

    '@test rerender error then retry without fixing re-catches'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
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

    '@test multiple error-recovery cycles do not require extra retry clicks'() {
      class State {
        @tracked shouldThrow = false;
      }
      let state = new State();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<MaybeThrow @shouldThrow={{state.shouldThrow}} />{{catch as |err retry|}}caught <button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, state, on }) }
        ),
        templateOnly()
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

    '@test sibling content after try updates correctly'() {
      let state = new SiblingState();

      let Sibling = setComponentTemplate(
        precompileTemplate('{{state.label}}', { strictMode: true, scope: () => ({ state }) }),
        templateOnly()
      );

      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}content{{catch as |err|}}caught{{/try}}<Sibling />', {
          strictMode: true,
          scope: () => ({ Sibling }),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'contentbefore' });

      // Changing tracked state on sibling should not crash.
      // Without the block stack fix, the try's orphaned AppendingBlock
      // corrupts the sibling's bounds, causing a crash in clear() during re-render.
      this.assertChange({
        change: () => (state.label = 'after'),
        expect: 'contentafter',
      });
    }

    '@test component inside try re-renders with sibling content after'() {
      let state = new InnerState();
      let siblingState = new SiblingState();
      let Inner = setComponentTemplate(
        precompileTemplate('{{state.value}}', { strictMode: true, scope: () => ({ state }) }),
        templateOnly()
      );

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Inner />{{catch as |err|}}caught{{/try}}<span>{{siblingState.label}}</span>',
          { strictMode: true, scope: () => ({ Inner, siblingState }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello<span>before</span>' });

      // Re-render inside EB content — without the cursor fix, this inverts
      // the parent block's bounds (firstNode after lastNode in DOM order).
      this.assertChange({
        change: () => (state.value = 'world'),
        expect: 'world<span>before</span>',
      });

      // Re-render sibling — verifies bounds are correct after EB content changed.
      this.assertChange({
        change: () => (siblingState.label = 'after'),
        expect: 'world<span>after</span>',
      });
    }

    '@test tracked state inside try content updates'() {
      let state = new InnerState();

      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}{{state.value}}{{catch as |err|}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({ state }),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello' });

      this.assertChange({
        change: () => (state.value = 'world'),
        expect: 'world',
      });
    }

    '@test try inside conditional that toggles'() {
      let state = new ConditionalState();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#if state.show}}{{#try}}content{{catch as |err|}}caught{{/try}}{{/if}}',
          { strictMode: true, scope: () => ({ state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'content' });

      this.assertChange({
        change: () => (state.show = false),
        expect: '<!---->',
      });

      this.assertChange({
        change: () => (state.show = true),
        expect: 'content',
      });
    }

    '@test try and sibling in conditional block re-render'() {
      let state = new SiblingState();
      let cond = new ConditionalState();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#if cond.show}}{{#try}}eb{{catch as |err|}}caught{{/try}}{{state.label}}{{/if}}',
          { strictMode: true, scope: () => ({ state, cond }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'ebbefore' });

      this.assertChange({
        change: () => (state.label = 'after'),
        expect: 'ebafter',
      });
    }

    '@test try wrapping component with tracked state'() {
      let state = new InnerState();
      let Inner = setComponentTemplate(
        precompileTemplate('{{state.value}}', { strictMode: true, scope: () => ({ state }) }),
        templateOnly()
      );

      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}<Inner />{{catch as |err|}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({ Inner }),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello' });

      this.assertChange({
        change: () => (state.value = 'world'),
        expect: 'world',
      });
    }

    '@test catches error inside {{#in-element}} during initial render and cleans up remote DOM'() {
      let remote = document.createElement('div');
      remote.id = 'eb-remote-target-1';
      // A detached target keeps remote DOM separate from the local fixture.

      let getRemote = defineSimpleHelper(() => remote);

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#in-element (getRemote) insertBefore=null}}<Throwing/>{{/in-element}}{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, getRemote }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'caught' });

      // Remote element should be completely empty — no DOM nodes at all.
      this.assert.strictEqual(
        remote.innerHTML,
        '',
        'remote element should be completely empty after error'
      );
    }

    '@test catches rerender error and cleans up {{#in-element}} remote DOM'() {
      let remote = document.createElement('div');
      remote.id = 'eb-remote-target-2';
      // A detached target keeps remote DOM separate from the local fixture.

      let getRemote = defineSimpleHelper(() => remote);
      let state = new ThrowOnlyState();

      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#in-element (getRemote) insertBefore=null}}<MaybeThrow @shouldThrow={{state.shouldThrow}}/>{{/in-element}}{{catch as |err|}}caught{{/try}}',
          { strictMode: true, scope: () => ({ MaybeThrow, getRemote, state }) }
        ),
        templateOnly()
      );

      this.renderComponent(Root, { expect: '<!---->' });

      // Remote element should have content from successful render
      this.assert.strictEqual(remote.textContent, 'ok', 'remote element has content before error');

      this.assertChange({
        change: () => (state.shouldThrow = true),
        expect: 'caught',
      });

      // Remote element should be completely empty — no DOM nodes at all.
      this.assert.strictEqual(
        remote.innerHTML,
        '',
        'remote element should be completely empty after error'
      );
    }

    '@test multiple re-renders of try content'() {
      let state = new InnerState();

      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}{{state.value}}{{catch as |err|}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({ state }),
        }),
        templateOnly()
      );

      this.renderComponent(Root, { expect: 'hello' });

      this.assertChange({
        change: () => (state.value = 'one'),
        expect: 'one',
      });

      this.assertChange({
        change: () => (state.value = 'two'),
        expect: 'two',
      });

      this.assertChange({
        change: () => (state.value = 'three'),
        expect: 'three',
      });
    }
  }
);

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] — keyword scopes and values',
  class extends TryCatchTestCase {
    '@test catch accepts zero params and removes partial initial output'() {
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>before</i>{{#try}}<b>partial</b><Throwing />{{catch}}caught{{/try}}<i>after</i>',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<i>before</i>caught<i>after</i>' });
    }

    '@test catch with one param receives the exact thrown value'(assert: Assert) {
      // Falsy thrown values must be distinguished from the absence of an error.
      for (let thrown of [
        new Error('identity'),
        { message: 'plain object' },
        'string',
        0,
        false,
        null,
        undefined,
      ]) {
        let received: unknown[] = [];
        let boom = defineSimpleHelper(() => {
          throw thrown;
        });
        let capture = defineSimpleHelper((error: unknown) => {
          received.push(error);
          return 'caught';
        });
        let Root = setComponentTemplate(
          precompileTemplate('{{#try}}{{boom}}{{catch as |error|}}{{capture error}}{{/try}}', {
            strictMode: true,
            scope: () => ({ boom, capture }),
          }),
          templateOnly()
        );
        this.renderComponent(Root, { expect: 'caught' });
        assert.ok(received.length > 0, 'fallback evaluated');
        for (let value of received) {
          assert.strictEqual(value, thrown, 'the thrown value is passed through unchanged');
        }
        runTask(() => this.component!.destroy());
        this.element.innerHTML = '';
      }
    }

    '@test two catch params provide a retry function usable by on click'(assert: Assert) {
      let failing = true;
      let attempts = 0;
      let boom = defineSimpleHelper(() => {
        attempts++;
        if (failing) throw new Error(`attempt ${attempts}`);
        return 'recovered';
      });
      let receivedRetry: unknown;
      let capture = defineSimpleHelper((retry: unknown) => {
        receivedRetry = retry;
        return '';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{boom}}{{catch as |error retry|}}{{error.message}}{{capture retry}}<button {{on "click" retry}}>Retry</button>{{/try}}',
          { strictMode: true, scope: () => ({ boom, capture, on }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'attempt 1<button>Retry</button>' });
      assert.strictEqual(typeof receivedRetry, 'function');
      this.assertChange({
        change: () => clickElement('button'),
        expect: 'attempt 2<button>Retry</button>',
      });
      assert.strictEqual(attempts, 2, 'one attempt per click');
      failing = false;
      this.assertChange({ change: () => clickElement('button'), expect: 'recovered' });
      assert.strictEqual(attempts, 3, 'manual retry works without dirtying a body dependency');
    }

    '@test a try without catch recovers automatically from an empty fallback'() {
      class State {
        @tracked failing = true;
      }
      let state = new State();
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>before</i>{{#try}}partial<MaybeThrow @shouldThrow={{state.failing}} />{{/try}}<i>after</i>',
          { strictMode: true, scope: () => ({ state, MaybeThrow }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<i>before</i><!----><i>after</i>' });
      this.assertChange({
        change: () => (state.failing = false),
        expect: '<i>before</i>partialok<i>after</i>',
      });
    }

    '@test try inside each rows isolates failures through insertion and reordering'() {
      class Row {
        @tracked failing = false;
        constructor(public id: string) {}
      }
      class State {
        @tracked rows = [new Row('a'), new Row('b'), new Row('c')];
      }
      let state = new State();
      let [a, b, c] = state.rows as [Row, Row, Row];
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ul>{{#each state.rows key="id" as |row|}}<li>{{row.id}}:{{#try}}<MaybeThrow @shouldThrow={{row.failing}} />{{catch as |error|}}{{error.message}}{{/try}}</li>{{/each}}</ul>',
          { strictMode: true, scope: () => ({ state, MaybeThrow }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<ul><li>a:ok</li><li>b:ok</li><li>c:ok</li></ul>' });
      this.assertChange({
        change: () => (b.failing = true),
        expect: '<ul><li>a:ok</li><li>b:conditional error</li><li>c:ok</li></ul>',
      });
      let d = new Row('d');
      d.failing = true;
      this.assertChange({
        change: () => (state.rows = [c, d, b, a]),
        expect:
          '<ul><li>c:ok</li><li>d:conditional error</li><li>b:conditional error</li><li>a:ok</li></ul>',
      });
      this.assertChange({
        change: () => (b.failing = false),
        expect: '<ul><li>c:ok</li><li>d:conditional error</li><li>b:ok</li><li>a:ok</li></ul>',
      });
      this.assertChange({
        change: () => (state.rows = [b, a]),
        expect: '<ul><li>b:ok</li><li>a:ok</li></ul>',
      });
    }

    '@test try inside a named block retains caller scope and block params'() {
      class State {
        @tracked failing = true;
        @tracked label = 'caller';
      }
      let state = new State();
      let Wrapper = setComponentTemplate(
        precompileTemplate('<section>{{yield "named" to="content"}}</section>'),
        templateOnly()
      );
      let Root = setComponentTemplate(
        precompileTemplate(
          '<Wrapper><:content as |name|>{{#try}}{{name}} {{state.label}} <MaybeThrow @shouldThrow={{state.failing}} />{{catch as |error|}}{{name}} {{state.label}} {{error.message}}{{/try}}</:content></Wrapper>',
          { strictMode: true, scope: () => ({ Wrapper, state, MaybeThrow }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<section>named caller conditional error</section>' });
      this.assertChange({
        change: () => (state.failing = false),
        expect: '<section>named caller ok</section>',
      });
    }

    '@test a try nested in another try catch catches its own body error'() {
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Throwing />{{catch as |outerError|}}outer {{outerError.message}} {{#try}}<Throwing />{{catch as |innerError|}}inner {{innerError.message}}{{/try}}{{/try}}',
          { strictMode: true, scope: () => ({ Throwing }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'outer render error inner render error' });
    }

    '@test try body yields to the enclosing component block and catches its errors'() {
      class State {
        @tracked failing = false;
        @tracked label = 'hello';
      }
      let state = new State();
      let Wrapper = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<b>{{yield "yielded"}}</b>{{catch as |error|}}{{error.message}}{{/try}}',
          { strictMode: true }
        ),
        templateOnly()
      );
      let Root = setComponentTemplate(
        precompileTemplate(
          '<Wrapper as |value|>{{value}} {{state.label}} <MaybeThrow @shouldThrow={{state.failing}} /></Wrapper>',
          {
            strictMode: true,
            scope: () => ({ Wrapper, state, MaybeThrow }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<b>yielded hello ok</b>' });
      this.assertChange({ change: () => (state.failing = true), expect: 'conditional error' });
      this.assertChange({
        change: () => (state.failing = false),
        expect: '<b>yielded hello ok</b>',
      });
      this.assertChange({
        change: () => (state.label = 'world'),
        expect: '<b>yielded world ok</b>',
      });
    }

    '@test error and retry remain identical while fallback outer tracked state updates'(
      assert: Assert
    ) {
      class State {
        @tracked label = 'a';
      }
      let state = new State();
      let attempts = 0;
      let thrown = new Error('stable');
      let boom = defineSimpleHelper(() => {
        attempts++;
        throw thrown;
      });
      let captures: [unknown, unknown][] = [];
      let capture = defineSimpleHelper((error: unknown, retry: unknown, label: unknown) => {
        captures.push([error, retry]);
        return label;
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{boom}}{{state.label}}{{catch as |error retry|}}{{error.message}} {{capture error retry state.label}}{{/try}}',
          { strictMode: true, scope: () => ({ boom, state, capture }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'stable a' });
      let first = captures[0]!;
      assert.strictEqual(first[0], thrown);
      assert.strictEqual(typeof first[1], 'function');
      for (let label of ['b', 'c', 'd']) {
        this.assertChange({ change: () => (state.label = label), expect: `stable ${label}` });
      }
      assert.strictEqual(attempts, 1, 'fallback dependencies do not retry the failed body');
      assert.ok(captures.length >= 4, 'capture evaluated for every fallback update');
      for (let [error, retry] of captures) {
        assert.strictEqual(error, first[0], 'same thrown value');
        assert.strictEqual(retry, first[1], 'same retry function');
      }
    }

    '@test initial fallback error escapes when there is no enclosing try'(assert: Assert) {
      let fallback = defineSimpleHelper(() => {
        throw new Error('uncaught fallback');
      });
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}<Throwing />{{catch}}{{fallback}}{{/try}}', {
          strictMode: true,
          scope: () => ({ Throwing, fallback }),
        }),
        templateOnly()
      );
      assert.throws(
        () => this.renderComponent(Root, { expect: 'unreachable' }),
        /uncaught fallback/
      );
      assert.false(isInErrorBoundary(), 'append fallback escape restores boundary depth');
      if (DEBUG) assert.strictEqual(getTrackingDepth(), 0, 'uncaught append resets tracking');
    }

    '@test a fallback error during rerender escapes to the enclosing try'() {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<i>outer</i>{{#try}}<Throwing />{{catch}}<b>inner fallback</b><MaybeThrow @shouldThrow={{state.failing}} />{{/try}}{{catch as |error|}}outer caught: {{error.message}}{{/try}}',
          { strictMode: true, scope: () => ({ Throwing, MaybeThrow, state }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<i>outer</i><b>inner fallback</b>ok' });
      this.assertChange({
        change: () => (state.failing = true),
        expect: 'outer caught: conditional error',
      });
      this.assertChange({
        change: () => (state.failing = false),
        expect: '<i>outer</i><b>inner fallback</b>ok',
      });
    }

    '@test a fallback error during rerender escapes without an enclosing try'(assert: Assert) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Throwing />{{catch}}<MaybeThrow @shouldThrow={{state.failing}} />{{/try}}',
          {
            strictMode: true,
            scope: () => ({ Throwing, MaybeThrow, state }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'ok' });
      assert.throws(() => runTask(() => (state.failing = true)), /conditional error/);
      assert.false(isInErrorBoundary(), 'update fallback escape restores boundary depth');
      if (DEBUG) assert.strictEqual(getTrackingDepth(), 0, 'uncaught update resets tracking');
    }
  }
);

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] — abort cleanup and tracking',
  class extends TryCatchTestCase {
    '@test prepend then throw clears the entire attempted range and preserves siblings'() {
      this.assertListAbort(['x', 'bomb', 'a', 'b', 'c']);
    }

    '@test middle row insert then throw clears temporary list markers and preserves siblings'() {
      this.assertListAbort(['a', 'x', 'bomb', 'b', 'c']);
    }

    '@test reorder then throw clears moved and inserted content and preserves siblings'() {
      this.assertListAbort(['c', 'x', 'b', 'bomb', 'a']);
    }

    /** Exercise mounted list cleanup with successful insertions before a failing item. */
    assertListAbort(failedItems: string[]) {
      class State {
        @tracked items = ['a', 'b', 'c'];
        @tracked label = 'before';
      }
      let state = new State();
      let item = defineSimpleHelper((value: unknown) => {
        if (value === 'bomb') throw new Error('bomb');
        return value;
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>{{state.label}}</i>{{#try}}<b>prefix</b>{{#each state.items key="@identity" as |value|}}<span>{{item value}}</span>{{/each}}<b>suffix</b>{{catch as |error|}}caught {{error.message}}{{/try}}<i>{{state.label}}</i>',
          { strictMode: true, scope: () => ({ state, item }) }
        ),
        templateOnly()
      );
      let body = (items: string[]) =>
        `<b>prefix</b>${items.map((value) => `<span>${value}</span>`).join('')}<b>suffix</b>`;
      this.renderComponent(Root, { expect: `<i>before</i>${body(state.items)}<i>before</i>` });
      for (let cycle = 1; cycle <= 3; cycle++) {
        this.assertChange({
          change: () => (state.items = [...failedItems]),
          expect: `<i>${state.label}</i>caught bomb<i>${state.label}</i>`,
        });
        this.assertChange({
          change: () => (state.label = `cycle ${cycle}`),
          expect: `<i>cycle ${cycle}</i>caught bomb<i>cycle ${cycle}</i>`,
        });
        let recovered = [`x${cycle}`, `y${cycle}`, `z${cycle}`];
        this.assertChange({
          change: () => (state.items = recovered),
          expect: `<i>${state.label}</i>${body(recovered)}<i>${state.label}</i>`,
        });
      }
    }

    '@test aborted initial attempt cancels modifier install and component didCreate work'(
      assert: Assert
    ) {
      let components = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifiers = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(components);
      let modifier = lifecycleModifier(modifiers);
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Child @label="partial" /><div {{modifier}}>partial</div><Throwing />{{catch}}caught{{/try}}',
          {
            strictMode: true,
            scope: () => ({ Child, modifier, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.deepEqual(components, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      assert.deepEqual(modifiers, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      runTask(() => this.component!.destroy());
      assert.strictEqual(components.destroyed, 1, 'no duplicate destruction at root teardown');
      assert.strictEqual(modifiers.destroyed, 1, 'no duplicate destruction at root teardown');
    }

    '@test modifier on an open element is destroyed exactly once when its child throws'(
      assert: Assert
    ) {
      let counts = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifier = lifecycleModifier(counts);
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<div {{modifier}}>prefix<Throwing /></div>{{catch}}caught{{/try}}',
          {
            strictMode: true,
            scope: () => ({ modifier, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.deepEqual(counts, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      runTask(() => this.component!.destroy());
      assert.strictEqual(counts.destroyed, 1);
    }

    '@test modifier created before another modifier throws on create is destroyed exactly once'(
      assert: Assert
    ) {
      let counts = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifier = lifecycleModifier(counts);
      let creates = 0;
      let throwing = setModifierManager(
        () => ({
          capabilities: modifierCapabilities('3.22'),
          createModifier(): never {
            creates++;
            throw new Error('modifier create');
          },
          installModifier() {},
          updateModifier() {},
          destroyModifier() {},
        }),
        {}
      );
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<div {{modifier}} {{throwing}}>partial</div>{{catch as |error|}}{{error.message}}{{/try}}',
          {
            strictMode: true,
            scope: () => ({ modifier, throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'modifier create' });
      assert.strictEqual(creates, 1);
      assert.deepEqual(counts, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      runTask(() => this.component!.destroy());
      assert.strictEqual(counts.destroyed, 1);
    }

    '@test mounted components and modifiers are destroyed across repeated recovery cycles'(
      assert: Assert
    ) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let components = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifiers = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(components);
      let modifier = lifecycleModifier(modifiers);
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>before</i>{{#try}}<Child @label="alive" /><div {{modifier}}>alive</div><MaybeThrow @shouldThrow={{state.failing}} />{{catch}}caught{{/try}}<i>after</i>',
          {
            strictMode: true,
            scope: () => ({ Child, modifier, MaybeThrow, state }),
          }
        ),
        templateOnly()
      );
      let alive = '<i>before</i><b>alive</b><div>alive</div>ok<i>after</i>';
      this.renderComponent(Root, { expect: alive });
      for (let cycle = 1; cycle <= 3; cycle++) {
        assert.deepEqual(components, {
          created: cycle,
          installed: cycle,
          updated: 0,
          destroyed: cycle - 1,
        });
        assert.deepEqual(modifiers, {
          created: cycle,
          installed: cycle,
          updated: 0,
          destroyed: cycle - 1,
        });
        this.assertChange({
          change: () => (state.failing = true),
          expect: '<i>before</i>caught<i>after</i>',
        });
        assert.strictEqual(components.destroyed, cycle);
        assert.strictEqual(modifiers.destroyed, cycle);
        this.assertChange({ change: () => (state.failing = false), expect: alive });
      }
      runTask(() => this.component!.destroy());
      assert.deepEqual(components, { created: 4, installed: 4, updated: 0, destroyed: 4 });
      assert.deepEqual(modifiers, { created: 4, installed: 4, updated: 0, destroyed: 4 });
    }

    '@test aborted retry attempts destroy each new component and modifier once'(assert: Assert) {
      let components = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifiers = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(components);
      let modifier = lifecycleModifier(modifiers);
      let failing = true;
      let boom = defineSimpleHelper(() => {
        if (failing) throw new Error('retry error');
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Child @label="child" /><div {{modifier}}>child</div>{{boom}}{{catch as |error retry|}}{{error.message}}<button {{on "click" retry}}>Retry</button>{{/try}}',
          {
            strictMode: true,
            scope: () => ({ Child, modifier, boom, on }),
          }
        ),
        templateOnly()
      );
      let fallback = 'retry error<button>Retry</button>';
      this.renderComponent(Root, { expect: fallback });
      for (let attempt = 1; attempt <= 3; attempt++) {
        let expected = { created: attempt, installed: 0, updated: 0, destroyed: attempt };
        assert.deepEqual(components, expected);
        assert.deepEqual(modifiers, expected);
        if (attempt < 3)
          this.assertChange({ change: () => clickElement('button'), expect: fallback });
      }
      failing = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: '<b>child</b><div>child</div>ok',
      });
      runTask(() => this.component!.destroy());
      assert.deepEqual(components, { created: 4, installed: 1, updated: 0, destroyed: 4 });
      assert.deepEqual(modifiers, { created: 4, installed: 1, updated: 0, destroyed: 4 });
    }

    '@test abort preserves lifecycle work of an independently rendered root'(assert: Assert) {
      let independentComponents = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let independentModifiers = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let aborted = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(independentComponents);
      let modifier = lifecycleModifier(independentModifiers);
      let Aborted = lifecycleComponent(aborted);
      let Independent = setComponentTemplate(
        precompileTemplate('<Child @label="independent" /><div {{modifier}}>independent</div>', {
          strictMode: true,
          scope: () => ({ Child, modifier }),
        }),
        templateOnly()
      );
      let target = document.createElement('div');
      let renderer = BaseRenderer.strict(this.owner, document, {
        isInteractive: true,
        hasDOM: true,
      });
      associateDestroyableChild(this, renderer);
      setRenderer(this.owner, renderer);
      let renderedDuringAttempt = '';
      let renderIndependent = defineSimpleHelper(() => {
        // Bypass Ember's root queue so this independent VM actually executes
        // inside the failing attempt's transaction, before the following throw.
        let { state } = renderer;
        let result = renderSync(
          state.env,
          renderGlimmerComponent(
            state.context,
            state.builder(state.env, {
              element: target as unknown as SimpleElement,
              nextSibling: null,
            }),
            this.owner,
            Independent
          )
        );
        associateDestroyableChild(this, result);
        renderedDuringAttempt = target.innerHTML;
        return '';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}<Aborted @label="aborted" />{{renderIndependent}}<Throwing />{{catch}}caught{{/try}}',
          {
            strictMode: true,
            scope: () => ({ Aborted, renderIndependent, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.strictEqual(renderedDuringAttempt, '<b>independent</b><div>independent</div>');
      assert.strictEqual(target.innerHTML, '<b>independent</b><div>independent</div>');
      assert.deepEqual(aborted, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      assert.deepEqual(independentComponents, {
        created: 1,
        installed: 1,
        updated: 0,
        destroyed: 0,
      });
      assert.deepEqual(independentModifiers, {
        created: 1,
        installed: 1,
        updated: 0,
        destroyed: 0,
      });
      runDestroy(this);
      assert.strictEqual(independentComponents.destroyed, 1);
      assert.strictEqual(independentModifiers.destroyed, 1);
    }

    '@test remote prefix is removed synchronously before fallback uses the same destination'(
      assert: Assert
    ) {
      class State {
        @tracked failing = true;
      }
      let state = new State();
      let remote = document.createElement('div');
      remote.innerHTML = '<i>existing</i>';
      let getRemote = defineSimpleHelper(() => remote);
      let observed: string[] = [];
      let inspect = defineSimpleHelper(() => {
        observed.push(remote.innerHTML);
        return '';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#in-element (getRemote) insertBefore=null}}<b>body prefix</b><MaybeThrow @shouldThrow={{state.failing}} />{{/in-element}}{{catch}}{{inspect}}{{#in-element (getRemote) insertBefore=null}}<strong>fallback</strong>{{/in-element}}{{/try}}',
          { strictMode: true, scope: () => ({ getRemote, state, MaybeThrow, inspect }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<!---->' });
      assert.deepEqual(observed, ['<i>existing</i>'], 'abort cleanup precedes fallback execution');
      assert.strictEqual(
        remote.innerHTML,
        '<i>existing</i><strong>fallback</strong>',
        'deferred destruction preserves fallback'
      );
      for (let cycle = 1; cycle <= 3; cycle++) {
        this.assertChange({ change: () => (state.failing = false), expect: '<!---->' });
        assert.strictEqual(remote.innerHTML, '<i>existing</i><b>body prefix</b>ok');
        this.assertChange({ change: () => (state.failing = true), expect: '<!---->' });
        assert.strictEqual(remote.innerHTML, '<i>existing</i><strong>fallback</strong>');
        assert.strictEqual(observed.length, cycle + 1);
        assert.strictEqual(observed[cycle], '<i>existing</i>');
      }
      runTask(() => this.component!.destroy());
      assert.strictEqual(remote.innerHTML, '<i>existing</i>');
    }

    '@test one-shot fallback failure propagates the replacement error to outer catch'(
      assert: Assert
    ) {
      let attempts = 0;
      let fallback = defineSimpleHelper(() => {
        attempts++;
        if (attempts === 1) throw new Error('one-shot fallback');
        return 'would succeed if wrongly retried';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{#try}}<Throwing />{{catch}}{{fallback}}{{/try}}{{catch as |error|}}outer {{error.message}}{{/try}}',
          {
            strictMode: true,
            scope: () => ({ Throwing, fallback }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'outer one-shot fallback' });
      assert.strictEqual(attempts, 1, 'a catch does not catch its own error and retry itself');
    }

    '@test nested mounted helper failures automatically retry without reattempting outer body'(
      assert: Assert
    ) {
      class State {
        @tracked failing = false;
        @tracked label = 'before';
      }
      let state = new State();
      let innerAttempts = 0;
      let outerAttempts = 0;
      let outer = defineSimpleHelper(() => {
        outerAttempts++;
        return 'outer';
      });
      let helper = defineSimpleHelper((failing: unknown) => {
        innerAttempts++;
        if (failing) throw new Error('mounted helper');
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '{{#try}}{{outer}} {{#try}}{{helper state.failing}}{{catch as |error|}}{{error.message}}{{/try}}{{catch}}outer caught{{/try}}<i>{{state.label}}</i>',
          {
            strictMode: true,
            scope: () => ({ outer, helper, state }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'outer ok<i>before</i>' });
      for (let cycle = 1; cycle <= 3; cycle++) {
        this.assertChange({
          change: () => (state.failing = true),
          expect: `outer mounted helper<i>${state.label}</i>`,
        });
        this.assertChange({
          change: () => (state.label = `cycle ${cycle}`),
          expect: `outer mounted helper<i>cycle ${cycle}</i>`,
        });
        assert.strictEqual(innerAttempts, cycle * 2, 'unrelated sibling state does not retry');
        this.assertChange({
          change: () => (state.failing = false),
          expect: `outer ok<i>${state.label}</i>`,
        });
        assert.strictEqual(innerAttempts, cycle * 2 + 1);
        assert.strictEqual(outerAttempts, 1, 'outer boundary unaffected');
      }
    }
  }
);

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] — loose mode',
  class extends RenderingTestCase {
    '@test loose mode renders the try body and catches helper errors'() {
      this.registerHelper('boom', () => {
        throw new Error('loose helper');
      });
      this.render(
        '<i>before</i>{{#try}}partial{{boom}}{{catch as |error|}}{{error.message}}{{/try}}<i>after</i>'
      );
      this.assertHTML('<i>before</i>loose helper<i>after</i>');
      this.assertStableRerender();
    }

    '@test loose mode renders a try without a catch'() {
      this.render('{{#try}}<b>ok</b>{{/try}}');
      this.assertHTML('<b>ok</b>');
      this.assertStableRerender();
    }
  }
);
