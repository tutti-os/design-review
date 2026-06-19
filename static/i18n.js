/*
 * Tutti Design Review — in-app i18n harness.
 *
 * Source of truth for copy lives in package `locales/<locale>/app.json`. The app
 * server injects those dictionaries as `window.__TUTTI_I18N__` when serving
 * index.html, so they are available synchronously before the UI mounts.
 *
 * Locale is read from the optional Tutti host app context and from browser
 * locale APIs only — never from launch URL query parameters.
 */
(function () {
  var injected = (typeof window !== "undefined" && window.__TUTTI_I18N__) || {};
  var messages = injected.messages || {};
  var defaultLocale = injected.defaultLocale || "zh-CN";
  var locales =
    injected.locales && injected.locales.length
      ? injected.locales.slice()
      : Object.keys(messages);
  if (!locales.length) locales = [defaultLocale];
  if (locales.indexOf(defaultLocale) === -1) defaultLocale = locales[0];

  function normalize(value) {
    var tag = String(value || "").trim().replace(/_/g, "-");
    if (!tag) return defaultLocale;
    for (var i = 0; i < locales.length; i++) {
      if (locales[i].toLowerCase() === tag.toLowerCase()) return locales[i];
    }
    var lang = tag.split("-")[0].toLowerCase();
    for (var j = 0; j < locales.length; j++) {
      if (locales[j].split("-")[0].toLowerCase() === lang) return locales[j];
    }
    return defaultLocale;
  }

  function browserLocale() {
    try {
      return (
        (document.documentElement && document.documentElement.lang) ||
        (navigator.languages && navigator.languages[0]) ||
        navigator.language ||
        defaultLocale
      );
    } catch (e) {
      return defaultLocale;
    }
  }

  function initialLocale() {
    return normalize(browserLocale());
  }

  function lookup(dict, key) {
    if (!dict) return undefined;
    var parts = String(key).split(".");
    var cur = dict;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function resolve(locale, key) {
    var value = lookup(messages[normalize(locale)], key);
    if (value === undefined) value = lookup(messages[defaultLocale], key);
    return value;
  }

  function t(locale, key) {
    var value = resolve(locale, key);
    if (typeof value === "string") return value;
    if (value == null) return key;
    return String(value);
  }

  function list(locale, key) {
    var value = resolve(locale, key);
    return Array.isArray(value) ? value : [];
  }

  function readHostLocale() {
    try {
      var getContext =
        window.tuttiExternal &&
        window.tuttiExternal.app &&
        window.tuttiExternal.app.getContext;
      if (typeof getContext !== "function") return Promise.resolve(null);
      return Promise.resolve(getContext())
        .then(function (context) {
          return (context && (context.locale || context.language)) || null;
        })
        .catch(function () {
          return null;
        });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function subscribeHostLocale(listener) {
    try {
      var subscribe =
        window.tuttiExternal &&
        window.tuttiExternal.app &&
        window.tuttiExternal.app.subscribe;
      if (typeof subscribe !== "function") return function () {};
      return subscribe(function (context) {
        listener((context && (context.locale || context.language)) || null);
      });
    } catch (e) {
      return function () {};
    }
  }

  // Development parity check: every locale must expose the same flattened key
  // set (and the same array lengths) as the default locale.
  function flatten(value, prefix, out) {
    out = out || {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          flatten(value[key], prefix ? prefix + "." + key : key, out);
        }
      }
    } else {
      out[prefix] = Array.isArray(value) ? "len:" + value.length : "leaf";
    }
    return out;
  }

  function checkParity() {
    var base = flatten(messages[defaultLocale] || {}, "", {});
    var problems = [];
    for (var i = 0; i < locales.length; i++) {
      var locale = locales[i];
      var current = flatten(messages[locale] || {}, "", {});
      var key;
      for (key in base) {
        if (!(key in current)) problems.push(locale + " missing " + key);
        else if (base[key] !== current[key])
          problems.push(locale + " shape mismatch " + key);
      }
      for (key in current) {
        if (!(key in base)) problems.push(locale + " extra " + key);
      }
    }
    return { ok: problems.length === 0, problems: problems };
  }

  window.TuttiI18n = {
    messages: messages,
    locales: locales,
    defaultLocale: defaultLocale,
    normalize: normalize,
    initialLocale: initialLocale,
    resolve: resolve,
    t: t,
    list: list,
    readHostLocale: readHostLocale,
    subscribeHostLocale: subscribeHostLocale,
    checkParity: checkParity
  };
})();
