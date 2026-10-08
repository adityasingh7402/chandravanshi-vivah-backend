'use strict';

/**
 * Base schema plugin — the conventions every model inherits (spec §5, §30, §40,
 * §68, §103).
 *
 * Applied as `schema.plugin(baseSchema)` so no model can forget them:
 *   - `timestamps: true`      createdAt / updatedAt on every document.
 *   - `versionKey: false`     no `__v` field (§68).
 *   - `strict: true`          unknown paths are dropped, never persisted (§34).
 *   - JSON/object transform   strips `__v` and every path flagged
 *                             `internal: true` before the document leaves the
 *                             server (§30, §40).
 *
 * Mark a field internal at definition time; it will never be serialised:
 *
 *   const schema = new Schema({ passwordHash: { type: String, internal: true } });
 */

const INTERNAL_OPTION = 'internal';

/** Collect the full paths whose schema options set `internal: true`. */
function internalPaths(schema) {
  const paths = [];
  if (!schema || !schema.paths) return paths;
  for (const [path, schemaType] of Object.entries(schema.paths)) {
    if (schemaType && schemaType.options && schemaType.options[INTERNAL_OPTION] === true) {
      paths.push(path);
    }
  }
  return paths;
}

/** Delete a dotted path from a plain object, tolerating missing intermediates. */
function deletePath(target, path) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (node === null || typeof node !== 'object') return;
    node = node[parts[i]];
  }
  if (node !== null && typeof node === 'object') delete node[parts[parts.length - 1]];
}

/**
 * Build the transform used by both `toJSON` and `toObject`.
 *
 * Internal paths are computed at serialisation time (not plugin time) so a
 * field added after `schema.plugin(baseSchema)` is still stripped.
 */
function makeTransform() {
  return function transform(doc, ret) {
    delete ret.__v;
    const schema = (doc && doc.schema) || (doc && doc.constructor && doc.constructor.schema);
    for (const path of internalPaths(schema)) deletePath(ret, path);
    return ret;
  };
}

/**
 * Mark an existing path as internal after the schema is defined.
 * Equivalent to declaring `{ internal: true }` on the path options.
 */
function markInternal(schema, path) {
  const schemaType = schema.path(path);
  if (!schemaType) throw new Error(`markInternal: unknown path "${path}"`);
  schemaType.options[INTERNAL_OPTION] = true;
  return schema;
}

/** Mongoose plugin entry point. */
function baseSchema(schema) {
  schema.set('timestamps', true);
  schema.set('versionKey', false);
  schema.set('strict', true);
  schema.set('strictQuery', true);

  const transform = makeTransform();
  schema.set('toJSON', { virtuals: false, transform });
  schema.set('toObject', { transform });

  return schema;
}

module.exports = { baseSchema, markInternal, internalPaths };
