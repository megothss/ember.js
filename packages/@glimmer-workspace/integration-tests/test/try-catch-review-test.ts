import { castToBrowser } from '@glimmer/debug-util';
import {
  RehydrationDelegate,
  RenderTest,
  replaceHTML,
  suite,
  test,
} from '@glimmer-workspace/integration-tests';

class TryRehydrationReview extends RenderTest {
  static suiteName = '[try-catch-runtime] review: rehydration';
  declare delegate: RehydrationDelegate;

  @test
  'rehydrates a try body and preserves its server-rendered node'() {
    let template = '<i>before</i>{{#try}}<b>body</b>{{catch}}caught{{/try}}<i>after</i>';
    let html = this.delegate.renderServerSide(template, {}, () => {});
    replaceHTML(this.element, html);
    let element = castToBrowser(this.element, 'HTML');
    let body = element.querySelector('b');
    this.assert.ok(body, 'server rendered body');
    this.renderResult = this.delegate.renderClientSide(template, {}, this.element);
    this.assertHTML('<i>before</i><b>body</b><i>after</i>');
    this.assert.strictEqual(element.querySelector('b'), body, 'server body node is reused');
    this.assert.strictEqual(this.delegate.rehydrationStats.clearedNodes.length, 0);
    this.assertStableRerender();
  }
}

QUnit.module.todo('Rehydration/SSR is unsupported in the {{#try}} spike', () => {
  suite(TryRehydrationReview, RehydrationDelegate);
});
