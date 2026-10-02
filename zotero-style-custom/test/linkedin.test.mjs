import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");

// The LinkedIn button opens the profile a person listed on their own ORCID record, or a people search.
function host(rows, fail = false) {
  const calls = [];
  return { calls, cache: {}, scheduleFlush() {},
    Z: { HTTP: { request: async (method, url, opts) => { calls.push({ url, opts }); if (fail) throw new Error("down"); return { response: { "researcher-url": rows } }; } } },
    orcidLinkedIn: Runtime.prototype.orcidLinkedIn };
}

test("a LinkedIn profile listed on ORCID is found, checked for its host, and remembered", async () => {
  const h = host([{ url: { value: "https://example.org/lab" } }, { url: { value: "https://www.linkedin.com/in/someone" } }]);
  assert.equal(await h.orcidLinkedIn("https://orcid.org/0000-0001-9161-999X"), "https://www.linkedin.com/in/someone");
  assert.match(h.calls[0].url, /pub\.orcid\.org\/v3\.0\/0000-0001-9161-999X\/researcher-urls$/);
  assert.doesNotMatch(JSON.stringify(h.calls[0]), /@|mailto/i, "no email in the request");
  await h.orcidLinkedIn("0000-0001-9161-999X");
  assert.equal(h.calls.length, 1, "asked once, then remembered");
});

test("no LinkedIn on ORCID, a look-alike host, a bad id or a failed request give '' (the caller searches instead)", async () => {
  assert.equal(await host([{ url: { value: "https://linkedin.com.evil.example/in/x" } }]).orcidLinkedIn("0000-0002-0000-0001"), "");
  assert.equal(await host([]).orcidLinkedIn("0000-0002-0000-0002"), "");
  assert.equal(await host([]).orcidLinkedIn("not an id"), "");
  assert.equal(await host([], true).orcidLinkedIn("0000-0002-0000-0003"), "");
});
