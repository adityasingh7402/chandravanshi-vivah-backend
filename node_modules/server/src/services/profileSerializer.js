'use strict';

/**
 * Profile DTOs (spec §30, §51, §59, §70, §71; step 06 tasks 9 and 13).
 *
 * §59 is explicit: *"The same database document should not simply be returned
 * for all five cases."* Each function below builds its own plain object by
 * naming every field it returns — **never a spread of the document** — so a
 * field that is not listed here cannot leak by accident.
 *
 * ---------------------------------------------------------------------------
 * RESTRICTED (fields dictionary §26, spec §30, §112) — never in card/public:
 *
 *   email, phone          — they live on `users`, and no profile DTO reads them
 *   coordinates           — server-side proximity only
 *   birthTime, birthPlace — exact birth details are restricted
 *   identity data         — verification documents, admin notes, audit data
 *
 * The owner's own DTO *does* include their own coordinates and birth details:
 * restricted means "restricted to someone", not "hidden from everybody".
 * ---------------------------------------------------------------------------
 */

const { PROFILE_STATUS } = require('../constants/profile');

/** Age is derived at read time and never stored (spec §47). */
function computeAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const month = now.getMonth() - dob.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

/** Centimetres -> `5'9"`, as the fields dictionary requires (§3.9). */
function heightDisplay(heightCm) {
  if (heightCm === null || heightCm === undefined || Number.isNaN(Number(heightCm))) return null;
  const totalInches = Math.round(Number(heightCm) / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}'${inches}"`;
}

function heightOf(basic) {
  const cm = basic && basic.heightCm;
  return { cm: cm ?? null, display: heightDisplay(cm) };
}

/** Null-safe copy of a section — a plain object, never a Mongoose sub-doc. */
function section(document, key, fields) {
  const source = document[key] || {};
  const out = {};
  for (const field of fields) out[field] = source[field] === undefined ? null : source[field];
  return out;
}

const BASIC_FIELDS = ['profileFor', 'firstName', 'middleName', 'lastName', 'gender', 'dateOfBirth', 'maritalStatus'];
const COMMUNITY_FIELDS = [
  'communityId', 'subCommunityId', 'surnameId', 'surnameName', 'gotraId', 'gotraName',
  'clanId', 'clanName', 'aaspadId', 'aaspadName', 'motherTongueId', 'motherTongueName', 'religion'
];
const LOCATION_FIELDS = ['countryId', 'stateId', 'districtId', 'cityId', 'countryName', 'stateName', 'districtName', 'cityName'];
const EDUCATION_FIELDS = [
  'highestQualificationId', 'degreeId', 'degreeName', 'specializationId', 'specializationName',
  'collegeId', 'universityId', 'universityName', 'graduationYear'
];
const CAREER_FIELDS = [
  'occupationId', 'occupationName', 'industryId', 'industryName', 'employmentType',
  'company', 'designation', 'workLocation', 'experienceYears', 'incomeRange'
];
const FAMILY_FIELDS = [
  'familyType', 'familyStatus', 'fatherOccupation', 'motherOccupation',
  'brothersCount', 'marriedBrothersCount', 'sistersCount', 'marriedSistersCount', 'familyLocation'
];
const LIFESTYLE_FIELDS = ['diet', 'dietOther', 'smoking', 'drinking', 'fitness', 'pets'];
const MARRIAGE_FIELDS = ['hasChildren', 'childrenCount', 'wantsChildren'];
const ABOUT_FIELDS = ['headline', 'description'];

function idsOf(personal, key) {
  const value = personal && personal[key];
  return Array.isArray(value) ? value.map((id) => String(id)) : [];
}

/** Horoscope fields that are safe to show anyone (no birth time/place). */
function publicHoroscope(document) {
  const source = document.horoscope || {};
  return {
    available: source.available ?? false,
    rashi: source.rashi ?? null,
    nakshatra: source.nakshatra ?? null,
    manglik: source.manglik ?? null
  };
}

/**
 * The owner's view: everything they entered, including their own restricted
 * coordinates and birth details (spec §59 "Own profile").
 */
