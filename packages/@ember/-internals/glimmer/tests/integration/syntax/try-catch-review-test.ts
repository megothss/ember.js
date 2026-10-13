import { defineSimpleHelper, moduleFor, runTask } from 'internal-test-helpers';
import type { SimpleElement } from '@glimmer/interfaces';
import { DEBUG } from '@glimmer/env';
import { tracked } from '@glimmer/tracking';
import { precompileTemplate } from '@ember/template-compilation';
import templateOnly from '@ember/component/template-only';
import { setComponentTemplate } from '@glimmer/manager';
import { associateDestroyableChild } from '@glimmer/destroyable';
import { renderComponent as renderGlimmerComponent, renderSync } from '@glimmer/runtime';
import {
  getTrackingDepth,
  isInErrorBoundary,
  resetTracking,
} from '@glimmer/validator/lib/tracking';

import { BaseRenderer, setRenderer } from '../../../lib/renderer';
import { TryCatchTestCase } from './try-catch-test';

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] review 3 — propagated fallback dependencies',
  class extends TryCatchTestCase {
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
          '<i>before</i>{{#try}}{{#try}}{{body state.phase}}{{catch as |e r|}}<Fallback />{{/try}}{{catch as |e r|}}outer caught {{e.message}}{{/try}}<i>after</i>',
          { strictMode: true, scope: () => ({ state, body, Fallback }) }
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

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] review',
  class extends TryCatchTestCase {
    /* eslint-disable no-console */
    '@test uncaught append without try retains upstream logging and reset'(assert: Assert) {
      let error = new Error('no boundary append');
      let boom = defineSimpleHelper(() => {
        throw error;
      });
      let Root = setComponentTemplate(
        precompileTemplate('{{boom}}', { strictMode: true, scope: () => ({ boom }) }),
        templateOnly()
      );
      let original = console.error;
      let logs: unknown[][] = [];
      console.error = (...args: unknown[]) => logs.push(args);
      try {
        assert.throws(
          () => this.renderComponent(Root, { expect: 'unreachable' }),
          (caught: unknown) => caught === error,
          'the exact error propagates'
        );
        assert.false(isInErrorBoundary(), 'uncaught append leaves no active boundary');
        if (DEBUG) {
          assert.ok(logs.some(([message]) => String(message).includes('Error occurred:')));
          assert.strictEqual(getTrackingDepth(), 0, 'upstream resetTracking ran');
        }
      } finally {
        console.error = original;
      }
    }

    '@test uncaught update without try retains upstream logging and reset'(assert: Assert) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let error = new Error('no boundary update');
      let boom = defineSimpleHelper((failing: unknown) => {
        if (failing) throw error;
        return 'ok';
      });
      let Root = setComponentTemplate(
        precompileTemplate('{{boom state.failing}}', {
          strictMode: true,
          scope: () => ({ boom, state }),
        }),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'ok' });
      let original = console.error;
      let logs: unknown[][] = [];
      console.error = (...args: unknown[]) => logs.push(args);
      try {
        assert.throws(
          () => runTask(() => (state.failing = true)),
          (caught: unknown) => caught === error,
          'the exact error propagates'
        );
        assert.false(isInErrorBoundary(), 'uncaught update leaves no active boundary');
        if (DEBUG) {
          assert.ok(logs.some(([message]) => String(message).includes('Error occurred:')));
          assert.strictEqual(getTrackingDepth(), 0, 'upstream resetTracking ran');
        }
      } finally {
        console.error = original;
      }
    }
    /* eslint-enable no-console */

    '@test escaped fallback update restores tracking frames in every build'(assert: Assert) {
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let body = defineSimpleHelper(() => {
        throw new Error('body failure');
      });
      let error = new Error('fallback update failure');
      let fallback = defineSimpleHelper((failing: unknown) => {
        if (failing) throw error;
        return 'fallback';
      });
      let Root = setComponentTemplate(
        precompileTemplate('{{#try}}{{body}}{{catch}}{{fallback state.failing}}{{/try}}', {
          strictMode: true,
          scope: () => ({ body, fallback, state }),
        }),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'fallback' });
      let depth = getTrackingDepth();
      try {
        assert.throws(
          () => runTask(() => (state.failing = true)),
          (caught: unknown) => caught === error
        );
        assert.false(isInErrorBoundary(), 'boundary depth is restored');
        assert.strictEqual(getTrackingDepth(), depth, 'no abandoned children tracking frame');
      } finally {
        // Keep an observed leak from affecting later tests.
        resetTracking();
      }
    }

    '@test abort preserves a later independent remote block in the same destination'(
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
          '{{#try}}{{#in-element remote insertBefore=null}}<b>owned</b>{{/in-element}}{{boom state.failing}}{{catch}}caught{{/try}}{{#in-element remote insertBefore=null}}<i>independent</i>{{/in-element}}',
          { strictMode: true, scope: () => ({ remote, boom, state }) }
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

    '@test abort preserves remote content of a synchronously rendered independent root'(
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
        precompileTemplate('{{#try}}{{renderIndependent}}{{boom}}{{catch}}caught{{/try}}', {
          strictMode: true,
          scope: () => ({ renderIndependent, boom }),
        }),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'caught' });
      assert.ok(independent, 'independent root rendered before the abort');
      assert.strictEqual(remote.innerHTML, '<b>independent</b>', 'independent remote survives');
      assert.strictEqual(remote.querySelector('b'), independent, 'same independent node');
    }
  }
);

