import assert from 'node:assert/strict';

import { parse, parseWithoutProcessing, print } from '../lib/index.js';
import { equalsAst } from './utils.js';

const MISPLACED =
  'Unexpected {{catch}}: it must directly follow the body of a {{#...}} block, and cannot appear after {{else}}, twice, or in an inverse {{^...}} block';
const OUTSIDE = 'Unexpected {{catch}} outside of a block';
const BLOCK_PARAMS = 'Unexpected block params: "as |...|" is only allowed on block statements';

/** Derive a Jison position from a source offset, including multiline tags. */
function position(source, offset) {
  const prefix = source.slice(0, offset).split('\n');
  return { line: prefix.length, column: prefix.at(-1).length };
}

/** Compare only the source span, leaving the SourceLocation prototype intact. */
function assertSpan(loc, source, start, end) {
  assert.deepEqual(loc.start, position(source, start));
  assert.deepEqual(loc.end, position(source, end));
}

/** Require the delegated diagnostic and Jison's original position display. */
function assertDiagnostic(source, finalLine, clause) {
  assert.throws(
    () => parseWithoutProcessing(source),
    (error) => {
      const lines = error.message.split('\n');
      const offset = clause ? source.lastIndexOf(clause) : source.indexOf('as |');
      assert.equal(lines[0], `Parse error on line ${position(source, offset).line}:`);
      assert.ok(
        lines.slice(1, -1).some((line) => line.includes('^')),
        'position caret'
      );
      assert.ok(
        lines.slice(1, -1).some((line) => line.includes('{{')),
        'source display'
      );
      assert.equal(lines.at(-1), finalLine);
      return true;
    }
  );
}

