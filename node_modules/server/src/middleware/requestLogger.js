'use strict';

const pino = require('pino');
const pinoHttp = require('pino-http');
const config = require('../config/env');

/**
 * Request logging (spec §78).
 *
 * Spec §78 is an allowlist, not a blacklist: log method, route, status,
 * duration and the correlation id — nothing else. The serializers live on the
 * pino instance itself (pino-http ignores `opts.serializers` when it is handed
 * an existing logger), so headers, query strings, params, bodies and remote
 * addresses never reach the log stream.
 */

/** Strip anything that could carry a secret out of a free-text log value. */
function sanitize(text) {
  if (text === undefined || text === null) return text;
  return String(text)
    // connection strings carry credentials
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://[redacted]')
    .replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://[redacted]')
    // key=value / token=value pairs
    .replace(
      /\b(password|passwd|secret|token|jwt|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S+/gi,
      '$1=[redacted]'
    );
}

/** Route path without the query string — queries may contain user input. */
function routeOf(req) {
  if (req && req.route && typeof req.route.path === 'string') {
    const base = req.baseUrl || '';
    const sub = req.route.path === '/' ? '' : req.route.path;
    const joined = `${base}${sub}`;
    if (joined) return joined;
  }
  const url = (req && (req.originalUrl || req.url)) || '';
  return url.split('?')[0] || '/';
}

const logger = pino({
  level: config.logLevel,
  base: { service: 'chandravanshi-vivah-api', env: config.nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Defence in depth: even if a future call site logs one of these fields
  // explicitly, the value is censored.
  redact: {
    paths: [
      'req.headers',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'secret',
      '*.secret',
      'token',
      '*.token',
      'accessToken',
      'refreshToken'
    ],
    censor: '[redacted]'
  }
});

const requestLogger = pinoHttp({
  logger,
  // NOTE: these serializers must be passed to pino-http, not to pino().
  // pino-http builds a child logger from these options and that child's
  // serializers win over the parent's, so placing them on the pino instance
  // silently falls back to pino-std-serializers and logs every header.
  serializers: {
    // Allowlist: only these attributes are ever serialised (spec §78).
    req: (req) => ({
      id: req.id,
      method: req.method,
      route: routeOf(req)
    }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: (err) => ({
      type: err.type,
      message: sanitize(err.message),
      statusCode: err.statusCode
    })
  },
  // Reuse the id set by middleware/requestId.js so both surfaces agree.
  genReqId: (req) => req.id,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${routeOf(req)} ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${routeOf(req)} ${res.statusCode} ${sanitize(err && err.message)}`,
  customProps: (req) => ({ reqId: req.id, route: routeOf(req) })
});

module.exports = { logger, requestLogger, sanitize, routeOf };
