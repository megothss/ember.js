import Exception from './exception.js';

function validateClose(open, close) {
  close = close.path ? close.path.original : close;

  if (open.path.original !== close) {
    let errorNode = { loc: open.path.loc };

    throw new Exception(open.path.original + " doesn't match " + close, errorNode);
  }
}

export function SourceLocation(source, locInfo) {
  this.source = source;
  this.start = {
    line: locInfo.first_line,
    column: locInfo.first_column,
  };
  this.end = {
    line: locInfo.last_line,
    column: locInfo.last_column,
  };
}

export function id(token) {
  if (/^\[.*\]$/.test(token)) {
    return token.substring(1, token.length - 1);
  } else {
    return token;
  }
}

export function stripFlags(open, close) {
  return {
    open: open.charAt(2) === '~',
    close: close.charAt(close.length - 3) === '~',
  };
}

export function stripComment(comment) {
  return comment.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
}

export function preparePath(data, sexpr, parts, loc) {
  loc = this.locInfo(loc);

  let original;

  if (data) {
    original = '@';
  } else if (sexpr) {
    original = sexpr.original + '.';
  } else {
    original = '';
  }

  let tail = [];
  let depth = 0;

  for (let i = 0, l = parts.length; i < l; i++) {
    let part = parts[i].part;
    // If we have [] syntax then we do not treat path references as operators,
    // i.e. foo.[this] resolves to approximately context.foo['this']
    let isLiteral = parts[i].original !== part;
    let separator = parts[i].separator;

    let partPrefix = separator === '.#' ? '#' : '';

    original += (separator || '') + part;

    if (!isLiteral && (part === '..' || part === '.' || part === 'this')) {
      if (tail.length > 0) {
        throw new Exception('Invalid path: ' + original, { loc });
      } else if (part === '..') {
        depth++;
      }
    } else {
      tail.push(`${partPrefix}${part}`);
    }
  }

  let head = sexpr || tail.shift();

  return {
    type: 'PathExpression',
    this: original.startsWith('this.'),
    data,
    depth,
    head,
    tail,
    parts: head ? [head, ...tail] : tail,
    original,
    loc,
  };
}

export function prepareMustache(path, params, hash, open, strip, locInfo) {
  // Must use charAt to support IE pre-10
  let escapeFlag = open.charAt(3) || open.charAt(2),
    escaped = escapeFlag !== '{' && escapeFlag !== '&';

  let decorator = /\*/.test(open);
  return {
    type: decorator ? 'Decorator' : 'MustacheStatement',
    path,
    params,
    hash,
    escaped,
    strip,
    loc: this.locInfo(locInfo),
  };
}

export function prepareRawBlock(openRawBlock, contents, close, locInfo) {
  validateClose(openRawBlock, close);

  locInfo = this.locInfo(locInfo);
  let program = {
    type: 'Program',
    body: contents,
    strip: {},
    loc: locInfo,
  };

  return {
    type: 'BlockStatement',
    path: openRawBlock.path,
    params: openRawBlock.params,
    hash: openRawBlock.hash,
    program,
    openStrip: {},
    inverseStrip: {},
    closeStrip: {},
    loc: locInfo,
  };
}

export function prepareBlock(openBlock, program, inverseAndProgram, close, inverted, locInfo) {
  if (close && close.path) {
    validateClose(openBlock, close);
  }

  let decorator = /\*/.test(openBlock.open);

  program.blockParams = openBlock.blockParams;

  let inverse, inverseStrip, catchClause;

  if (inverseAndProgram) {
    if (decorator) {
      throw new Exception('Unexpected inverse block on decorator', inverseAndProgram);
    }

    if (inverseAndProgram.chain) {
      inverseAndProgram.program.body[0].closeStrip = close.strip;
    }

    inverseStrip = inverseAndProgram.strip;
    inverse = inverseAndProgram.program;

    if (inverseAndProgram.catch) {
      catchClause = inverseAndProgram.catch;

      if (catchClause.params.length) {
        inverse.blockParams = catchClause.params.map((param) => param.name);
      }
    }
  }

  if (inverted) {
    inverted = inverse;
    inverse = program;
    program = inverted;
  }

  let node = {
    type: decorator ? 'DecoratorBlock' : 'BlockStatement',
    path: openBlock.path,
    params: openBlock.params,
    hash: openBlock.hash,
    program,
    inverse,
    openStrip: openBlock.strip,
    inverseStrip,
    closeStrip: close && close.strip,
    loc: this.locInfo(locInfo),
  };

  if (catchClause) {
    node.catch = catchClause;
  }

  return node;
}

const CATCH_TOKENS = ['CATCH', 'OPEN_CATCH_PARAMS'];

/**
 * Replaces jison's generic "Expecting ..." line for a misplaced `{{catch}}` or
 * block params on a non-block mustache, and defers to jison's own handler for
 * everything else so other messages stay byte-identical.
 */
export function parseError(str, hash) {
  let message;

  if (hash && CATCH_TOKENS.includes(hash.token)) {
    message = hash.expected.includes("'OPEN_ENDBLOCK'")
      ? 'Unexpected {{catch}}: it must directly follow the body of a {{#...}} block, and cannot appear after {{else}}, twice, or in an inverse {{^...}} block'
      : 'Unexpected {{catch}} outside of a block';
  } else if (
    hash &&
    hash.token === 'OPEN_BLOCK_PARAMS' &&
    // Only `CLOSE` is expected right after a block header's own params, so a
    // second `as |...|` group there keeps jison's message.
    !(hash.expected.length === 1 && hash.expected[0] === "'CLOSE'")
  ) {
    message = 'Unexpected block params: "as |...|" is only allowed on block statements';
  }

  if (message) {
    let index = str.lastIndexOf('\nExpecting ');
    str = (index === -1 ? str : str.slice(0, index)) + '\n' + message;
  }

  return Object.getPrototypeOf(this).parseError.call(this, str, hash);
}

export function prepareProgram(statements, loc) {
  if (!loc && statements.length) {
    const firstLoc = statements[0].loc,
      lastLoc = statements[statements.length - 1].loc;

    /* istanbul ignore else */
    if (firstLoc && lastLoc) {
      loc = {
        source: firstLoc.source,
        start: {
          line: firstLoc.start.line,
          column: firstLoc.start.column,
        },
        end: {
          line: lastLoc.end.line,
          column: lastLoc.end.column,
        },
      };
    }
  }

  return {
    type: 'Program',
    body: statements,
    strip: {},
    loc: loc,
  };
}

export function preparePartialBlock(open, program, close, locInfo) {
  validateClose(open, close);

  return {
    type: 'PartialBlockStatement',
    name: open.path,
    params: open.params,
    hash: open.hash,
    program,
    openStrip: open.strip,
    closeStrip: close && close.strip,
    loc: this.locInfo(locInfo),
  };
}
