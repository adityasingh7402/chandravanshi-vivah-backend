'use strict';

/**
 * Express application (spec §110).
 *
 * This module builds and exports the app only — it never binds a port, so tests
 * can import it and listen on an ephemeral port themselves.
 *
 * Middleware order is fixed here and must not be reshuffled:
 *   request id -> logger -> helmet -> CORS -> cookies -> JSON body -> rate limit -> API -> 404 -> error
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const requestId = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const { createRateLimiter } = require('./middleware/rateLimit');
const notFound = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const apiRoutes = require('./routes');

const allowedOrigins = new Set(config.corsOrigins);

const corsOptions = {
  // `origin: false` on a disallowed origin keeps the request flowing but emits
  // no Access-Control-Allow-Origin header (spec §41).
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.has(origin));
  },
  // Step 04: web clients hold the refresh token in an HttpOnly cookie, so the
  // browser must be allowed to send credentials cross-origin. The allowlist is
  // explicit, so no wildcard is ever emitted (spec §41, gate G3.6).
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 600
};

const app = express();

// Do not advertise the server stack (spec §42).
app.disable('x-powered-by');
// Keep IP-based rate limiting honest: only trust the socket address.
app.set('trust proxy', false);
// Strict, spec-compliant query parsing; no nested object parsing.
app.set('query parser', 'simple');

app.use(requestId);
app.use(requestLogger);
app.use(helmet());
app.use(cors(corsOptions));
// Reads the Cookie header only (the refresh token lives in an HttpOnly cookie).
// It is unsigned on purpose: the value is an opaque random token that is
// verified against its hash, not a trusted client assertion.
app.use(cookieParser());
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(createRateLimiter({ name: 'global' }));

app.use(config.apiPrefix, apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
