'use strict'

/*
 * Formula parsing and evaluation.
 *
 * Expressions are parsed by expr-eval-fork, which evaluates a token stream
 * and never hands text to the JavaScript engine. The parser is configured
 * for arithmetic only: the language features that are not needed to turn a
 * few numbers into one number are switched off, so a formula cannot assign,
 * define functions, build arrays, join strings or reach into objects. Its
 * result is published only when it is a finite number.
 */

const { Parser } = require('expr-eval-fork')

// A short name stands for a path inside an expression. Paths themselves
// cannot be used: they contain dots and dashes, which are operators.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function createParser () {
  const parser = new Parser({
    allowMemberAccess: false,
    operators: {
      assignment: false,
      fndef: false,
      array: false,
      concatenate: false,
      in: false,
      factorial: false
    }
  })

  // These built-ins work on arrays or strings, which the grammar above can
  // no longer produce. Removing them keeps the documented function list
  // honest. `random` goes too: a published value should be reproducible
  // from its inputs.
  for (const name of ['map', 'fold', 'filter', 'indexOf', 'join', 'sum', 'random', 'fac', 'gamma']) {
    delete parser.functions[name]
  }
  delete parser.unaryOps.length

  return parser
}

const parser = createParser()

/**
 * Puts a parse error of the expression library into words a user can act
 * on. The library names its own token types ("unexpected TEOF: EOF",
 * "unexpected TOP: *"), which say nothing to someone writing a formula. A
 * message not recognised here is passed on as the library wrote it.
 *
 * Where the library gives a position ("[1:9]"), it is the column just after
 * the token it could not use, so the token is found by reading back from
 * there in the expression.
 */
function explainParseError (message, expression) {
  const text = String(message || '')
  const source = typeof expression === 'string' ? expression : ''
  const at = /\[\d+:(\d+)\]/.exec(text)
  // The token just before the library's position, with its own column.
  let token = null
  if (at && source) {
    const end = Number(at[1]) - 2
    if (end >= 0 && end < source.length) {
      let start = end
      if (/[\w.]/.test(source[end])) while (start > 0 && /[\w.]/.test(source[start - 1])) start--
      token = { text: source.slice(start, end + 1), column: start + 1 }
    }
  }
  const where = at ? ` at character ${at[1]}` : ''
  if (/unexpected TEOF/.test(text)) {
    const open = (source.match(/\(/g) || []).length - (source.match(/\)/g) || []).length
    if (open > 0 && !/[-+*/%^,(?:<>=!]\s*$/.test(source)) return 'a closing bracket is missing at the end'
    return 'it ends too soon, after an operator, a comma or an opening bracket'
  }
  if (/unexpected TPAREN/.test(text)) return 'a ")" comes where a value belongs: the brackets hold nothing, or a value is missing before it'
  if (/unexpected TCOMMA/.test(text)) return 'a "," comes where a value belongs: a value is missing before it'
  const operator = /unexpected TOP: (.+)$/.exec(text)
  if (operator) return `"${operator[1].trim()}" is out of place; an operator needs a value on each side`
  if (/Expected \)/.test(text)) {
    // The library stops after the last token when the expression ends
    // inside a bracket.
    if (!token || token.column + token.text.length > source.trimEnd().length) return 'a closing bracket is missing at the end'
    if (token.text === ',') return `the comma at character ${token.column} is not inside a function's brackets; a comma separates the values of a function, as in max(a, b)`
    return `"${token.text}" at character ${token.column} is out of place; a closing bracket, or an operator before it, is missing`
  }
  if (/Expected :/.test(text)) return '"?" needs ":" and a second value, as in condition ? a : b'
  if (/Expected EOF/.test(text)) {
    if (token && token.text === ')') return `the ")" at character ${token.column} has no opening bracket`
    if (token) return `"${token.text}" at character ${token.column} is left over; two values need an operator between them`
    return 'something is left over; two values need an operator between them'
  }
  const character = /Unknown character "(.)"/.exec(text)
  if (character) {
    const instead = { '=': '; compare with ==, !=, >= or <=', '!': '; write not, or != to compare', '&': '; write and', '|': '; write or' }[character[1]] || ''
    return `"${character[1]}" cannot be used${where}${instead}`
  }
  if (/member access is not permitted/.test(text)) return 'a path cannot be written in the expression; add it as an input and use its short name'
  return text
}

