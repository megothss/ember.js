import {
  consumeTag,
  createTag,
  dirtyTag,
  track,
  validateTag,
  valueForTag,
} from '@glimmer/validator';
import {
  beginErrorBoundary,
  endErrorBoundary,
  getTrackingDepth,
  isInErrorBoundary,
} from '@glimmer/validator/lib/tracking';

import { module, test } from './-utils';

module('@glimmer/validator [try-catch-runtime] review: boundary tracking scope', () => {
  for (let active of [false, true]) {
    test(`caught inner track exception ${active ? 'inside' : 'outside'} a boundary`, (assert) => {
      let outerTag = createTag();
      let innerTag = createTag();
      let error = new Error('inner track');
      let depth = getTrackingDepth();
      assert.false(isInErrorBoundary(), 'starts outside a boundary');

      if (active) beginErrorBoundary();
      let combined;
      try {
        combined = track(() => {
          consumeTag(outerTag);
          assert.throws(
            () => {
              track(() => {
                consumeTag(innerTag);
                throw error;
              });
            },
            (caught: unknown) => caught === error
          );
        });
      } finally {
        if (active) endErrorBoundary();
      }

      assert.strictEqual(getTrackingDepth(), depth, 'inner exception balances tracking frames');
      assert.false(isInErrorBoundary(), 'restores boundary scope');
      let snapshot = valueForTag(combined);
      dirtyTag(innerTag);
      assert.strictEqual(
        validateTag(combined, snapshot),
        !active,
        'inner tag is forwarded only inside a boundary'
      );
      snapshot = valueForTag(combined);
      dirtyTag(outerTag);
      assert.false(validateTag(combined, snapshot), 'outer frame still consumes its own tag');
    });
  }
});
