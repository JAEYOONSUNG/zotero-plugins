/* Pure library metadata model, shared by Zotero and Node tests. */
(function (root, factory) {
  "use strict";
  const model = factory();
  root.ZoteroFocusModel = model;
  if (typeof module === "object" && module && module.exports) {
    module.exports = model;
  }
})(globalThis, function () {
  "use strict";

  const STATUS_PREFIX = "zotero-focus:status:";
  const RATING_PREFIX = "zotero-focus:rating:";
  const statusOrder = new Map([["unread", 0], ["reading", 1], ["done", 2]]);

  function validateTags(tags) {
    if (!Array.isArray(tags)) throw new TypeError("Tags must be an array");
    for (const entry of tags) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.tag !== "string") {
        throw new TypeError("Each tag must be an object with a string tag property");
      }
    }
  }

  function statusValue(tag) {
    if (!tag.startsWith(STATUS_PREFIX)) return null;
    const value = tag.slice(STATUS_PREFIX.length);
    return statusOrder.has(value) ? value : null;
  }

  function ratingValue(tag) {
    if (!tag.startsWith(RATING_PREFIX)) return null;
    const value = tag.slice(RATING_PREFIX.length);
    return value.length === 1 && /^[0-5]$/.test(value) ? Number(value) : null;
  }

  function validateRating(rating) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      throw new RangeError("Rating must be an integer from 0 to 5");
    }
  }

  /** Resolve sync conflicts by highest reading progress and highest rating. */
  function readState(tags) {
    validateTags(tags);
    let status = "unread";
    let rating = 0;
    for (const entry of tags) {
      const nextStatus = statusValue(entry.tag);
      if (nextStatus !== null && statusOrder.get(nextStatus) > statusOrder.get(status)) {
        status = nextStatus;
      }
      const nextRating = ratingValue(entry.tag);
      if (nextRating !== null) rating = Math.max(rating, nextRating);
    }
    return { status, rating };
  }

  function validatePatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.prototype.toString.call(patch) !== "[object Object]") {
      throw new TypeError("Patch must be an object");
    }
    const values = Object.create(null);
    for (const key of Reflect.ownKeys(patch)) {
      if (key !== "status" && key !== "rating") {
        throw new TypeError("Patch supports only status and rating");
      }
      const descriptor = Object.getOwnPropertyDescriptor(patch, key);
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new TypeError("Patch fields must be plain values");
      }
      const value = descriptor.value;
      if (key === "status" && !statusOrder.has(value)) {
        throw new RangeError("Status must be unread, reading, or done");
      }
      if (key === "rating") validateRating(value);
      values[key] = value;
    }
    return values;
  }

  /**
   * Replace only recognized metadata in explicitly patched fields.
   * Unread and rating 0 are stored as absence. Unknown future values, unrelated
   * tags, original order, tag types and extra properties survive unchanged.
   */
  function updateTags(tags, patch) {
    validateTags(tags);
    const values = validatePatch(patch);
    const setStatus = Object.prototype.hasOwnProperty.call(values, "status");
    const setRating = Object.prototype.hasOwnProperty.call(values, "rating");
    const result = [];
    for (const entry of tags) {
      if (setStatus && statusValue(entry.tag) !== null) continue;
      if (setRating && ratingValue(entry.tag) !== null) continue;
      result.push({ ...entry });
    }
    if (setStatus && values.status !== "unread") {
      result.push({ tag: STATUS_PREFIX + values.status, type: 0 });
    }
    if (setRating && values.rating !== 0) {
      result.push({ tag: RATING_PREFIX + values.rating, type: 0 });
    }
    return result;
  }

  /** Return text labels; an optional prefix filters tags and is removed. */
  function visibleTags(tags, prefix = "") {
    validateTags(tags);
    if (typeof prefix !== "string") throw new TypeError("Tag prefix must be a string");
    return tags
      .map(entry => entry.tag)
      .filter(tag => !tag.startsWith(STATUS_PREFIX) && !tag.startsWith(RATING_PREFIX))
      .filter(tag => tag.startsWith(prefix))
      .map(tag => tag.slice(prefix.length));
  }

  function formatRating(rating) {
    validateRating(rating);
    return "★".repeat(rating);
  }

  return Object.freeze({
    STATUS_PREFIX,
    RATING_PREFIX,
    readState,
    updateTags,
    visibleTags,
    formatRating,
  });
});