function ownProfile(document) {
  const basic = document.basic || {};
  const location = document.location || {};
  const profile = document.profile || {};
  const personal = document.personal || {};
  const horoscope = document.horoscope || {};

  return {
    publicProfileId: document.publicProfileId,
    userId: String(document.userId),
    status: profile.status,
    completionPercentage: profile.completionPercentage ?? 0,
    isVerified: profile.isVerified === true,
    lastActiveAt: profile.lastActiveAt || null,
    age: computeAge(basic.dateOfBirth),
    height: heightOf(basic),
    basic: { ...section(document, 'basic', BASIC_FIELDS), heightCm: basic.heightCm ?? null },
    community: section(document, 'community', COMMUNITY_FIELDS),
    location: {
      ...section(document, 'location', LOCATION_FIELDS),
      // Own view only — a proximity search runs server-side (spec §48, §112).
      coordinates: location.coordinates ? { ...location.coordinates } : null
    },
    education: section(document, 'education', EDUCATION_FIELDS),
    career: section(document, 'career', CAREER_FIELDS),
    family: section(document, 'family', FAMILY_FIELDS),
    lifestyle: section(document, 'lifestyle', LIFESTYLE_FIELDS),
    personal: {
      hobbies: idsOf(personal, 'hobbies'),
      interests: idsOf(personal, 'interests'),
      languages: idsOf(personal, 'languages')
    },
    horoscope: {
      ...publicHoroscope(document),
      birthTime: horoscope.birthTime || null,
      birthPlace: horoscope.birthPlace || null
    },
    marriage: section(document, 'marriage', MARRIAGE_FIELDS),
    about: section(document, 'about', ABOUT_FIELDS),
    createdAt: document.createdAt || null,
    updatedAt: document.updatedAt || null
  };
}

/**
 * The Discover card — the §70 field subset and nothing more. Its whole purpose
 * is to be small, so it is the strictest of the three (spec §82 anti-pattern 2).
 */
function discoveryCard(document, options = {}) {
  const basic = document.basic || {};
  const location = document.location || {};
  const education = document.education || {};
  const career = document.career || {};
  const community = document.community || {};
  const profile = document.profile || {};

  return {
    profileId: document.publicProfileId,
    name: basic.firstName || null,
    age: computeAge(basic.dateOfBirth),
    height: heightDisplay(basic.heightCm),
    city: location.cityName || null,
    degree: education.degreeName || null,
    occupation: career.occupationName || null,
    surname: community.surnameName || null,
    gotra: community.gotraName || null,
    verified: profile.isVerified === true,
    // The single approved, primary card variant (spec §18): a small transformed
    // URL, no join, and `null` when there is nothing eligible to show. An
    // unmoderated or non-primary photo never reaches a discovery card (§101).
    primaryPhoto: options.primaryPhoto || null,
    lastActiveAt: profile.lastActiveAt || null
  };
}

/**
 * Another user's permitted view — the §71 sections, minus every restricted
 * field listed at the top of this file. Photos arrive with step 08.
 *
 * Hobby/interest/language labels are intentionally NOT resolved here: that
 * would need a populate chain (spec §66 anti-pattern). Clients hold the master
 * lists in their own cache (spec §32, §60) and map the ids themselves.
 */
function publicProfile(document, options = {}) {
  const basic = document.basic || {};
  const profile = document.profile || {};

  return {
    publicProfileId: document.publicProfileId,
    isVerified: profile.isVerified === true,
    lastActiveAt: profile.lastActiveAt || null,
    age: computeAge(basic.dateOfBirth),
    height: heightOf(basic),
    basic: section(document, 'basic', BASIC_FIELDS),
    community: section(document, 'community', COMMUNITY_FIELDS),
    // Names only — `coordinates` deliberately absent.
    location: section(document, 'location', LOCATION_FIELDS),
    education: section(document, 'education', EDUCATION_FIELDS),
    career: section(document, 'career', CAREER_FIELDS),
    family: section(document, 'family', FAMILY_FIELDS),
    lifestyle: section(document, 'lifestyle', LIFESTYLE_FIELDS),
    personal: {
      hobbies: idsOf(document.personal, 'hobbies'),
      interests: idsOf(document.personal, 'interests'),
      languages: idsOf(document.personal, 'languages')
    },
    about: section(document, 'about', ABOUT_FIELDS),
    horoscope: publicHoroscope(document),
    marriage: section(document, 'marriage', MARRIAGE_FIELDS),
    // Relationship-filtered by `photoService.listForViewer` before it gets here:
    // `private` / `matches_only` are already gone for a non-match viewer, and
    // every entry carries transformation URLs rather than the original asset
    // (spec §18, §112). A Kundli document is never part of this list — it is a
    // different collection with its own route (decisions §6, gate G3.8).
    photos: options.photos || [],
    // `location.cityName` is exposed above; nothing outside these keys is sent.
    active: profile.status === PROFILE_STATUS.ACTIVE
  };
}

module.exports = { ownProfile, discoveryCard, publicProfile, computeAge, heightDisplay };
