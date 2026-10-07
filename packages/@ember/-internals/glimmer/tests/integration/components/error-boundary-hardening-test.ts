import {
  AbstractStrictTestCase,
  assertHTML,
  buildOwner,
  clickElement,
  defineSimpleHelper,
  moduleFor,
  runDestroy,
  runTask,
} from 'internal-test-helpers';
import { precompileTemplate } from '@ember/template-compilation';
import templateOnly from '@ember/component/template-only';
import { ErrorBoundary, setComponentManager } from '@ember/component';
import { on, renderComponent as renderGlimmerComponent, renderSync } from '@glimmer/runtime';
import { tracked } from '@glimmer/tracking';
import { isInErrorBoundary } from '@glimmer/validator/lib/tracking';
import { associateDestroyableChild, registerDestructor } from '@glimmer/destroyable';
import {
  componentCapabilities,
  modifierCapabilities,
  setModifierManager,
  setComponentTemplate,
} from '@glimmer/manager';
import { run } from '@ember/runloop';
import type Owner from '@ember/owner';
import type { Arguments, SimpleElement } from '@glimmer/interfaces';
import {
  BaseRenderer,
  renderComponent,
  setRenderer,
  type RenderResult,
} from '../../../lib/renderer';
import GlimmerishComponent from '../../utils/glimmerish-component';

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
      if (this.args.shouldThrow) {
        throw new Error('conditional error');
      }
      return 'ok';
    }
  }
);

class ErrorBoundaryHardeningTestCase extends AbstractStrictTestCase {
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
  'ErrorBoundary [error-boundary-hardening] — abort cleanup and lifecycle',
  class extends ErrorBoundaryHardeningTestCase {
    '@test baseline-green guard: prepend then throw clears the entire attempted range and preserves siblings'() {
      this.assertListAbort(['x', 'bomb', 'a', 'b', 'c']);
    }

    '@test baseline-green guard: middle row insert then throw clears temporary list markers and preserves siblings'() {
      this.assertListAbort(['a', 'x', 'bomb', 'b', 'c']);
    }

    '@test baseline-green guard: reorder then throw clears moved and inserted content and preserves siblings'() {
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
          '<i>{{state.label}}</i><ErrorBoundary><:try><b>prefix</b>{{#each state.items key="@identity" as |value|}}<span>{{item value}}</span>{{/each}}<b>suffix</b></:try><:catch as |error|>caught {{error.message}}</:catch></ErrorBoundary><i>{{state.label}}</i>',
          { strictMode: true, scope: () => ({ ErrorBoundary, state, item }) }
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
          '<ErrorBoundary><:try><Child @label="partial" /><div {{modifier}}>partial</div><Throwing /></:try><:catch>caught</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, Child, modifier, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.deepEqual(
        components,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `components lifecycle: ${JSON.stringify(components)}`
      );
      assert.deepEqual(
        modifiers,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `modifiers lifecycle: ${JSON.stringify(modifiers)}`
      );
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
          '<ErrorBoundary><:try><div {{modifier}}>prefix<Throwing /></div></:try><:catch>caught</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, modifier, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.deepEqual(
        counts,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `counts lifecycle: ${JSON.stringify(counts)}`
      );
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
          '<ErrorBoundary><:try><div {{modifier}} {{throwing}}>partial</div></:try><:catch as |error|>{{error.message}}</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, modifier, throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'modifier create' });
      assert.strictEqual(creates, 1);
      assert.deepEqual(
        counts,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `counts lifecycle: ${JSON.stringify(counts)}`
      );
      runTask(() => this.component!.destroy());
      assert.strictEqual(counts.destroyed, 1);
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
          '<ErrorBoundary><:try><Child @label="child" /><div {{modifier}}>child</div>{{boom}}</:try><:catch as |error retry|>{{error.message}}<button {{on "click" retry}}>Retry</button></:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, Child, modifier, boom, on }),
          }
        ),
        templateOnly()
      );
      let fallback = 'retry error<button>Retry</button>';
      this.renderComponent(Root, { expect: fallback });
      for (let attempt = 1; attempt <= 3; attempt++) {
        let expected = { created: attempt, installed: 0, updated: 0, destroyed: attempt };
        assert.deepEqual(
          components,
          expected,
          `components lifecycle: ${JSON.stringify(components)}`
        );
        assert.deepEqual(modifiers, expected, `modifiers lifecycle: ${JSON.stringify(modifiers)}`);
        if (attempt < 3)
          this.assertChange({ change: () => clickElement('button'), expect: fallback });
      }
      failing = false;
      this.assertChange({
        change: () => clickElement('button'),
        expect: '<b>child</b><div>child</div>ok',
      });
      runTask(() => this.component!.destroy());
      assert.deepEqual(
        components,
        { created: 4, installed: 1, updated: 0, destroyed: 4 },
        `components lifecycle: ${JSON.stringify(components)}`
      );
      assert.deepEqual(
        modifiers,
        { created: 4, installed: 1, updated: 0, destroyed: 4 },
        `modifiers lifecycle: ${JSON.stringify(modifiers)}`
      );
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
          '<ErrorBoundary><:try><Aborted @label="aborted" />{{renderIndependent}}<Throwing /></:try><:catch>caught</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, Aborted, renderIndependent, Throwing }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.strictEqual(renderedDuringAttempt, '<b>independent</b><div>independent</div>');
      assert.strictEqual(target.innerHTML, '<b>independent</b><div>independent</div>');
      assert.deepEqual(
        aborted,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `aborted lifecycle: ${JSON.stringify(aborted)}`
      );
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
          '<ErrorBoundary><:try>{{#in-element (getRemote) insertBefore=null}}<b>body prefix</b><MaybeThrow @shouldThrow={{state.failing}} />{{/in-element}}</:try><:catch>{{inspect}}{{#in-element (getRemote) insertBefore=null}}<strong>fallback</strong>{{/in-element}}</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, getRemote, state, MaybeThrow, inspect }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<!---->' });
      assert.deepEqual(
        observed,
        ['<i>existing</i>'],
        `abort cleanup precedes fallback execution: ${JSON.stringify(observed)}`
      );
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
  }
);