moduleFor(
  'Syntax: {{#try}} [try-catch-runtime] review 2',
  class extends TryCatchTestCase {
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
          '{{#try}}{{#in-element remote insertBefore=null}}prefix{{#in-element remote}}inner{{/in-element}}tail{{/in-element}}{{boom state.failing}}{{catch}}caught{{/try}}',
          { strictMode: true, scope: () => ({ remote, boom, state }) }
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

    '@test escaped fallback update retains the component name in the DEBUG error log'(
      assert: Assert
    ) {
      if (!DEBUG) {
        assert.ok(true, 'DEBUG logging is disabled in production');
        return;
      }
      class State {
        @tracked failing = false;
      }
      let state = new State();
      let error = new Error('review 2 fallback failure');
      let body = defineSimpleHelper(() => {
        throw new Error('review 2 body failure');
      });
      let fallback = defineSimpleHelper((failing: unknown) => {
        if (failing) throw error;
        return 'fallback';
      });
      let ReviewLogChild = setComponentTemplate(
        precompileTemplate('{{#try}}{{body}}{{catch}}{{fallback state.failing}}{{/try}}', {
          strictMode: true,
          scope: () => ({ body, fallback, state }),
        }),
        templateOnly(undefined, 'ReviewLogChild')
      );
      let Root = setComponentTemplate(
        precompileTemplate('<ReviewLogChild />', {
          strictMode: true,
          scope: () => ({ ReviewLogChild }),
        }),
        templateOnly()
      );
      this.renderComponent(Root, { expect: 'fallback' });
      /* eslint-disable no-console */
      let original = console.error;
      let logs: unknown[][] = [];
      console.error = (...args: unknown[]) => logs.push(args);
      try {
        assert.throws(
          () => runTask(() => (state.failing = true)),
          (caught: unknown) => caught === error,
          'the exact fallback error propagates'
        );
        let log = logs.find(([message]) => String(message).includes('Error occurred:'));
        assert.ok(log, 'the upstream error log is emitted');
        assert.true(
          String(log?.[0]).includes('ReviewLogChild'),
          `the failing component remains in the log: ${String(log?.[0])}`
        );
        assert.strictEqual(getTrackingDepth(), 0, 'tracking is still reset');
      } finally {
        console.error = original;
        resetTracking();
      }
      /* eslint-enable no-console */
    }

    '@test abort of nested remote blocks preserves later independent content'(assert: Assert) {
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
          '{{#try}}{{#in-element remote insertBefore=null}}<b>outer</b>{{#in-element remote insertBefore=null}}<em>inner</em>{{/in-element}}{{/in-element}}{{boom state.failing}}{{catch}}caught{{/try}}{{#in-element remote insertBefore=null}}<i>independent</i>{{/in-element}}',
          { strictMode: true, scope: () => ({ remote, boom, state }) }
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