describe('catch clauses', function () {
  for (const tag of ['{{catch}}', '{{~catch}}', '{{catch~}}', '{{~ catch ~}}']) {
    it(`parses bare ${tag} on an arbitrary block`, function () {
      const source = `{{#ordinary x key=y}}A${tag}B{{/ordinary}}`;
      const block = parseWithoutProcessing(source).body[0];
      assert.ok(Object.hasOwn(block, 'catch'), 'own catch marker');
      assert.equal(block.path.original, 'ordinary');
      assert.equal(block.params[0].original, 'x');
      assert.equal(block.hash.pairs[0].key, 'key');
      assert.deepEqual(
        block.program.body.map((node) => node.value),
        ['A']
      );
      assert.equal(block.inverse.type, 'Program');
      assert.deepEqual(
        block.inverse.body.map((node) => node.value),
        ['B']
      );
      assert.deepEqual(block.catch.params, []);
      assert.equal(block.inverse.blockParams, undefined);
      const start = source.indexOf(tag);
      assertSpan(block.catch.loc, source, start, start + tag.length);
      assert.deepEqual(
        block.inverseStrip,
        parseWithoutProcessing(source.replace(tag, tag.replace('catch', 'else'))).body[0]
          .inverseStrip
      );
    });
  }

  for (const [tag, names] of [
    ['{{catch as |e|}}', ['e']],
    ['{{catch as |e r|}}', ['e', 'r']],
    ['{{~catch as |e r|~}}', ['e', 'r']],
  ]) {
    it(`parses params in ${tag}`, function () {
      const source = `{{#foo}}A${tag}B{{/foo}}`;
      const block = parseWithoutProcessing(source, { srcName: 'catch.hbs' }).body[0];
      assert.deepEqual(
        block.program.body.map((node) => node.value),
        ['A']
      );
      assert.equal(block.inverse.type, 'Program');
      assert.deepEqual(
        block.inverse.body.map((node) => node.value),
        ['B']
      );
      assert.deepEqual(block.inverse.blockParams, names);
      assert.deepEqual(
        block.catch.params.map((param) => param.name),
        names
      );
      const start = source.indexOf(tag);
      assertSpan(block.catch.loc, source, start, start + tag.length);
      assert.equal(block.catch.loc.source, 'catch.hbs');
      let cursor = source.indexOf('|', start) + 1;
      for (const param of block.catch.params) {
        const offset = source.indexOf(param.name, cursor);
        assertSpan(param.loc, source, offset, offset + param.name.length);
        assert.equal(param.loc.source, 'catch.hbs');
        cursor = offset + param.name.length;
      }
      assert.deepEqual(block.inverseStrip, {
        open: tag.startsWith('{{~'),
        close: tag.endsWith('~}}'),
      });
    });
  }

  it('locates multiline params after identical names in the main body', function () {
    const source =
      '{{#foo error retry=error}}\nerror retry\n{{~catch as |\n error retry\n|~}}B{{/foo}}';
    const block = parseWithoutProcessing(source).body[0];
    const tagStart = source.indexOf('{{~catch');
    const tagEnd = source.indexOf('}}', tagStart) + 2;
    assertSpan(block.catch.loc, source, tagStart, tagEnd);
    assert.deepEqual(block.inverse.blockParams, ['error', 'retry']);
    for (const param of block.catch.params) {
      const offset = source.indexOf(param.name, source.indexOf('|', tagStart));
      assertSpan(param.loc, source, offset, offset + param.name.length);
    }
  });

  it('keeps nested catches attached to their own blocks', function () {
    const source = '{{#foo}}{{#bar}}A{{catch}}B{{/bar}}{{catch as |e|}}C{{/foo}}';
    const outer = parseWithoutProcessing(source).body[0];
    const inner = outer.program.body[0];
    assert.equal(inner.path.original, 'bar');
    assert.deepEqual(inner.catch.params, []);
    assert.equal(inner.inverse.body[0].value, 'B');
    assert.deepEqual(
      outer.catch.params.map((param) => param.name),
      ['e']
    );
    assert.equal(outer.inverse.body[0].value, 'C');
  });

  for (const tag of ['{{catch}}', '{{catch as |e r|}}']) {
    it(`strips standalone ${tag} exactly like else`, function () {
      const source = `before\n{{#foo}}\n  A\n  ${tag}\n  B\n{{/foo}}\nafter`;
      const actual = parse(source);
      const expected = parse(source.replace(tag, '{{else}}'));
      assert.deepEqual(actual.body[1].program.body, expected.body[1].program.body);
      assert.deepEqual(
        actual.body[1].inverse.body.map(({ value }) => value),
        expected.body[1].inverse.body.map(({ value }) => value)
      );
      assert.equal(actual.body[0].value, expected.body[0].value);
      assert.equal(actual.body[2].value, expected.body[2].value);
      assert.equal(actual.body[1].program.body[0].value, '  A\n');
      assert.equal(actual.body[1].inverse.body[0].value, '  B\n');
      const raw = parseWithoutProcessing(source);
      assert.equal(raw.body[1].program.body[0].value, '\n  A\n  ');
      assert.equal(raw.body[1].inverse.body[0].value, '\n  B\n');
    });
  }

  for (const tag of ['{{~catch}}', '{{catch~}}', '{{~catch~}}', '{{~catch as |e r|~}}']) {
    it(`applies whitespace control for ${tag}`, function () {
      const source = `{{#foo}} A \n ${tag} \n B {{/foo}}`;
      const block = parse(source).body[0];
      const elseTag = tag.includes('as |') ? '{{~else~}}' : tag.replace('catch', 'else');
      const expected = parse(source.replace(tag, elseTag)).body[0];
      assert.deepEqual(block.inverseStrip, expected.inverseStrip);
      assert.deepEqual(
        block.program.body.map(({ value }) => value),
        expected.program.body.map(({ value }) => value)
      );
      assert.deepEqual(
        block.inverse.body.map(({ value }) => value),
        expected.inverse.body.map(({ value }) => value)
      );
    });
  }

  it('prints the catch header and inverse block params', function () {
    equalsAst(
      '{{#foo}} bar {{catch}} baz {{/foo}}',
      "BLOCK:\n  p%foo\n  PROGRAM:\n    CONTENT[ ' bar ' ]\n  {{catch}}\n    CONTENT[ ' baz ' ]"
    );
    equalsAst(
      '{{#foo}} bar {{catch as |e r|}} baz {{/foo}}',
      "BLOCK:\n  p%foo\n  PROGRAM:\n    CONTENT[ ' bar ' ]\n  {{catch}}\n    BLOCK PARAMS: [ e r ]\n    CONTENT[ ' baz ' ]"
    );
    equalsAst('{{#foo}}{{catch}}{{/foo}}', 'BLOCK:\n  p%foo\n  PROGRAM:\n  {{catch}}');
  });
});

describe('catch diagnostics', function () {
  it('rejects an else or else-if chain following catch', function () {
    for (const tag of ['{{else}}', '{{else if bar}}']) {
      assert.throws(
        () => parseWithoutProcessing(`{{#foo}}A{{catch}}B${tag}C{{/foo}}`),
        /^Error: Parse error on line 1:/
      );
    }
  });

  const misplaced = [
    ['after else', '{{#foo}}A{{else}}B', '{{/foo}}'],
    ['after else if', '{{#foo}}A{{else if bar}}B', '{{/foo}}'],
    ['after an else-if chain', '{{#foo}}A{{else if bar}}B{{else}}C', '{{/foo}}'],
    ['a second catch', '{{#foo}}A{{catch}}B', '{{/foo}}'],
    ['in an inverse block', '{{^foo}}A', '{{/foo}}'],
    ['in a partial block', '{{#> partial}}A', '{{/partial}}'],
  ];
  for (const [name, before, after] of misplaced) {
    for (const tag of ['{{catch}}', '{{catch as |e r|}}']) {
      it(`rejects ${tag} ${name} with M1`, function () {
        assertDiagnostic(`${before}\n${tag}${after}`, MISPLACED, tag);
      });
    }
  }
  for (const [name, before, after] of [
    ['at top level', '', ''],
    ['in an HTML comment', '<!-- ', ' -->'],
    ['in an attribute', '<div class="', '"></div>'],
  ]) {
    for (const tag of ['{{catch}}', '{{catch as |e r|}}']) {
      it(`rejects ${tag} ${name} with M2`, function () {
        assertDiagnostic(`${before}${tag}${after}`, OUTSIDE, tag);
      });
    }
  }
  for (const source of ['{{foo as |x|}}', '{{foo bar as |x|}}']) {
    it(`rejects non-block params in ${source} with M3`, function () {
      assertDiagnostic(source, BLOCK_PARAMS);
    });
  }
});

