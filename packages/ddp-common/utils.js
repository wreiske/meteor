"use strict";

export const hasOwn = Object.prototype.hasOwnProperty;
export const slice = Array.prototype.slice;

export function keys(obj) {
  return Object.keys(Object(obj));
}

export function isEmpty(obj) {
  if (obj == null) {
    return true;
  }

  if (Array.isArray(obj) ||
      typeof obj === "string") {
    return obj.length === 0;
  }

  for (const key in obj) {
    if (hasOwn.call(obj, key)) {
      return false;
    }
  }

  return true;
}

export function last(array, n, guard) {
  if (array == null) {
    return;
  }

  if ((n == null) || guard) {
    return array[array.length - 1];
  }

  return slice.call(array, Math.max(array.length - n, 0));
}

DDPCommon.SUPPORTED_DDP_VERSIONS = [ '1', 'pre2', 'pre1' ];

DDPCommon.parseDDP = function (stringMessage) {
  try {
    var msg = JSON.parse(stringMessage);
  } catch (e) {
    Meteor._debug("Discarding message with invalid JSON", stringMessage);
    return null;
  }
  // DDP messages must be objects.
  if (msg === null || typeof msg !== 'object') {
    Meteor._debug("Discarding non-object DDP message", stringMessage);
    return null;
  }

  // massage msg to get it into "abstract ddp" rather than "wire ddp" format.

  // switch between "cleared" rep of unsetting fields and "undefined"
  // rep of same
  if (hasOwn.call(msg, 'cleared')) {
    if (! hasOwn.call(msg, 'fields')) {
      msg.fields = {};
    }
    msg.cleared.forEach(clearKey => {
      msg.fields[clearKey] = undefined;
    });
    delete msg.cleared;
  }

  ['fields', 'params', 'result'].forEach(field => {
    if (hasOwn.call(msg, field)) {
      msg[field] = EJSON._adjustTypesFromJSONValue(msg[field]);
    }
  });

  return msg;
};

DDPCommon.stringifyDDP = function (msg) {
  // Optimize by avoiding unnecessary cloning. Most DDP messages (ping, pong,
  // ready, etc.) have no fields/params/result and don't need any cloning.
  // Only create a copy when we actually need to mutate something.
  const hasFields = hasOwn.call(msg, 'fields');
  const hasParams = hasOwn.call(msg, 'params');
  const hasResult = hasOwn.call(msg, 'result');

  if (!hasFields && !hasParams && !hasResult) {
    // Fast path: no mutation needed, stringify directly
    if (msg.id && typeof msg.id !== 'string') {
      throw new Error("Message id is not a string");
    }
    return JSON.stringify(msg);
  }

  // Slow path: shallow copy message, deep clone only the fields we'll mutate
  const copy = { ...msg };

  // swizzle 'changed' messages from 'fields undefined' rep to 'fields
  // and cleared' rep
  if (hasFields) {
    const cleared = [];
    const fieldsClone = EJSON.clone(msg.fields);

    Object.keys(msg.fields).forEach(key => {
      const value = msg.fields[key];

      if (typeof value === "undefined") {
        cleared.push(key);
        delete fieldsClone[key];
      }
    });

    if (! isEmpty(cleared)) {
      copy.cleared = cleared;
    }

    if (isEmpty(fieldsClone)) {
      delete copy.fields;
    } else {
      // Adjust types on the cloned fields (mutates in-place)
      copy.fields = EJSON._adjustTypesToJSONValue(fieldsClone);
    }
  }

  // adjust types to basic for params and result
  ['params', 'result'].forEach(field => {
    if (hasOwn.call(copy, field)) {
      // Clone before adjusting since _adjustTypesToJSONValue mutates in-place
      copy[field] = EJSON._adjustTypesToJSONValue(EJSON.clone(copy[field]));
    }
  });

  if (msg.id && typeof msg.id !== 'string') {
    throw new Error("Message id is not a string");
  }

  return JSON.stringify(copy);
};