moduleFor(
  'ErrorBoundary [error-boundary-hardening] — inserted each row',
  class extends ErrorBoundaryHardeningTestCase {
    '@test baseline-green guard: boundary inside each rows isolates failures through insertion and reordering'() {
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
          '<ul>{{#each state.rows key="id" as |row|}}<li>{{row.id}}:<ErrorBoundary><:try><MaybeThrow @shouldThrow={{row.failing}} /></:try><:catch as |error|>{{error.message}}</:catch></ErrorBoundary></li>{{/each}}</ul>',
          { strictMode: true, scope: () => ({ ErrorBoundary, state, MaybeThrow }) }
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
  }
);

moduleFor(
  'ErrorBoundary [error-boundary-hardening] — remote content and independent roots',
  class extends ErrorBoundaryHardeningTestCase {
    '@test baseline-green guard: abort preserves a later independent remote block in the same destination'(
      assert: Assert
    ) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let remote = document.createElement('div');
      let boom = defineSimpleHelper((failing: unknown) => {
        if (failing) throw new Error('remote failure');
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try>{{#in-element remote insertBefore=null}}<b>owned</b>{{/in-element}}{{boom state.failing}}</:try><:catch>caught</:catch></ErrorBoundary>{{#in-element remote insertBefore=null}}<i>independent</i>{{/in-element}}',
          { strictMode: true, scope: () => ({ ErrorBoundary, remote, boom, state }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<!---->ok<!---->' });
      assert.strictEqual(remote.innerHTML, '<b>owned</b><i>independent</i>');
      let independent = remote.querySelector('i');
      this.assertChange({ change: () => (state.failing = true), expect: 'caught<!---->' });
      assert.strictEqual(remote.innerHTML, '<i>independent</i>', 'only owned content is removed');
      assert.strictEqual(remote.querySelector('i'), independent, 'independent node survives');
    }

    '@test baseline-green guard: abort preserves remote content of a synchronously rendered independent root'(
      assert: Assert
    ) {
      let remote = document.createElement('div');
      let target = document.createElement('div');
      let Independent = setComponentTemplate(
        precompileTemplate(
          '{{#in-element remote insertBefore=null}}<b>independent</b>{{/in-element}}',
          {
            strictMode: true,
            scope: () => ({ remote }),
          }
        ),
        templateOnly()
      );
      let renderer = BaseRenderer.strict(this.owner, document, {
        isInteractive: true,
        hasDOM: true,
      });
      associateDestroyableChild(this, renderer);
      setRenderer(this.owner, renderer);
      let independent: Element | null = null;
      let renderIndependent = defineSimpleHelper(() => {
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
        independent = remote.querySelector('b');
        return '';
      });
      let boom = defineSimpleHelper(() => {
        throw new Error('outer attempt');
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try>{{renderIndependent}}{{boom}}</:try><:catch>caught</:catch></ErrorBoundary>',
          {
            strictMode: true,
            scope: () => ({ ErrorBoundary, renderIndependent, boom }),
          }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.ok(independent, 'independent root rendered before the abort');
      assert.strictEqual(remote.innerHTML, '<b>independent</b>', 'independent remote survives');
      assert.strictEqual(remote.querySelector('b'), independent, 'same independent node');
    }

    '@test abort clears an outer remote tail after a nested default remote detaches its prefix'(
      assert: Assert
    ) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let remote = document.createElement('div');
      let boom = defineSimpleHelper((failing: unknown) => {
        if (failing) throw new Error('detached remote prefix failure');
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try>{{#in-element remote insertBefore=null}}prefix{{#in-element remote}}inner{{/in-element}}tail{{/in-element}}{{boom state.failing}}</:try><:catch>caught</:catch></ErrorBoundary>',
          { strictMode: true, scope: () => ({ ErrorBoundary, remote, boom, state }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<!---->ok' });
      assert.strictEqual(
        remote.innerHTML,
        'inner<!---->tail',
        'the nested default remote detached the outer prefix before the update'
      );

      this.assertChange({ change: () => (state.failing = true), expect: 'caught' });
      assert.strictEqual(remote.innerHTML, '', 'abort removes all try body remote content');

      runTask(() => this.component!.destroy());
      assert.strictEqual(
        remote.innerHTML,
        '',
        'the destination remains empty after component destruction'
      );
    }

    '@test baseline-green guard: abort of nested remote blocks preserves later independent content'(
      assert: Assert
    ) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let remote = document.createElement('div');
      let boom = defineSimpleHelper((failing: unknown) => {
        if (failing) throw new Error('nested remote failure');
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try>{{#in-element remote insertBefore=null}}<b>outer</b>{{#in-element remote insertBefore=null}}<em>inner</em>{{/in-element}}{{/in-element}}{{boom state.failing}}</:try><:catch>caught</:catch></ErrorBoundary>{{#in-element remote insertBefore=null}}<i>independent</i>{{/in-element}}',
          { strictMode: true, scope: () => ({ ErrorBoundary, remote, boom, state }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<!---->ok<!---->' });
      assert.strictEqual(remote.innerHTML, '<b>outer</b><em>inner</em><!----><i>independent</i>');
      let independent = remote.querySelector('i');
      this.assertChange({ change: () => (state.failing = true), expect: 'caught<!---->' });
      assert.strictEqual(remote.innerHTML, '<i>independent</i>', 'independent content survives');
      assert.strictEqual(
        remote.querySelector('i'),
        independent,
        'the same independent node survives'
      );
    }
  }
);

moduleFor(
  'ErrorBoundary [error-boundary-hardening] review — fallback failures',
  class extends ErrorBoundaryHardeningTestCase {
    '@test an inner fallback throwing during update reaches the outer boundary'(assert: Assert) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let counts = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(counts);
      let fallbackError = new Error('fallback failure');
      let boom = defineSimpleHelper(() => {
        throw fallbackError;
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>before</i><ErrorBoundary><:try><ErrorBoundary><:try><MaybeThrow @shouldThrow={{state.failing}} /></:try><:catch><Child @label="aborted fallback" />{{boom}}</:catch></ErrorBoundary></:try><:catch as |error|>outer caught {{error.message}}</:catch></ErrorBoundary><i>after</i>',
          { strictMode: true, scope: () => ({ ErrorBoundary, MaybeThrow, state, Child, boom }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: '<i>before</i>ok<i>after</i>' });
      let escaped: unknown;
      try {
        runTask(() => (state.failing = true));
      } catch (error) {
        escaped = error;
      }
      assert.strictEqual(escaped, undefined, 'the outer boundary handles the fallback error');
      assertHTML('<i>before</i>outer caught fallback failure<i>after</i>');
      assert.deepEqual(counts, { created: 1, installed: 0, updated: 0, destroyed: 1 });
      assert.false(isInErrorBoundary(), 'abandoned child frames balance the validator depth');
    }

    '@test an uncaught initial fallback aborts its queued lifecycle work'(assert: Assert) {
      let components = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let modifiers = { created: 0, installed: 0, updated: 0, destroyed: 0 };
      let Child = lifecycleComponent(components);
      let modifier = lifecycleModifier(modifiers);
      let fallbackError = new Error('uncaught fallback');
      let boom = defineSimpleHelper(() => {
        throw fallbackError;
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try><Throwing /></:try><:catch><Child @label="aborted" /><div {{modifier}}>aborted</div>{{boom}}</:catch></ErrorBoundary>',
          { strictMode: true, scope: () => ({ ErrorBoundary, Throwing, Child, modifier, boom }) }
        ),
        templateOnly()
      );
      let renderer = BaseRenderer.strict(this.owner, document, {
        isInteractive: true,
        hasDOM: true,
      });
      associateDestroyableChild(this, renderer);
      let target = document.createElement('div');
      let escaped: unknown;
      runTask(() => {
        let { state } = renderer;
        try {
          renderSync(
            state.env,
            renderGlimmerComponent(
              state.context,
              state.builder(state.env, {
                element: target as unknown as SimpleElement,
                nextSibling: null,
              }),
              this.owner,
              Root
            )
          );
        } catch (error) {
          escaped = error;
        }
      });
      assert.strictEqual(escaped, fallbackError, 'the original fallback error escapes');
      assert.deepEqual(
        components,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `an aborted fallback never delivers didCreate: ${JSON.stringify(components)}`
      );
      assert.deepEqual(
        modifiers,
        { created: 1, installed: 0, updated: 0, destroyed: 1 },
        `an aborted fallback never installs its modifier: ${JSON.stringify(modifiers)}`
      );
      assert.false(isInErrorBoundary(), 'the throwing guarded op balances the validator depth');
    }

    '@test a mounted fallback does not catch its own update error'(assert: Assert) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let failures = 0;
      let fallback = defineSimpleHelper((failing: unknown) => {
        // A second invocation succeeds, exposing accidental self-recovery.
        if (failing && failures++ === 0) throw new Error('fallback update');
        return 'inner fallback';
      });
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try><ErrorBoundary><:try><Throwing /></:try><:catch>{{fallback state.failing}}</:catch></ErrorBoundary></:try><:catch as |error|>outer caught {{error.message}}</:catch></ErrorBoundary>',
          { strictMode: true, scope: () => ({ ErrorBoundary, Throwing, fallback, state }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'inner fallback' });
      this.assertChange({
        change: () => (state.failing = true),
        expect: 'outer caught fallback update',
      });
      assert.strictEqual(
        failures,
        1,
        'the failing fallback is not invoked again by its own boundary'
      );
      assert.false(isInErrorBoundary(), 'fallback propagation balances the validator depth');
    }

    '@test an uncaught initial fallback clears a partial remote before destruction'(
      assert: Assert
    ) {
      let remote = document.createElement('div');
      remote.innerHTML = '<i>independent</i>';
      let independent = remote.firstChild;
      let fallbackError = new Error('remote fallback failure');
      let boom = defineSimpleHelper(() => {
        throw fallbackError;
      });
      let Failing = setComponentTemplate(
        precompileTemplate('{{boom}}', { strictMode: true, scope: () => ({ boom }) }),
        templateOnly()
      );
      let Root = setComponentTemplate(
        precompileTemplate(
          '<ErrorBoundary><:try><Throwing /></:try><:catch>{{#in-element remote insertBefore=null}}<b>aborted prefix</b><Failing />{{/in-element}}</:catch></ErrorBoundary>',
          { strictMode: true, scope: () => ({ ErrorBoundary, Throwing, remote, Failing }) }
        ),
        templateOnly()
      );
      let renderer = BaseRenderer.strict(this.owner, document, {
        isInteractive: true,
        hasDOM: true,
      });
      associateDestroyableChild(this, renderer);
      let target = document.createElement('div');
      let escaped: unknown;
      let destructionError: unknown;
      let remoteAtThrow = '';
      try {
        runTask(() => {
          let { state } = renderer;
          try {
            renderSync(
              state.env,
              renderGlimmerComponent(
                state.context,
                state.builder(state.env, {
                  element: target as unknown as SimpleElement,
                  nextSibling: null,
                }),
                this.owner,
                Root
              )
            );
          } catch (error) {
            escaped = error;
            remoteAtThrow = remote.innerHTML;
          }
        });
      } catch (error) {
        destructionError = error;
      }
      assert.strictEqual(escaped, fallbackError, 'the original fallback error escapes');
      assert.strictEqual(
        remoteAtThrow,
        '<i>independent</i>',
        'the failed fallback clears its remote prefix synchronously'
      );
      assert.strictEqual(
        destructionError,
        undefined,
        `deferred remote destruction does not throw: ${String(destructionError)}`
      );
      assert.strictEqual(
        remote.innerHTML,
        '<i>independent</i>',
        'unrelated remote content survives'
      );
      assert.strictEqual(remote.firstChild, independent, 'the unrelated node retains its identity');
      assert.false(isInErrorBoundary(), 'the failed fallback exits its boundary');
    }
  }
);

moduleFor(
  'ErrorBoundary [error-boundary-hardening] review 2 — propagated fallback dependencies',
  class extends ErrorBoundaryHardeningTestCase {
    '@test outer recovery retains dependencies of a fallback failing in handleCaughtError'() {
      this.assertFallbackDependencyRecovery(false);
    }

    '@test outer recovery retains dependencies of a fallback failing in handleException'() {
      this.assertFallbackDependencyRecovery(true);
    }

    /** Repair only a dependency read by the failed fallback, leaving the body broken. */
    assertFallbackDependencyRecovery(automaticRetry: boolean) {
      class State {
        @tracked phase = automaticRetry ? 1 : 0;
        @tracked fallbackFails = false;
      }
      let state = new State();
      let body = defineSimpleHelper((phase: unknown) => {
        if (phase) throw new Error('body failure');
        return 'body';
      });
      let boom = defineSimpleHelper(() => {
        throw new Error('fallback failure');
      });
      let Fallback = setComponentTemplate(
        precompileTemplate(
          '<b>prefix</b>{{#if state.fallbackFails}}{{boom}}{{else}}inner recovered{{/if}}',
          { strictMode: true, scope: () => ({ state, boom }) }
        ),
        templateOnly()
      );
      let Root = setComponentTemplate(
        precompileTemplate(
          '<i>before</i><ErrorBoundary><:try><ErrorBoundary><:try>{{body state.phase}}</:try><:catch><Fallback /></:catch></ErrorBoundary></:try><:catch as |error|>outer caught {{error.message}}</:catch></ErrorBoundary><i>after</i>',
          { strictMode: true, scope: () => ({ ErrorBoundary, state, body, Fallback }) }
        ),
        templateOnly()
      );
      this.renderComponent(Root, {
        expect: automaticRetry
          ? '<i>before</i><b>prefix</b>inner recovered<i>after</i>'
          : '<i>before</i>body<i>after</i>',
      });
      this.assertChange({
        change: () => {
          state.phase = automaticRetry ? 2 : 1;
          state.fallbackFails = true;
        },
        expect: '<i>before</i>outer caught fallback failure<i>after</i>',
      });
      this.assert.false(isInErrorBoundary(), 'propagation balances boundary depth');
      this.assertChange({
        change: () => (state.fallbackFails = false),
        expect: '<i>before</i><b>prefix</b>inner recovered<i>after</i>',
      });
      this.assertChange({
        change: () => (state.phase = 3),
        expect: '<i>before</i><b>prefix</b>inner recovered<i>after</i>',
      });
      this.assert.false(isInErrorBoundary(), 'subsequent recovery balances boundary depth');
    }
  }
);