describe('catch baseline-green guards', function () {
  it('keeps catch-prefixed expressions as plain mustaches everywhere', function () {
    const sources = [
      '{{catchAll}}',
      '{{catch-me}}',
      '{{catch x}}',
      '{{catch.x}}',
      '{{this.catch}}',
      '{{catch as}}',
    ];
    for (const source of sources) {
      const top = parseWithoutProcessing(source).body[0];
      const block = parseWithoutProcessing(`{{#foo}}${source}{{/foo}}`).body[0];
      assert.equal(top.type, 'MustacheStatement');
      const [path, ...params] = source.slice(2, -2).split(' ');
      assert.equal(top.path.original, path);
      assert.deepEqual(
        top.params.map(({ original }) => original),
        params
      );
      assert.equal(block.program.body[0].type, 'MustacheStatement');
      assert.equal(block.program.body[0].path.original, top.path.original);
      assert.deepEqual(
        block.program.body[0].params.map(({ original }) => original),
        top.params.map(({ original }) => original)
      );
      assert.equal(block.inverse, undefined);
      assert.equal(Object.hasOwn(block, 'catch'), false);
    }
  });

  it('leaves ordinary blocks and else chains unmarked and printing unchanged', function () {
    for (const source of [
      '{{#foo}}A{{/foo}}',
      '{{#foo}}A{{else}}B{{/foo}}',
      '{{#foo}}A{{else if bar}}B{{else}}C{{/foo}}',
      '{{^foo}}A{{/foo}}',
    ]) {
      const block = parse(source).body[0];
      assert.equal(Object.hasOwn(block, 'catch'), false);
      if (block.inverse?.chained) {
        assert.equal(Object.hasOwn(block.inverse.body[0], 'catch'), false);
      }
      assert.equal(print(parseWithoutProcessing(source)), print(parse(source)));
    }
    equalsAst(
      '{{#foo}}A{{else}}B{{/foo}}',
      "BLOCK:\n  p%foo\n  PROGRAM:\n    CONTENT[ 'A' ]\n  {{^}}\n    CONTENT[ 'B' ]"
    );
    equalsAst(
      '{{#foo}} bar {{else if bar}}{{else}} baz {{/foo}}',
      "BLOCK:\n  p%foo\n  PROGRAM:\n    CONTENT[ ' bar ' ]\n  {{^}}\n    BLOCK:\n      p%if [p%bar]\n      PROGRAM:\n      {{^}}\n        CONTENT[ ' baz ' ]"
    );
  });

  it('keeps catch inside a Handlebars comment inert', function () {
    const ast = parse('{{!-- {{catch}} --}}');
    assert.equal(ast.body[0].type, 'CommentStatement');
    assert.equal(ast.body[0].value, ' {{catch}} ');
  });

  it('preserves the baseline lexer error byte-for-byte', function () {
    assert.throws(
      () => parseWithoutProcessing('\u0000'),
      (error) => {
        assert.equal(error.message, 'Lexical error on line 1. Unrecognized text.\n\u0000\n^');
        return true;
      }
    );
  });

  it('preserves the baseline hash-value parse error byte-for-byte', function () {
    assert.throws(
      () => parseWithoutProcessing('{{foo bar=}}'),
      (error) => {
        assert.equal(
          error.message,
          "Parse error on line 1:\n{{foo bar=}}\n----------^\nExpecting 'OPEN_SEXPR', 'ID', 'OPEN_ARRAY', 'STRING', 'NUMBER', 'BOOLEAN', 'UNDEFINED', 'NULL', 'DATA', got 'CLOSE'"
        );
        return true;
      }
    );
  });
});

describe('catch review: diagnostic delegation', function () {
  for (const [name, source] of [
    ['ordinary block header', '{{#foo x=1 as |a| as |b|}}{{/foo}}'],
    ['catch header', '{{#try}}{{catch as |e| as |r|}}{{/try}}'],
  ]) {
    it(`delegates duplicate block-param errors in the ${name}`, function () {
      assert.throws(
        () => parseWithoutProcessing(source),
        (error) => {
          assert.equal(error.hash.token, 'OPEN_BLOCK_PARAMS');
          assert.deepEqual(error.hash.expected, ["'CLOSE'"]);
          assert.equal(
            error.message.split('\n').at(-1),
            "Expecting 'CLOSE', got 'OPEN_BLOCK_PARAMS'",
            'a duplicate param group inside a block header must retain the Jison diagnostic'
          );
          return true;
        }
      );
    });
  }
});