// Words the parser already gives a meaning to. An input may not take one of
// these as its short name, because the built-in would win silently.
const RESERVED = new Set([
  ...Object.keys(parser.functions),
  ...Object.keys(parser.unaryOps),
  ...Object.keys(parser.consts),
  'and',
  'or',
  'not',
  'in'
])

/**
 * Reports whether a short name can be used for an input.
 * Returns an error message, or null when the name is acceptable.
 */
function checkName (name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return `"${name}" is not a valid short name: use letters, digits and underscores, not starting with a digit`
  }
  // Names every JavaScript object carries, such as "constructor" and
  // "toString", are refused too: the parser guards against them, so a
  // formula using one would never produce a value.
  if (RESERVED.has(name) || name in {}) {
    return `"${name}" is a built-in name and cannot be used as a short name`
  }
  if (name.startsWith('__')) {
    return `"${name}" is not a valid short name: it may not start with two underscores`
  }
  return null
}

/**
 * Compiles an expression over a known set of input names.
 *
 * Compilation fails early, with a message fit for the plugin status, when
 * the expression does not parse or mentions a name that is not an input.
 * Catching that at start-up is better than a formula that silently never
 * produces a value.
 *
 * @param {string} expression
 * @param {string[]} names - Short names of the entry's inputs.
 * @returns {{evaluate: function(object): (number|null), variables: string[]}}
 */
function compileFormula (expression, names) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('the expression is empty')
  }

  let parsed
  try {
    parsed = parser.parse(expression)
  } catch (err) {
    throw new Error(`the expression does not parse: ${explainParseError(err.message, expression)}`)
  }

  // Every name in the expression must be an input, a function from the
  // documented list or a constant. The token stream is walked rather than
  // relying on symbols(), which leaves out a name written as a call: the
  // library takes any name that every JavaScript object carries, such as
  // "toString" or "isPrototypeOf", for an operator at parse time, and such
  // a formula would otherwise be accepted and give nonsense or nothing.
  const known = new Set(names)
  const functions = new Set(availableFunctions())
  const unknown = []
  const note = (name) => { if (!unknown.includes(name)) unknown.push(name) }
  const walk = (tokens) => {
    for (const token of tokens) {
      const { type, value } = token
      if (type === 'IEXPR') {
        walk(value)
      } else if (type === 'IVAR' || type === 'IVARNAME') {
        if (!known.has(value) && !functions.has(value) && !Object.hasOwn(parser.consts, value)) note(value)
      } else if (type === 'IOP1' || type === 'IOP2' || type === 'IOP3') {
        const table = type === 'IOP1' ? parser.unaryOps : type === 'IOP2' ? parser.binaryOps : parser.ternaryOps
        if (!Object.hasOwn(table, value)) note(String(value))
      } else if (type === 'IENDSTATEMENT') {
        // A semicolon separates statements, and the last one gives the
        // result. With assignment switched off it can do nothing harmful,
        // and earlier versions accepted it, so saved formulas keep working.
      } else if (type !== 'INUMBER' && type !== 'IFUNCALL' && type !== 'ISTRING') {
        // Nothing else can come out of the grammar configured above. The
        // token's kind is named, since its value may say nothing.
        note(`${type} ${String(value)}`)
      }
    }
  }
  walk(parsed.tokens)
  const variables = parsed.variables().filter((name) => known.has(name))
  if (unknown.length > 0) {
    throw new Error(`the expression uses ${unknown.map((n) => `"${n}"`).join(', ')}, which is not an input or a built-in function`)
  }

  return {
    variables,
    /**
     * Evaluates the expression. Returns a finite number, or null when the
     * result cannot be published: division by zero, the square root of a
     * negative number, or anything that is not a number.
     */
    evaluate (values) {
      let result
      try {
        result = parsed.evaluate(values)
      } catch (err) {
        return null
      }
      // A bare comparison such as `a > b` yields true or false. Signal K
      // consumers chart numbers, so the result is published as 1 or 0.
      if (typeof result === 'boolean') return result ? 1 : 0
      if (typeof result === 'number' && Number.isFinite(result)) return result
      return null
    }
  }
}

/**
 * Lists the functions an expression may call, for documentation and tests.
 */
function availableFunctions () {
  return [...Object.keys(parser.functions), ...Object.keys(parser.unaryOps).filter((n) => NAME_PATTERN.test(n))].sort()
}

module.exports = { NAME_PATTERN, availableFunctions, checkName, compileFormula, explainParseError }
