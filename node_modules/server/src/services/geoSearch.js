'use strict';

/**
 * Distance filter builder (spec §48, §112; step 09 task 4).
 *
 * Two rules:
 *
 *  1. **A radius never leaks a point.** The query uses the stored GeoJSON point
 *     against the `2dsphere` index; the response carries the city name only
 *     (spec §48, §112). Nothing here returns coordinates.
 *  2. **`$geoWithin` / `$centerSphere`, not `$near`.** Both are index-backed by
 *     the same `2dsphere` key, but `$centerSphere` composes with every other
 *     criterion (status, gender, exclusions) and with any sort, whereas `$near`
 *     fixes the result order to distance and has composition restrictions. The
 *     step file allows either; this one keeps the rest of the pipeline intact.
 */

const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');

/** Mean Earth radius in kilometres — the unit `$centerSphere` expects in radians. */
const EARTH_RADIUS_KM = 6378.1;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a `lat`/`lng`/`maxDistanceKm` triple.
 *
 * Returns null when there is no distance search at all (no coordinates given),
 * so a caller can treat "absent" and "invalid" differently — absent is a normal
 * query, invalid is a 400.
 *
 * @param {{lat?: number, lng?: number, maxDistanceKm?: number}} geo
 * @returns {{lat: number, lng: number, maxDistanceKm: number}|null}
 * @throws {BadRequestError} when a coordinate is out of range or only one of the
 *   pair was supplied
 */
function normalizeGeo(geo) {
  if (!geo || (geo.lat === undefined && geo.lng === undefined)) return null;

  if (!isFiniteNumber(geo.lat) || geo.lat < -90 || geo.lat > 90) {
    throw new BadRequestError('Invalid request.', { details: { lat: 'lat must be between -90 and 90.' } });
  }
  if (!isFiniteNumber(geo.lng) || geo.lng < -180 || geo.lng > 180) {
    throw new BadRequestError('Invalid request.', { details: { lng: 'lng must be between -180 and 180.' } });
  }

  const maxDistanceKm = geo.maxDistanceKm === undefined ? config.search.maxDistanceKm : geo.maxDistanceKm;
  if (!isFiniteNumber(maxDistanceKm) || maxDistanceKm <= 0) {
    throw new BadRequestError('Invalid request.', {
      details: { maxDistanceKm: 'maxDistanceKm must be a positive number of kilometres.' }
    });
  }
  if (maxDistanceKm > config.search.maxDistanceKm) {
    // A cap, not a silent shrink: the client is told which bound it crossed.
    throw new BadRequestError('Invalid request.', {
      details: { maxDistanceKm: `maxDistanceKm must be at most ${config.search.maxDistanceKm}.` }
    });
  }

  return { lat: geo.lat, lng: geo.lng, maxDistanceKm };
}

/**
 * The `$geoWithin` clause for a validated triple, or null when there is no
 * distance search. Longitude comes first: MongoDB stores `[lng, lat]`.
 *
 * @param {{lat: number, lng: number, maxDistanceKm: number}} geo
 */
function buildGeoClause(geo) {
  if (!geo) return null;
  const radiusRadians = geo.maxDistanceKm / EARTH_RADIUS_KM;
  return {
    'location.coordinates': {
      $geoWithin: {
        $centerSphere: [[geo.lng, geo.lat], radiusRadians]
      }
    }
  };
}

module.exports = { normalizeGeo, buildGeoClause, EARTH_RADIUS_KM };
