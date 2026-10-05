/* Dedicated author identities and their public publication lists.
 * ORCID v3.0: https://info.orcid.org/documentation/integration-guide/orcid-record/
 * PoP profiles: https://harzing.com/resources/publish-or-perish/manual/using/data-sources/google-scholar-profile
 * Anonymous ORCID access can be rate limited; a caller may supply its intended ORCID token.
 * An ORCID work summary establishes a record association, never a complete author list.
 */
var ZotPoPAuthors = (function () {
	"use strict";
	const Query = typeof ZotPoPQuery !== "undefined" ? ZotPoPQuery : typeof require === "function" ? require("./query.js") : null;
	const Sources = typeof ZotPoPSources !== "undefined" ? ZotPoPSources : typeof require === "function" ? require("./sources.js") : null;
	const clone = value => JSON.parse(JSON.stringify(value));
	const scalar = value => value && typeof value === "object" ? value.value ?? "" : value ?? "";
	const text = value => String(scalar(value)).trim();
	function abortError() { return Object.assign(new Error("Author search cancelled"), { name: "AbortError" }); }
	function checkCancelled(ctx) { if (ctx.signal?.aborted || ctx.isCancelled?.()) throw abortError(); }

	async function cancellable(action, ctx) {
		checkCancelled(ctx);
		let abort;
		try {
			const work = Promise.resolve().then(() => { checkCancelled(ctx); return action(); });
			const result = !ctx.signal ? await work : await Promise.race([work, new Promise((_, reject) => {
				abort = () => reject(abortError());
				ctx.signal.addEventListener("abort", abort, { once: true });
				if (ctx.signal.aborted) abort();
			})]);
			checkCancelled(ctx);
			return result;
		} finally { if (abort) ctx.signal.removeEventListener("abort", abort); }
	}

	function parseOrcid(input) {
		const parsed = Query?.parseAuthorIdentifier(String(input ?? "").trim());
		return parsed?.type === "orcid" ? parsed.id : null;
	}

	function parseScholarProfile(input) {
		const value = String(input ?? "").trim();
		let id = value;
		if (/^https?:\/\//i.test(value)) {
			try {
				const url = new URL(value);
				if (!/^scholar\.google\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/i.test(url.hostname)
					|| url.username || url.password || url.port || !/^\/citations\/?$/.test(url.pathname)
					|| url.searchParams.getAll("user").length !== 1) return null;
				id = url.searchParams.get("user");
			} catch (_) { return null; }
		}
		if (!/^[A-Za-z0-9_-]{12}$/.test(id)) return null;
		return { id, url: "https://scholar.google.com/citations?user=" + encodeURIComponent(id) };
	}

	function limit(options = {}) {
		let max = Number(options.maxResults ?? 200);
		if (!Number.isInteger(max) || max < 1 || max > 2000) throw new Error("Author result limit must be an integer from 1 to 2000");
		return max;
	}
	function profileIdentity(profile) {
		const identity = { provider: profile.provider, id: profile.id ?? null, name: profile.name || "", affiliation: profile.affiliation || "",
			url: profile.url || "", mode: profile.mode || "profile", identityConfirmed: profile.identityConfirmed === true };
		if (profile.scholarStats) identity.scholarStats = profile.scholarStats;
		if (Number.isFinite(profile.worksCount)) identity.worksCount = profile.worksCount;
		return identity;
	}
	function attach(records, profile, provenance, ctx) {
		const identity = profileIdentity(profile);
		for (const record of records) { record.authorProfile = clone(identity); record.authorProvenance = clone(provenance); }
		records.authorProfile = records.profile = clone(identity);
		records.authorProvenance = records.provenance = clone(provenance);
		if (provenance.truncated || provenance.complete === false) records.partial = true;
		ctx.authorProvenance = clone(provenance);
		checkCancelled(ctx);
		ctx.onResults?.(records, { final: !records.partial, source: records[0]?.source || profile.provider,
			authorProfile: records.authorProfile, authorProvenance: records.authorProvenance });
		return records;
	}

	async function orcidFetch(url, http, ctx, expectedPath = null, label = "response") {
		if (typeof http?.getJSON !== "function") throw new Error("ORCID requires a JSON HTTP transport");
		const headers = { Accept: "application/json" };
		if (ctx.orcidAccessToken) {
			if (typeof ctx.orcidAccessToken !== "string" || /[\r\n\0]/.test(ctx.orcidAccessToken)) throw new Error("Invalid ORCID access token");
			headers.Authorization = "Bearer " + ctx.orcidAccessToken;
		}
		try {
			const result = await cancellable(() => http.getJSON(url, headers, ctx.signal), ctx);
			if (!result || typeof result !== "object" || Array.isArray(result)
				|| expectedPath && result.path && result.path !== expectedPath) throw new Error("ORCID returned an invalid " + label);
			return result;
		} catch (error) {
			if (error.name === "AbortError") throw error;
			if ([401, 403].includes(error.status)) throw Object.assign(new Error("ORCID public access was denied. Configure an ORCID public API token or retry through the public record."), { status: error.status, code: "ORCID_ACCESS_REQUIRED" });
			if (error.status === 404) throw Object.assign(new Error("ORCID record was not found" + (expectedPath ? ": " + expectedPath.split("/")[1] : "")), { status: 404 });
			if (error.status === 429) throw Object.assign(new Error("ORCID rate limit reached. Retry later."), { status: 429 });
			throw error;
		}
	}
	function orcidJSON(id, section, http, ctx) {
		return orcidFetch("https://pub.orcid.org/v3.0/" + id + "/" + section, http, ctx, "/" + id + "/" + section, section + " response");
	}

	// ---------------------------------------------------------------- ORCID by name
	// ORCID's expanded search is fielded Solr. A free-text query for "Michael Jewett" returns 107,000 noisy
	// profiles; given-names / family-name (and credit-name, other-names) name the person. Typed names come
	// as "Given Family", "Family, Given", "J. Family" or "Family JA", so every plausible reading goes into
	// one OR query and the ranking afterwards decides which profile is the one meant.
	const ORCID_SEARCH = "https://pub.orcid.org/v3.0/expanded-search/";
	const ORCID_ROWS = 20;
	const CJK = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;
	const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "dos", "das", "du", "la", "le", "bin", "ben", "al", "el", "ter", "ten", "op", "zu"]);
	const isInitial = token => /^\p{Lu}$/u.test(token) || /^\p{Lu}{2,3}$/u.test(token);
	const fold = value => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const nameTokens = value => fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const significant = tokens => { const long = tokens.filter(token => token.length > 1); return long.length ? long : tokens; };

	/* What was typed, as { raw, cjk, variants: [{ given: [...], family }] }. A Korean, Chinese or Japanese
	   name is kept exactly as typed (no split, no reorder): it is searched as a whole credit or other name. */
	function parseNameInput(input) {
		let value = String(input ?? "").normalize("NFC").replace(/[^\p{L}\p{M}'\u2019.,\s-]/gu, " ").replace(/\s+/g, " ").trim();
		value = value.replace(/^(?:(?:dr|prof|professor|mr|ms|mrs)\.?\s+)+/i, "").trim();
		if (!value) return { raw: "", cjk: false, variants: [] };
		if (CJK.test(value)) return { raw: value, cjk: true, variants: [] };
		const clean = token => token.replace(/^[.,'\u2019-]+/, "").replace(/[.,]+$/, "");
		const split = token => /^(?:\p{L}\.){2,}$/u.test(token) ? token.match(/\p{L}/gu) : [token];
		const initials = tokens => tokens.flatMap(token => token.length > 1 && token === token.toUpperCase() && isInitial(token) ? [...token] : [token]);
		if (value.includes(",")) {
			const [family, ...rest] = value.split(",");
			const given = rest.join(" ").split(/\s+/).flatMap(split).map(clean).filter(Boolean);
			if (clean(family.trim())) return { raw: value, cjk: false, variants: [{ given: initials(given), family: family.trim().split(/\s+/).map(clean).filter(Boolean).join(" ") }] };
		}
		let tokens = value.split(" ").flatMap(split).map(clean).filter(Boolean);
		if (tokens.length > 2 && /^(?:jr|sr|ii|iii|iv)$/i.test(tokens.at(-1))) tokens.pop();
		if (!tokens.length) return { raw: value, cjk: false, variants: [] };
		if (tokens.length === 1) return { raw: value, cjk: false, variants: [{ given: [], family: tokens[0] }] };
		const n = tokens.length, variants = [];
		// "Doudna JA", "Doudna J A": the initials come last, the surname first.
		let k = n; while (k > 1 && isInitial(tokens[k - 1])) k--;
		if (k < n && !isInitial(tokens[0])) return { raw: value, cjk: false, variants: [{ given: initials(tokens.slice(k)), family: tokens.slice(0, k).join(" ") }] };
		let i = n - 1; while (i > 1 && PARTICLES.has(tokens[i - 1].toLowerCase())) i--;
		variants.push({ given: tokens.slice(0, i), family: tokens.slice(i).join(" ") });
		// Surname first ("Sung Jae Yoon") is as common in the registry as surname last, so both are asked.
		if (!tokens.some(isInitial)) variants.push({ given: tokens.slice(1), family: tokens[0] });
		return { raw: value, cjk: false, variants };
	}

	function orcidNameQuery(input) {
		const parsed = parseNameInput(input);
		const quote = value => '"' + String(value).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim() + '"';
		const clauses = [];
		if (parsed.cjk) clauses.push("credit-name:" + quote(parsed.raw), "other-names:" + quote(parsed.raw));
		else {
			for (const { given, family } of parsed.variants) {
				const names = given.filter(token => !isInitial(token));
				const first = names.length ? names.map(token => "given-names:" + quote(token)).join(" AND ")
					: given.length ? "given-names:" + (given[0].replace(/[^\p{L}]/gu, "")[0] || "") + "*" : "";
				clauses.push("(" + (first ? first + " AND " : "") + "family-name:" + quote(family) + ")");
			}
			const primary = parsed.variants[0];
			if (primary?.given.some(token => !isInitial(token))) {
				const full = [...primary.given, primary.family].join(" ");
				clauses.push("credit-name:" + quote(full), "other-names:" + quote(full));
			}
		}
		const unique = [...new Set(clauses)];
		if (!unique.length) return null;
		const q = unique.join(" OR ");
		return { parsed, q, url: ORCID_SEARCH + "?q=" + encodeURIComponent(q) + "&rows=" + ORCID_ROWS };
	}
	// The next page of the same name query: ORCID pages by `start`.
	const orcidPageURL = (url, start) => start > 0 ? url + "&start=" + start : url;

	function orcidCandidate(row) {
		const id = parseOrcid(row?.["orcid-id"]);
		if (!id) return null;
		const given = text(row["given-names"]), family = text(row["family-names"]);
		const credit = text(row["credit-name"]);
		const list = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => text(item)).filter(Boolean);
		const institutions = [...new Set(list(row["institution-name"]))];
		return { provider: "orcid", id, name: credit || [given, family].filter(Boolean).join(" ") || id, givenNames: given, familyNames: family, creditName: credit,
			affiliation: institutions.slice(0, 2).join("; "), institutions, otherNames: list(row["other-name"]), url: "https://orcid.org/" + id,
			identityConfirmed: true, mode: "profile" };
	}

	/* How well a candidate's name is the typed one: 2 = every name part agrees (a middle initial aside),
	   1 = the typed parts are all in the candidate's name or the other way round (initial, missing middle name), 0 = anything else. */
	function nameTier(parsed, candidate) {
		const typed = significant(nameTokens(parsed.raw));
		if (!typed.length) return 0;
		const names = [[candidate.givenNames, candidate.familyNames].filter(Boolean).join(" "), candidate.creditName, ...(candidate.otherNames || [])].filter(Boolean);
		let best = 0;
		for (const name of names) {
			const have = significant(nameTokens(name));
			if (!have.length) continue;
			const a = new Set(typed), b = new Set(have);
			if (a.size === b.size && [...a].every(token => b.has(token))) return 2;
			const initialOk = (small, big) => [...small].every(token => big.has(token) || token.length === 1 && [...big].some(other => other.startsWith(token)));
			if (initialOk(a, b) || initialOk(b, a)) best = 1;
		}
		return best;
	}

	/* Exact full-name match first, then by how much OpenAlex has under the person's name. Profiles with
	   no works anywhere are marked `weak`: the card list keeps them behind "more" when better ones exist. */
	function rankOrcidCandidates(candidates, parsed) {
		const known = candidates.some(c => c.worksCount != null);
		candidates.forEach((c, index) => { c.rankIndex = index; c.nameTier = nameTier(parsed, c); c.weak = known && !(c.worksCount > 0); });
		if (candidates.every(c => c.weak)) candidates.forEach(c => { c.weak = false; });
		candidates.sort((a, b) => Number(a.weak) - Number(b.weak) || b.nameTier - a.nameTier || (b.worksCount || 0) - (a.worksCount || 0) || a.rankIndex - b.rankIndex);
		return candidates;
	}

	const lastInstitutionOf = inst => {
		if (!inst?.display_name) return null;
		const out = { name: inst.display_name, country: String(inst.country_code || "").toUpperCase() || null };
		const id = String(inst.id || "").match(/I[1-9]\d*/i)?.[0];
		if (id) out.id = id.toUpperCase();
		return out;
	};
	/* The standing of each card's last institution (T1-T4, from the lab's OpenAlex h-index), asked for every card
	   in one filter request through the institution cache the result rows use, so a lab is asked about once. */
	async function institutionTiers(candidates, http, ctx) {
		const Aff = typeof ZotPoPAffiliations !== "undefined" ? ZotPoPAffiliations : typeof require === "function" ? require("./affiliations.js") : null;
		const people = candidates.filter(c => c.lastInstitution?.id).map(c => ({ card: c, name: c.name || "?", institutionId: c.lastInstitution.id, institutionH: null }));
		if (!people.length || ctx.openAlexSpent || typeof Sources?.enrichInstitutions !== "function" || typeof http?.getJSON !== "function") return;
		try {
			await Sources.enrichInstitutions(people.map(p => ({ people: [p] })), { getJSON: (url, headers) => cancellable(() => http.getJSON(url, headers, ctx.signal), ctx) }, { ...ctx, onProgress: null });
		} catch (error) { if (error.name === "AbortError") throw error; ctx.log?.("Institution tiers for author cards failed: " + error.message); return; }
		for (const p of people) {
			if (!Number.isFinite(p.institutionH)) continue;
			p.card.lastInstitution.hIndex = p.institutionH;
			p.card.lastInstitution.tier = Aff?.tierOf(p.institutionH)?.key || null;
		}
	}

	// One OpenAlex request for all the candidates: papers, citations, h-index, last institution, top topic.
	async function enrichCandidates(candidates, http, ctx) {
		if (!candidates.length || ctx.openAlexSpent || typeof http?.getJSON !== "function") return false;
		const url = "https://api.openalex.org/authors?filter=orcid:" + candidates.map(c => encodeURIComponent(c.id)).join("|")
			+ "&select=id,orcid,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics&per-page=50" + Sources.openAlexAuth(ctx);
		try {
			const data = await cancellable(() => Sources.withRetry(() => http.getJSON(url, {}, ctx.signal), {}, ctx), ctx);
			// One ORCID iD can sit on several OpenAlex author records: keep them all (the biggest leads, the rest are alsoIds).
			const byId = new Map(), extra = new Map();
			for (const a of Array.isArray(data?.results) ? data.results : []) {
				const id = parseOrcid(a?.orcid); if (!id) continue;
				const have = byId.get(id);
				if (!have) { byId.set(id, a); continue; }
				const [lead, rest] = (Number(a.works_count) || 0) > (Number(have.works_count) || 0) ? [a, have] : [have, a];
				byId.set(id, lead); extra.set(id, [...(extra.get(id) || []), rest]);
			}
			for (const c of candidates) {
				const a = byId.get(c.id);
				c.enriched = true;
				if (!a) { c.worksCount = 0; continue; }
				const inst = a.last_known_institutions?.[0];
				Object.assign(c, { worksCount: Number(a.works_count) || 0, citations: Number(a.cited_by_count) || 0,
					hIndex: Number.isFinite(Number(a.summary_stats?.h_index)) ? Number(a.summary_stats.h_index) : null,
					topic: text(a.topics?.[0]?.display_name), openalexId: Sources.openAlexAuthorId?.(a.id) || String(a.id || "").replace("https://openalex.org/", "") || null,
					lastInstitution: lastInstitutionOf(inst) });
				const others = extra.get(c.id) || [];
				if (others.length) {
					const lead = { openalexId: c.openalexId, hIndex: c.hIndex };
					c.alsoIds = [...new Set(others.map(o => oaAuthorId(o.id)).filter(Boolean))];
					c.worksCount += others.reduce((n, o) => n + (Number(o.works_count) || 0), 0);
					c.citations += others.reduce((n, o) => n + (Number(o.cited_by_count) || 0), 0);
					c.hIndexes = [lead, ...others.map(o => ({ openalexId: oaAuthorId(o.id), hIndex: Number.isFinite(Number(o.summary_stats?.h_index)) ? Number(o.summary_stats.h_index) : null }))];
					c.hIndex = null; // no honest h-index from several profiles' own figures; the union of works gives it once loaded
				}
			}
			return true;
		} catch (error) {
			if (error.name === "AbortError") throw error;
			ctx.log?.("OpenAlex author enrichment failed: " + error.message);
			if (!ctx.errors) ctx.errors = [];
			ctx.errors.push("OpenAlex: paper counts for these profiles are unavailable: " + error.message);
			return false;
		}
	}

	async function orcidNameCandidates(value, http, ctx, start = 0) {
		const built = orcidNameQuery(value);
		if (!built) throw new Error("Enter an ORCID iD or an author name");
		if (typeof http?.getJSON !== "function") throw new Error("ORCID requires a JSON HTTP transport");
		const data = await orcidFetch(orcidPageURL(built.url, start), http, ctx);
		const rows = data["expanded-result"] ?? [];
		if (!Array.isArray(rows)) throw new Error("ORCID returned an invalid search response");
		const seen = new Set(), candidates = [];
		for (const row of rows) { const c = orcidCandidate(row); if (c && !seen.has(c.id)) { seen.add(c.id); candidates.push(c); } }
		const numFound = Number(data["num-found"]) || start + candidates.length;
		const provenance = { provider: "orcid", endpoint: "expanded-search", query: built.q, numFound, capturedAt: new Date().toISOString(), complete: true, publicOnly: true };
		for (const c of candidates) c.provenance = { provider: "orcid", endpoint: "expanded-search", capturedAt: provenance.capturedAt };
		candidates.authorProvenance = provenance;
		// Where the next page starts, and how many ORCID holds in all; null when this was the last page.
		const next = start + rows.length;
		const page = { next: rows.length >= ORCID_ROWS && next < numFound ? next : null, total: numFound };
		return { candidates, parsed: built.parsed, provenance, page };
	}

	async function searchOrcidNames(value, http, ctx) {
		const { candidates, parsed, provenance, page } = await orcidNameCandidates(value, http, ctx);
		await enrichCandidates(candidates, http, ctx);
		await institutionTiers(candidates, http, ctx);
		rankOrcidCandidates(candidates, parsed);
		candidates.authorProvenance = provenance;
		candidates.paging = { orcid: page };
		return candidates;
	}

	// ---------------------------------------------------------------- combined: OpenAlex + ORCID
	const OA_AUTHOR_SELECT = "id,orcid,display_name,display_name_alternatives,works_count,cited_by_count,summary_stats,last_known_institutions,topics";
	const OA_AUTHOR_ROWS = 15;
	const oaAuthorId = value => { const m = String(value ?? "").match(/A[1-9]\d*/i); return m ? m[0].toUpperCase() : null; };

	function openAlexCandidate(a) {
		const openalexId = oaAuthorId(a?.id);
		if (!openalexId) return null;
		const inst = a.last_known_institutions?.[0];
		const alternatives = (Array.isArray(a.display_name_alternatives) ? a.display_name_alternatives : []).map(text).filter(Boolean);
		const name = text(a.display_name) || openalexId;
		return { provider: "combined", sources: ["openalex"], id: openalexId, openalexId, orcid: parseOrcid(a.orcid), name, givenNames: "", familyNames: "", creditName: name,
			otherNames: alternatives, affiliation: "", institutions: [], worksCount: Number(a.works_count) || 0, citations: Number(a.cited_by_count) || 0,
			hIndex: Number.isFinite(Number(a.summary_stats?.h_index)) ? Number(a.summary_stats.h_index) : null, topic: text(a.topics?.[0]?.display_name),
			lastInstitution: lastInstitutionOf(inst),
			url: "https://openalex.org/" + openalexId, identityConfirmed: true, mode: "profile" };
	}

	function mergeCandidate(base, orcid) {
		base.sources = [...new Set([...base.sources, "orcid"])];
		base.orcid = orcid.id || orcid.orcid;
		const nameOf = orcid.creditName || [orcid.givenNames, orcid.familyNames].filter(Boolean).join(" ");
		if (nameOf && base.name !== nameOf) base.otherNames = [...new Set([nameOf, ...(base.otherNames || []), ...(orcid.otherNames || [])])];
		Object.assign(base, { givenNames: orcid.givenNames || base.givenNames, familyNames: orcid.familyNames || base.familyNames,
			affiliation: orcid.affiliation || base.affiliation, institutions: orcid.institutions || base.institutions });
		return base;
	}

	/* Exact name first, then by what OpenAlex counts under the person. A card with no works and no
	   affiliation anywhere is `weak` and waits behind "more" while better ones exist. */
	function rankCombinedCandidates(candidates, parsed) {
		candidates.forEach((c, index) => {
			c.rankIndex = index; c.nameTier = nameTier(parsed, c);
			c.weak = !(c.worksCount > 0) && !c.affiliation && !c.lastInstitution;
		});
		if (candidates.every(c => c.weak)) candidates.forEach(c => { c.weak = false; });
		candidates.sort((a, b) => Number(a.weak) - Number(b.weak) || b.nameTier - a.nameTier || (b.worksCount || 0) - (a.worksCount || 0) || a.rankIndex - b.rankIndex);
		return candidates;
	}

	function orcidAsCombined(c) {
		return { ...c, provider: "combined", sources: ["orcid"], orcid: c.id, openalexId: c.openalexId || null };
	}

	async function openAlexAuthorSearch(value, http, ctx, pageNo = 1) {
		const url = "https://api.openalex.org/authors?search=" + encodeURIComponent(value) + "&per-page=" + OA_AUTHOR_ROWS + (pageNo > 1 ? "&page=" + pageNo : "") + "&select=" + OA_AUTHOR_SELECT + Sources.openAlexAuth(ctx);
		const data = await cancellable(() => Sources.withRetry(() => http.getJSON(url, {}, ctx.signal), {}, ctx), ctx);
		const rows = Array.isArray(data?.results) ? data.results : [];
		const total = Number(data?.meta?.count);
		const list = rows.map(openAlexCandidate).filter(Boolean);
		// The next page number, null after the last one (or when OpenAlex did not say how many there are).
		list.page = { next: rows.length >= OA_AUTHOR_ROWS && Number.isFinite(total) && pageNo * OA_AUTHOR_ROWS < total ? pageNo + 1 : null, total: Number.isFinite(total) ? total : null };
		return list;
	}

	/* OpenAlex cards and ORCID rows into one card per person. `prior` are the cards already shown (a "more"
	   page): a person among them is merged into that card, never listed twice. Returns the new cards only. */
	async function combineCandidates(oaRows, orcidRows, http, ctx, prior = []) {
		const list = [], byOrcid = new Map(), byOa = new Map();
		for (const c of prior) {
			if (c.orcid) byOrcid.set(c.orcid, c);
			for (const id of [c.openalexId, ...(c.alsoIds || [])]) if (id) byOa.set(id, c);
		}
		// OpenAlex sometimes holds one person as several author records that carry the same ORCID iD (the live
		// "Sheila Ingemann" search returns two): one card, the figures added up, the works read through the iD.
		for (const c of oaRows.slice().sort((a, b) => b.worksCount - a.worksCount)) {
			if (byOa.has(c.openalexId)) continue;
			const same = c.orcid && byOrcid.get(c.orcid);
			if (same) {
				same.alsoIds = [...(same.alsoIds || []), c.openalexId]; same.worksCount += c.worksCount; same.citations += c.citations;
				same.hIndexes = [...(same.hIndexes || [{ openalexId: same.openalexId, hIndex: same.hIndex }]), { openalexId: c.openalexId, hIndex: c.hIndex }];
				same.hIndex = null; // the h of a union of works is not the max of the parts; computed from the loaded works instead
				same.otherNames = [...new Set([...(same.otherNames || []), c.name, ...c.otherNames])];
				byOa.set(c.openalexId, same); continue;
			}
			list.push(c); byOa.set(c.openalexId, c); if (c.orcid) byOrcid.set(c.orcid, c);
		}
		const orcidOnly = [];
		for (const row of orcidRows) {
			const hit = byOrcid.get(row.id);
			if (hit) mergeCandidate(hit, row); else orcidOnly.push(orcidAsCombined(row));
		}
		// One batched OpenAlex request for the ORCID profiles the search did not already return.
		if (orcidOnly.length) await enrichCandidates(orcidOnly, http, ctx);
		for (const c of orcidOnly) {
			const known = [c.openalexId, ...(c.alsoIds || [])].map(id => id && byOa.get(id)).find(hit => hit && prior.includes(hit));
			if (known) { if (!known.orcid) { known.orcid = c.orcid; mergeCandidate(known, c); } continue; }
			// One iD on several OpenAlex records: the ORCID card holds them all (ids, summed figures), and any of
			// those records the name search listed on its own, without the iD, is that same person, not a second card.
			if (c.alsoIds?.length) {
				const dupes = [...new Set([c.openalexId, ...c.alsoIds].map(id => byOa.get(id)).filter(hit => hit && !hit.orcid && list.includes(hit)))];
				if (dupes.length) {
					for (const dupe of dupes) list.splice(list.indexOf(dupe), 1);
					c.sources = ["openalex", "orcid"];
					c.otherNames = [...new Set([...(c.otherNames || []), ...dupes.flatMap(d => [d.name, ...(d.otherNames || [])])])].filter(name => name && name !== c.name);
					if (!c.topic) c.topic = dupes[0].topic;
				}
				c.id = c.openalexId || c.orcid; list.push(c);
				for (const id of [c.openalexId, ...c.alsoIds]) byOa.set(id, c);
				continue;
			}
			const hit = c.openalexId ? byOa.get(c.openalexId) : null;
			if (hit && !hit.orcid) { hit.orcid = c.orcid; mergeCandidate(hit, c); }
			else { c.id = c.openalexId || c.orcid; list.push(c); }
		}
		return list;
	}

	async function searchCombined(value, http, ctx) {
		const identifier = Query?.parseAuthorIdentifier(value);
		const provenance = { provider: "combined", endpoint: "openalex+orcid", capturedAt: new Date().toISOString(), complete: true };
		const finish = list => { list.authorProvenance = provenance; for (const c of list) c.provenance = { provider: "combined", capturedAt: provenance.capturedAt }; return list; };
		if (/https?:\/\/|orcid\.org|openalex\.org|^orcid:|^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{3}[\dXx]$|^A\d+$/i.test(value) && !identifier)
			throw new Error("Enter a valid ORCID iD, OpenAlex author ID or profile URL, or type a name");
		if (identifier?.type === "openalex") {
			const url = "https://api.openalex.org/authors/" + identifier.id + "?select=" + OA_AUTHOR_SELECT + Sources.openAlexAuth(ctx);
			const a = await cancellable(() => Sources.withRetry(() => http.getJSON(url, {}, ctx.signal), {}, ctx), ctx);
			const c = openAlexCandidate(a);
			if (!c) throw new Error("OpenAlex returned no author for " + identifier.id);
			c.direct = true;
			await institutionTiers([c], http, ctx);
			return finish([c]);
		}
		if (identifier?.type === "orcid") {
			const person = await searchProfiles("orcid", identifier.id, http, ctx);
			const c = orcidAsCombined(person[0]);
			await enrichCandidates([c], http, ctx);
			c.direct = true;
			await institutionTiers([c], http, ctx);
			return finish([c]);
		}
		const tasks = [ctx.openAlexSpent ? Promise.reject(new Error("OpenAlex budget spent for today")) : openAlexAuthorSearch(value, http, ctx), orcidNameCandidates(value, http, ctx)];
		const [oa, or] = await Promise.allSettled(tasks);
		for (const r of [oa, or]) if (r.status === "rejected" && r.reason?.name === "AbortError") throw r.reason;
		if (oa.status === "rejected" && or.status === "rejected") throw or.reason;
		if (!ctx.errors) ctx.errors = [];
		if (oa.status === "rejected") ctx.errors.push("OpenAlex: " + oa.reason.message);
		if (or.status === "rejected") ctx.errors.push("ORCID: " + or.reason.message);
		const list = await combineCandidates(oa.status === "fulfilled" ? oa.value : [], or.status === "fulfilled" ? or.value.candidates : [], http, ctx);
		const parsed = or.status === "fulfilled" ? or.value.parsed : parseNameInput(value);
		await institutionTiers(list, http, ctx);
		const out = finish(rankCombinedCandidates(list, parsed));
		// Where each service's next page starts. A service that failed is not offered again from here.
		out.paging = { openalex: oa.status === "fulfilled" ? oa.value.page : null, orcid: or.status === "fulfilled" ? or.value.page : null };
		return out;
	}

	/* The next page of a name search, only when asked ("more people"): OpenAlex's next 15 and ORCID's next 20,
	   each only while that service has more. New cards are enriched in one batched OpenAlex request, their labs'
	   tiers in one more; cards already shown are merged into, never repeated. Resolves { added, paging }. */
	const hasMorePeople = paging => Boolean(paging && (paging.openalex?.next || paging.orcid?.next));
	async function moreProfiles(provider, input, prior, paging, http, ctx = {}) {
		checkCancelled(ctx);
		const value = String(input ?? "").trim();
		if (!value || !hasMorePeople(paging)) return { added: [], paging: paging || null };
		if (!ctx.errors) ctx.errors = [];
		const parsed = parseNameInput(value);
		if (provider === "orcid") {
			const { candidates, page } = await orcidNameCandidates(value, http, ctx, paging.orcid.next);
			const shown = new Set((prior || []).map(c => c.id));
			const added = candidates.filter(c => !shown.has(c.id));
			await enrichCandidates(added, http, ctx);
			await institutionTiers(added, http, ctx);
			rankOrcidCandidates(added, parsed);
			return { added, paging: { orcid: page } };
		}
		if (provider !== "combined") return { added: [], paging: null };
		const askOa = paging.openalex?.next && !ctx.openAlexSpent, askOr = paging.orcid?.next;
		if (paging.openalex?.next && ctx.openAlexSpent) ctx.errors.push("OpenAlex: budget spent for today");
		if (!askOa && !askOr) return { added: [], paging };
		const [oa, or] = await Promise.allSettled([askOa ? openAlexAuthorSearch(value, http, ctx, paging.openalex.next) : Promise.resolve(null),
			askOr ? orcidNameCandidates(value, http, ctx, paging.orcid.next) : Promise.resolve(null)]);
		for (const r of [oa, or]) if (r.status === "rejected" && r.reason?.name === "AbortError") throw r.reason;
		if (oa.status === "rejected") ctx.errors.push("OpenAlex: " + oa.reason.message);
		if (or.status === "rejected") ctx.errors.push("ORCID: " + or.reason.message);
		if (oa.status === "rejected" && or.status === "rejected") throw or.reason;
		const oaRows = oa.status === "fulfilled" && oa.value ? oa.value : [], orRows = or.status === "fulfilled" && or.value ? or.value.candidates : [];
		const added = await combineCandidates(oaRows, orRows, http, ctx, prior || []);
		await institutionTiers(added, http, ctx);
		const capturedAt = new Date().toISOString();
		for (const c of added) c.provenance = { provider: "combined", capturedAt };
		rankCombinedCandidates(added, parsed);
		// A page that failed keeps its place, so pressing again retries it.
		return { added, paging: {
			openalex: oa.status === "fulfilled" && oa.value ? oa.value.page : paging.openalex,
			orcid: or.status === "fulfilled" && or.value ? or.value.page : paging.orcid } };
	}

	// ---------------------------------------------------------------- who is this paper's author: local clustering
	/* A name search lists every paper under that name, namesakes included. Clustering the papers into people
	   needs no network: the author's written form ("SI Jensen", "S Jensen", "Sheila Ingemann Jensen"), the
	   co-authors, then venue and years as tie-breakers. */
	const initialsLike = token => /^\p{Lu}{1,3}\.?$/u.test(token);
	function nameParts(full) {
		const value = String(full ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
		if (!value) return null;
		let family, given;
		if (value.includes(",")) { const [f, ...rest] = value.split(","); family = f.trim(); given = rest.join(" ").trim().split(/\s+/).filter(Boolean); }
		else {
			let tokens = value.split(" ");
			if (tokens.length === 1) return { family: fold(tokens[0]), given: [], initials: "", full: false, form: value };
			if (initialsLike(tokens.at(-1)) && !initialsLike(tokens[0])) { family = tokens.slice(0, -1).join(" "); given = [tokens.at(-1)]; }
			else {
				let i = tokens.length - 1; while (i > 1 && PARTICLES.has(tokens[i - 1].toLowerCase())) i--;
				family = tokens.slice(i).join(" "); given = tokens.slice(0, i);
			}
		}
		const words = given.map(token => token.replace(/\./g, "")).filter(Boolean);
		const initials = words.map(token => initialsLike(token) ? token.toLowerCase() : fold(token)[0] || "").join("");
		return { family: fold(family).replace(/[^\p{L}\p{N}]+/gu, ""), given: words, initials, full: words.some(token => !initialsLike(token)), form: value };
	}
	const firstGiven = p => p.given.find(token => !initialsLike(token)) ? fold(p.given.find(token => !initialsLike(token))) : "";
	/* "S" ~ "SI" ~ "Sheila Ingemann": one set of initials begins the other; two full first names must agree. */
	function formsCompatible(a, b) {
		if (!a || !b || a.family !== b.family) return false;
		if (!a.initials || !b.initials) return true;
		if (!(a.initials.startsWith(b.initials) || b.initials.startsWith(a.initials))) return false;
		const fa = firstGiven(a), fb = firstGiven(b);
		return !(fa && fb) || fa.startsWith(fb) || fb.startsWith(fa);
	}
	const coauthorKey = p => p.family + "|" + (p.initials[0] || "");

	/* records -> { clusters: [{ id, name, forms, n, keys, minYear, maxYear, coauthors, venue }], rest }. `typed` is the
	   name that was searched; the author of each paper that answers to it is "the person". */
	function clusterPeople(records, typed, keyOf = record => record.key) {
		const parsed = parseNameInput(typed), wanted = parsed.variants.map(v => ({ family: fold(v.family).replace(/[^\p{L}\p{N}]+/gu, ""),
			initials: v.given.map(token => isInitial(token) ? token.toLowerCase() : fold(token)[0] || "").join(""), given: v.given, full: v.given.some(token => !isInitial(token)) }));
		const cjk = parsed.cjk ? fold(parsed.raw) : null;
		const items = records.map((record, index) => {
			const authors = Array.isArray(record.authors) ? record.authors : [];
			let at = -1, me = null, alt = -1;
			for (let i = 0; i < authors.length && at < 0; i++) {
				const p = nameParts(authors[i]?.name || [authors[i]?.firstName, authors[i]?.lastName].filter(Boolean).join(" "));
				if (!p) continue;
				if (cjk ? fold(authors[i].name) === cjk : wanted.length ? wanted.some(w => formsCompatible(w, p)) : true) { at = i; me = p; }
				else if (alt < 0 && wanted.length && wanted[0].family === p.family) alt = i;
			}
			// A paper whose author shares the surname but not the initials: its form is shown, never counted as a co-author.
			const skip = at >= 0 ? at : alt;
			const coauthors = new Map();
			authors.forEach((a, i) => { if (i === skip) return; const p = nameParts(a?.name || [a?.firstName, a?.lastName].filter(Boolean).join(" ")); if (p?.family) coauthors.set(coauthorKey(p), a.name || p.form); });
			return { index, record, me, altForm: alt >= 0 ? authors[alt].name : "", openalexId: at >= 0 ? authors[at].openalexId || null : null,
				orcid: at >= 0 ? parseOrcid(String(authors[at].orcid || "").replace(/^https?:\/\/orcid\.org\//i, "")) : null, coauthors, venue: fold(record.venue).replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
				year: Number.isFinite(record.year) ? record.year : null, key: keyOf(record) };
		});
		const parent = items.map((_, i) => i);
		const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
		// The ORCID iDs each group carries: two groups holding different iDs are two people, whatever else they share.
		const iDs = items.map(item => new Set(item.orcid ? [item.orcid] : []));
		const conflict = (a, b) => iDs[a].size > 0 && iDs[b].size > 0 && ![...iDs[a]].some(id => iDs[b].has(id));
		const union = (a, b) => { a = find(a); b = find(b); if (a === b || conflict(a, b)) return; parent[b] = a; for (const id of iDs[b]) iDs[a].add(id); };
		const placed = items.filter(item => item.me);
		const bucket = (keyFn, join) => {
			const map = new Map();
			for (const item of placed) for (const key of [].concat(keyFn(item))) { if (!key) continue; if (!map.has(key)) map.set(key, []); map.get(key).push(item); }
			for (const list of map.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (join(list[i], list[j])) union(list[i].index, list[j].index);
		};
		bucket(item => item.orcid, () => true);
		bucket(item => item.openalexId, (a, b) => formsCompatible(a.me, b.me));
		bucket(item => [...item.coauthors.keys()], (a, b) => formsCompatible(a.me, b.me));
		const specific = p => p.initials.length >= 2 || p.full;
		bucket(item => item.venue && specific(item.me) ? item.me.family + "|" + item.me.initials + "|" + item.venue : null,
			(a, b) => a.me.initials === b.me.initials && (a.year == null || b.year == null || Math.abs(a.year - b.year) <= 8));
		const groups = new Map();
		for (const item of placed) { const root = find(item.index); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(item); }
		let big = [...groups.values()].filter(list => list.length > 1), lone = [...groups.values()].filter(list => list.length === 1).map(list => list[0]);
		const leftovers = items.filter(item => !item.me);
		for (const item of lone) {
			const fits = big.filter(list => list.some(other => formsCompatible(other.me, item.me)) && !conflict(find(list[0].index), find(item.index)));
			if (fits.length === 1) fits[0].push(item); else leftovers.push(item);
		}
		const count = (values, top) => { const map = new Map(); for (const v of values) if (v) map.set(v, (map.get(v) || 0) + 1); return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, top).map(x => x[0]); };
		const describe = (list, id, rest = false) => {
			const forms = new Map();
			for (const item of list) { const form = item.me ? item.me.form : item.altForm; if (form) forms.set(form, (forms.get(form) || 0) + 1); }
			const names = [...forms].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
			const years = list.map(item => item.year).filter(Number.isFinite), coCount = new Map();
			for (const item of list) for (const [key, name] of item.coauthors) { const e = coCount.get(key) || { name, n: 0 }; e.n++; coCount.set(key, e); }
			return { id, rest, name: rest ? "" : names[0]?.[0] || "", forms: names.map(([form, n]) => ({ form, n })), n: list.length, keys: list.map(item => item.key), indices: list.map(item => item.index),
				minYear: years.length ? Math.min(...years) : null, maxYear: years.length ? Math.max(...years) : null,
				coauthors: [...coCount.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 3).map(e => e.name),
				venue: count(list.map(item => item.record.venue), 1)[0] || "" };
		};
		big.sort((a, b) => b.length - a.length);
		const clusters = big.map((list, i) => describe(list, "p" + (i + 1)));
		const rest = leftovers.length ? describe(leftovers, "rest", true) : null;
		return { clusters, rest, typed: parsed.raw };
	}

	/* Why the figures here differ from the profile's own, as an ordered list of reason keys; [] when they agree.
	   facts: { stats (Scholar's All column), computed: { citations, hIndex }, papers, loaded, total, truncated, filtered, unverified, basis, source } */
	function explainMetrics(facts = {}) {
		const out = [], { stats, computed } = facts;
		if (facts.unverified) out.push("namesakes");
		if (facts.truncated) out.push("capped");
		else if (Number.isFinite(facts.total) && facts.loaded < facts.total) out.push("capped");
		if (facts.filtered) out.push("filtered");
		if (facts.source === "scholar" && facts.basis !== "scholar") out.push("basis");
		// An OpenAlex person's own totals, read against counts from another index.
		if (facts.source === "openalex" && facts.basis && facts.basis !== "openalex") out.push("basisOpenAlex");
		if (stats && computed && facts.source !== "scholar" && facts.source !== "openalex") out.push("otherIndex");
		// A figure the profile does not give (a merged person has no single h-index) is not a disagreement.
		const differs = key => Number.isFinite(stats?.[key]) && stats[key] !== computed?.[key];
		if (stats && computed && out.length === 0 && (differs("citations") || differs("hIndex")))
			out.push(facts.source === "openalex" ? "profileLag" : "unknown");
		return out;
	}
	/* Scholar's own per-paper counts are the default basis for Scholar results; any other result set keeps the highest-per-paper default. */
	function defaultMetricsBasis(sources, { provider, chosen } = {}) {
		if (chosen !== undefined) return chosen;
		return provider === "scholar" && sources.includes("scholar") ? "scholar" : null;
	}

	// ---------------------------------------------------------------- LinkedIn (links only: nothing is fetched from LinkedIn)
	function linkedInProfileURL(value) {
		let raw = String(value ?? "").trim();
		if (!raw || /\s/.test(raw)) return null;
		if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = "https://" + raw.replace(/^\/\//, "");
		let url;
		try { url = new URL(raw); } catch (_) { return null; }
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
		const host = url.hostname.toLowerCase();
		if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
		if (!/^\/(?:in|pub)\/[^/]+/i.test(url.pathname)) return null;
		return "https://" + host + url.pathname;
	}
	function linkedInInstitution(person) {
		const first = value => text(value).split(/[;|]/)[0].trim();
		return text(person?.institutions?.[0]) || text(person?.lastInstitution?.name) || first(person?.affiliation);
	}
	function linkedInSearchURL(person) {
		const keywords = [text(person?.name), linkedInInstitution(person)].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 120).trim();
		if (!keywords) return null;
		return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(keywords);
	}
	// What the button opens now: a LinkedIn profile ORCID listed, if one is already known, else a name and institution search.
	function linkedInTarget(person) {
		const known = linkedInProfileURL(person?.linkedin);
		if (known) return { kind: "profile", url: known };
		const url = linkedInSearchURL(person);
		return url ? { kind: "search", url } : null;
	}
	// The LinkedIn address on an ORCID record (researcher-urls), or null. One request, made only when asked for.
	async function orcidLinkedIn(id, http, ctx = {}) {
		const orcid = parseOrcid(id);
		if (!orcid) return null;
		const data = await orcidJSON(orcid, "researcher-urls", http, ctx);
		for (const item of Array.isArray(data["researcher-url"]) ? data["researcher-url"] : []) {
			const url = linkedInProfileURL(text(item?.url));
			if (url) return url;
		}
		return null;
	}

	// ---------------------------------------------------------------- the public ORCID record, condensed
	const BIO_LIMIT = 1200;
	function clampText(value, limit) {
		const plain = String(value ?? "").replace(/\s+/g, " ").trim();
		if (plain.length <= limit) return { text: plain, clamped: false };
		const cut = plain.slice(0, limit), space = cut.lastIndexOf(" ");
		return { text: cut.slice(0, space > limit * 0.6 ? space : limit).replace(/[\s.,;:]+$/, "") + "…", clamped: true };
	}
	function dateYear(value) { const year = Number(text(value?.year)); return Number.isInteger(year) && year > 1500 && year < 2200 ? year : null; }
	function affiliationRows(data, kind) {
		const rows = [];
		for (const group of Array.isArray(data?.["affiliation-group"]) ? data["affiliation-group"] : []) {
			for (const entry of Array.isArray(group?.summaries) ? group.summaries : []) {
				const item = entry?.[kind + "-summary"] || entry;
				if (!item || typeof item !== "object") continue;
				const org = text(item.organization?.name);
				if (!org) continue;
				rows.push({ role: text(item["role-title"]), department: text(item["department-name"]), org, start: dateYear(item["start-date"]), end: dateYear(item["end-date"]),
					current: !dateYear(item["end-date"]) && !item["end-date"]?.month, displayIndex: Number(item["display-index"]) || 0 });
			}
		}
		// newest first: what is still going on, then by start year
		rows.sort((a, b) => (b.current - a.current) || ((b.start ?? b.end ?? 0) - (a.start ?? a.end ?? 0)) || b.displayIndex - a.displayIndex);
		return rows.slice(0, 20).map(({ displayIndex, ...row }) => row);
	}
	/* { person, employments, educations } as ORCID returns them -> what a card can show:
	   biography (capped), keywords, websites (LinkedIn first), employments and educations newest first. */
	function summarizeOrcidRecord({ person, employments, educations } = {}) {
		const bio = clampText(text(person?.biography?.content), BIO_LIMIT);
		const keywords = [...new Set((Array.isArray(person?.keywords?.keyword) ? person.keywords.keyword : []).map(item => text(item?.content)).filter(Boolean))].slice(0, 12);
		const websites = [];
		for (const item of Array.isArray(person?.["researcher-urls"]?.["researcher-url"]) ? person["researcher-urls"]["researcher-url"] : []) {
			const raw = text(item?.url);
			let url = null;
			try { const parsed = new URL(raw); if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch (_) {}
			if (!url) continue;
			const linkedin = linkedInProfileURL(raw);
			websites.push({ name: text(item["url-name"]), url: linkedin || url, linkedin: Boolean(linkedin) });
		}
		websites.sort((a, b) => Number(b.linkedin) - Number(a.linkedin));
		const jobs = affiliationRows(employments, "employment"), studies = affiliationRows(educations, "education");
		const linkedin = websites.find(site => site.linkedin)?.url || null;
		return { bio: bio.text, bioClamped: bio.clamped, keywords, websites: websites.slice(0, 6), employments: jobs, educations: studies, linkedin,
			empty: !bio.text && !keywords.length && !websites.length && !jobs.length && !studies.length };
	}
	/* Three small public requests rather than /record, which carries every work summary too; run together,
	   only when a card's summary is opened. A section that fails is left out; all of them failing is an error. */
	async function orcidSummary(id, http, ctx = {}) {
		const orcid = parseOrcid(id);
		if (!orcid) throw new Error("Invalid ORCID profile iD");
		const parts = await Promise.allSettled(["person", "employments", "educations"].map(section => orcidJSON(orcid, section, http, ctx)));
		for (const part of parts) if (part.status === "rejected" && part.reason?.name === "AbortError") throw part.reason;
		if (parts.every(part => part.status === "rejected")) throw parts[0].reason;
		const [person, employments, educations] = parts.map(part => part.status === "fulfilled" ? part.value : null);
		return { ...summarizeOrcidRecord({ person, employments, educations }), id: orcid, capturedAt: new Date().toISOString(), partial: parts.some(part => part.status === "rejected") };
	}

	async function scholarQuery(source, query, ctx) {
		if (typeof ctx.popSearchSource !== "function") throw new Error("Google Scholar author search requires the configured Publish or Perish command-line tool");
		try {
			const result = await cancellable(() => ctx.popSearchSource(source, query, ctx), ctx);
			if (!result || !Array.isArray(result.rows) || result.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))
				|| result.provenance?.source !== source || result.provenance.engine !== "publish-or-perish"
				|| result.provenance.complete !== true) throw new Error("Invalid or incomplete Publish or Perish author response");
			if (result.provenance.cancelled) throw abortError();
			return result;
		} catch (error) {
			if (error.name === "AbortError") throw error;
			if (source === "scholar") throw error;
			throw Object.assign(new Error(error.message + ". Google Scholar profile access may require signing in or completing a CAPTCHA in Publish or Perish; then retry. You can also use the separate name-based paper search."),
				{ code: "SCHOLAR_PROFILE_ACCESS", status: error.status, reason: error.reason });
		}
	}

	function scholarProfileRow(row, provenance) {
		const inputs = [row.profile_url, row.author_url, row.article_url, row.url, row.profile_id, row.profileId, row.user_id, row.user, row.uid, row.id];
		const identities = inputs.map(value => parseScholarProfile(String(value ?? "").replace(/^(?:GSA|GSP|GS):/, ""))).filter(Boolean);
		const ids = [...new Set(identities.map(identity => identity.id))];
		if (ids.length !== 1) throw new Error("Google Scholar returned an unrecognized or ambiguous profile identity; use its profile URL or ID directly");
		let onlyAuthor = Array.isArray(row.authors) && row.authors.length === 1 ? row.authors[0] : null;
		const name = text(row.name ?? row.author ?? (typeof onlyAuthor === "string" ? onlyAuthor : onlyAuthor?.name) ?? row.title);
		return { provider: "scholar", id: ids[0], name, affiliation: text(row.affiliation ?? row.source), url: identities[0].url,
			identityConfirmed: true, mode: "profile", citations: row.cites ?? row.citations ?? null,
			provenance: clone(provenance), original: clone(row) };
	}

	async function searchProfiles(provider, input, http, ctx = {}) {
		checkCancelled(ctx);
		const value = String(input ?? "").trim();
		if (!value) throw new Error("Enter an author name or profile identifier");
		if (provider === "combined") return searchCombined(value, http, ctx);
		if (provider === "orcid") {
			const id = parseOrcid(value);
			if (!id) {
				// Something shaped like an iD, URL or OpenAlex ID that fails its checksum is a mistake, not a name.
				if (/https?:\/\/|orcid\.org|^orcid:|^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{3}[\dXx]$|^A\d+$/i.test(value)) throw new Error("Enter a valid ORCID iD or orcid.org profile URL, or type a name");
				return searchOrcidNames(value, http, ctx);
			}
			const person = await orcidJSON(id, "person", http, ctx);
			if (!["name", "biography", "other-names", "researcher-urls"].some(key => Object.hasOwn(person, key))) throw new Error("ORCID returned an invalid person schema");
			const given = text(person.name?.["given-names"]), family = text(person.name?.["family-name"]);
			const name = text(person.name?.["credit-name"]) || [given, family].filter(Boolean).join(" ");
			const provenance = { provider: "orcid", endpoint: "person", id, capturedAt: new Date().toISOString(), complete: true, publicOnly: true };
			const profiles = [{ provider: "orcid", id, name, affiliation: "", url: "https://orcid.org/" + id,
				identityConfirmed: true, mode: "profile", biography: text(person.biography?.content),
				otherNames: (person["other-names"]?.["other-name"] || []).map(item => text(item.content)).filter(Boolean),
				provenance: clone(provenance), original: clone(person) }];
			profiles.authorProvenance = provenance;
			return profiles;
		}
		if (provider !== "scholar") throw new Error("Unsupported author provider: " + provider);
		const inputKind = ctx.scholarInputKind ?? "auto";
		if (!["auto", "name", "profile"].includes(inputKind)) throw new Error("Invalid Google Scholar input kind: choose name or profile");
		const isURL = /^https?:\/\//i.test(value);
		// A twelve-letter name also satisfies Scholar's ID grammar. Only explicit
		// profile mode or a URL can resolve an alphabetic token without guessing.
		if (inputKind === "auto" && /^[A-Za-z]{12}$/.test(value)) throw new Error("This text could be an author name or a profile ID. Choose Name or Profile, or paste a Google Scholar profile URL.");
		if (inputKind === "name" && isURL) throw new Error("Choose Profile for a Google Scholar URL, or enter a name in Name mode");
		const identifier = inputKind === "name" ? null : parseScholarProfile(value);
		if (inputKind === "profile" && !identifier) throw new Error("Enter a valid Google Scholar profile URL or 12-character profile ID");
		if (identifier) {
			const provenance = { provider: "scholar", method: "provided-profile-id", complete: true, identityConfirmed: false };
			const profiles = [{ provider: "scholar", ...identifier, name: "", affiliation: "", mode: "profile", identityConfirmed: false, provenance }];
			profiles.authorProvenance = clone(provenance);
			return profiles;
		}
		if (/https?:|\/|[?&]user=/i.test(value)) throw new Error("Enter a valid Google Scholar profile URL or 12-character profile ID");
		/* Scholar's own author search, read directly. It is behind a Google
		   sign-in, and the error says so when it is; the Publish or Perish tool,
		   if one is configured, is asked only after that, and fails the same way. */
		if (typeof http?.getText === "function" && typeof ctx.DOMParser === "function") {
			let wall = null;
			try {
				const found = await cancellable(() => Sources.scholarAuthors(value, http, ctx), ctx);
				const provenance = { provider: "scholar", method: "scholar-author-search", complete: true, identityConfirmed: true, capturedAt: new Date().toISOString() };
				const profiles = found.map(p => ({ provider: "scholar", id: p.id, name: p.name, affiliation: p.affiliation, url: p.url, citations: p.citations, mode: "profile", identityConfirmed: true, provenance: clone(provenance) }));
				profiles.authorProvenance = clone(provenance);
				return profiles;
			}
			catch (error) {
				if (error.name === "AbortError") throw error;
				if (!error.wall || typeof ctx.popSearchSource !== "function") { if (error.wall) error.reason = error.wall; throw error; }
				wall = error;
			}
			try {
				const result = await scholarQuery("scholarauthor", { engine: "pop", authors: value, maxResults: 20, popOutputSort: "rank" }, ctx);
				const profiles = result.rows.map(row => scholarProfileRow(row, result.provenance));
				profiles.authorProvenance = clone(result.provenance);
				return profiles;
			}
			catch (error) { if (error.name === "AbortError") throw error; wall.reason = wall.wall; throw wall; }
		}
		const result = await scholarQuery("scholarauthor", { engine: "pop", authors: value, maxResults: 20, popOutputSort: "rank" }, ctx);
		const profiles = result.rows.map(row => scholarProfileRow(row, result.provenance));
		profiles.authorProvenance = clone(result.provenance);
		return profiles;
	}

	function publicationDate(value) {
		const year = Number(text(value?.year)), monthText = text(value?.month), dayText = text(value?.day);
		if (!Number.isInteger(year) || year < 1500 || year > 2100) return { year: null, publicationDate: null };
		let date = String(year), month = Number(monthText), day = Number(dayText);
		if (monthText && Number.isInteger(month) && month >= 1 && month <= 12) {
			date += "-" + String(month).padStart(2, "0");
			const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
			if (dayText && Number.isInteger(day) && day >= 1 && day <= lastDay) date += "-" + String(day).padStart(2, "0");
		}
		return { year, publicationDate: date };
	}
	function orcidType(type) {
		const types = { "journal-article": "journalArticle", "conference-paper": "conferencePaper", "conference-abstract": "conferencePaper",
			book: "book", "book-chapter": "bookSection", dissertation: "thesis", "dissertation-thesis": "thesis", report: "report",
			preprint: "preprint", "data-set": "dataset", dataset: "dataset", patent: "patent" };
		return Object.hasOwn(types, type) ? types[type] : "document";
	}
	function orcidWork(group, index, profile) {
		const summaries = group?.["work-summary"];
		if (!Array.isArray(summaries) || !summaries.length || summaries.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("ORCID returned an invalid work group at index " + index);
		const summary = summaries.reduce((preferred, row) => Number(row["display-index"] || 0) > Number(preferred["display-index"] || 0) ? row : preferred);
		const external = summary["external-ids"]?.["external-id"] || [];
		if (!Array.isArray(external)) throw new Error("ORCID returned invalid work identifiers");
		const dois = [...new Set(external.filter(id => id?.["external-id-type"]?.toLowerCase() === "doi" && id["external-id-relationship"] === "self")
			.map(id => Sources.normalizeDOI(text(id["external-id-value"]))).filter(Boolean))];
		const doi = dois.length === 1 ? dois[0] : null;
		const record = Sources.makeRecord({ source: "orcid", sourceId: profile.id + ":" + (summary["put-code"] ?? "group-" + index),
			title: text(summary.title?.title), venue: text(summary["journal-title"]), ...publicationDate(summary["publication-date"]),
			doi, url: text(summary.url) || null, authors: [], citations: null, itemType: orcidType(summary.type),
			orcid: profile.id, orcidPutCode: summary["put-code"] ?? null, orcidType: summary.type ?? null,
			orcidOriginal: clone(group), authorListComplete: false, attribution: "listed-on-orcid-record",
			externalIds: clone(external), metadataWarnings: dois.length > 1 ? ["Conflicting self DOIs; no DOI was selected"] : [] });
		record.key = "orcid:" + profile.id + ":group:" + index;
		return record;
	}

	async function loadPublications(profile, options = {}, http, ctx = {}) {
		checkCancelled(ctx);
		if (!profile || !["orcid", "scholar", "combined"].includes(profile.provider)) throw new Error("Select a supported author profile");
		const maxResults = limit(options);
		if (profile.provider === "combined") return loadCombinedPublications(profile, options, maxResults, http, ctx);
		if (profile.provider === "scholar") {
			const identity = parseScholarProfile(profile.id);
			if (!identity) throw new Error("Invalid Google Scholar profile ID");
			if (typeof http?.getText === "function" && typeof ctx.DOMParser === "function") {
				let wall = null;
				try {
					const page = await cancellable(() => Sources.scholarProfile(identity.id, http, ctx, { maxResults, sort: options.sort }), ctx);
					const actual = { ...profile, id: identity.id, url: identity.url, name: page.profile.name || profile.name, affiliation: page.profile.affiliation || profile.affiliation,
						hIndex: page.profile.hIndex ?? null, citations: page.profile.citations ?? null, identityConfirmed: true,
							scholarStats: ["citations", "hIndex", "i10"].some(key => Number.isFinite(page.profile[key])) ? { citations: page.profile.citations ?? null, hIndex: page.profile.hIndex ?? null, i10: page.profile.i10 ?? null,
								sinceYear: page.profile.sinceYear ?? null, since: page.profile.since ?? null } : undefined };
					const provenance = { provider: "scholar", mode: "profile", method: "scholar-profile-page", authorId: identity.id, capturedAt: new Date().toISOString(),
						identityConfirmed: true, complete: page.complete, returned: page.records.length, truncated: !page.complete, citationCountsAvailable: true, authorListComplete: false };
					return attach(page.records, actual, provenance, ctx);
				}
				catch (error) {
					if (error.name === "AbortError") throw error;
					if (!error.wall || typeof ctx.popSearchSource !== "function") { if (error.wall) error.reason = error.wall; throw error; }
					wall = error;
				}
				try {
					const result = await scholarQuery("scholarprofile", { engine: "pop", authors: identity.id, maxResults, popOutputSort: options.popOutputSort || "rank" }, ctx);
					const records = Sources.normalizePoPExactRecords(result.rows, "scholarprofile", result.provenance);
					const actual = { ...profile, id: identity.id, url: identity.url, identityConfirmed: profile.identityConfirmed === true || result.rows.length > 0 };
					return attach(records, actual, { ...clone(result.provenance), provider: "scholar", mode: "profile", authorId: identity.id, identityConfirmed: actual.identityConfirmed }, ctx);
				}
				catch (error) { if (error.name === "AbortError") throw error; wall.reason = wall.wall; throw wall; }
			}
			const result = await scholarQuery("scholarprofile", { engine: "pop", authors: identity.id, maxResults, popOutputSort: options.popOutputSort || "rank" }, ctx);
			const records = Sources.normalizePoPExactRecords(result.rows, "scholarprofile", result.provenance);
			const actual = { ...profile, id: identity.id, url: identity.url, identityConfirmed: profile.identityConfirmed === true || result.rows.length > 0 };
			return attach(records, actual, { ...clone(result.provenance), provider: "scholar", mode: "profile", authorId: identity.id, identityConfirmed: actual.identityConfirmed }, ctx);
		}
		const id = parseOrcid(profile.id);
		if (!id) throw new Error("Invalid ORCID profile iD");
		/* OpenAlex first: it carries the byline, venue, citations and yearly counts that an ORCID work
		   summary does not. It is skipped when asked to be (options.orcidOnly), when its budget is spent,
		   and falls through to the ORCID record when it errors or knows no works under this iD. */
		if (!options.orcidOnly && !ctx.openAlexSpent) {
			// An empty OpenAlex answer must not blank the window before the ORCID list is read.
			const outer = ctx.onResults;
			if (outer) ctx.onResults = (records, details) => { if (records.length) outer(records, details); };
			try {
				const found = await Sources.search("openalex", { authors: id, sort: "date", maxResults }, http, ctx);
				if (found.length) {
					const actual = { ...profile, id, url: "https://orcid.org/" + id, identityConfirmed: true };
					const total = Number.isFinite(profile.worksCount) ? profile.worksCount : null;
					const truncated = found.length >= maxResults && (total == null || total > found.length);
					return attach(found, actual, { provider: "orcid", id, endpoint: "openalex-works", via: "openalex", capturedAt: new Date().toISOString(),
						publicOnly: false, mode: "profile", identityConfirmed: true, totalGroups: total, returned: found.length, truncated, complete: !truncated,
						authorListComplete: true, citationCountsAvailable: true }, ctx);
				}
			} catch (error) {
				if (error.name === "AbortError") throw error;
				ctx.log?.("OpenAlex works for ORCID " + id + " failed, using the ORCID record: " + error.message);
			} finally { if (outer) ctx.onResults = outer; }
		}
		const data = await orcidJSON(id, "works", http, ctx);
		if (!Array.isArray(data.group)) throw new Error("ORCID returned an invalid works schema");
		const actual = { ...profile, id, url: "https://orcid.org/" + id, identityConfirmed: true };
		// /works returns all public groups in one response; each group is one work,
		// and display-index selects its preferred assertion without merging by title.
		// Newest first before the cap, so a limit keeps the latest works rather than whatever ORCID listed first.
		const records = data.group.map((group, index) => orcidWork(group, index, actual))
			.sort((a, b) => String(b.publicationDate || "").localeCompare(String(a.publicationDate || "")))
			.slice(0, maxResults);
		// The DOIs ask OpenAlex for their citation counts; the list keeps ORCID's order and the window sorts it.
		if (records.some(record => record.doi) && !ctx.openAlexSpent && typeof http?.getJSON === "function") {
			try {
				await Sources.enrichFromOpenAlex(records, { getJSON: (url, headers) => cancellable(() => http.getJSON(url, headers, ctx.signal), ctx) }, ctx);
			} catch (error) { if (error.name === "AbortError") throw error; ctx.log?.("OpenAlex DOI enrichment failed: " + error.message); }
		}
		const provenance = { provider: "orcid", id, endpoint: "works", capturedAt: new Date().toISOString(),
			publicOnly: true, mode: "profile", identityConfirmed: true, totalGroups: data.group.length,
			returned: records.length, truncated: data.group.length > maxResults, complete: data.group.length <= maxResults, via: "orcid",
			authorListComplete: false, citationCountsAvailable: records.some(record => record.citations != null) };
		return attach(records, actual, provenance, ctx);
	}

	/* A merged person: their OpenAlex works by author id when it is known, else (or when that fails or is
	   empty) through the ORCID path. The records carry the merged identity either way. */
	async function loadCombinedPublications(profile, options, maxResults, http, ctx) {
		const openalexId = oaAuthorId(profile.openalexId), orcid = parseOrcid(profile.orcid);
		if (!openalexId && !orcid) throw new Error("Select a supported author profile");
		const actual = { ...profile, provider: "combined", id: profile.id || openalexId || orcid, identityConfirmed: true };
		const retag = (records, provenance) => {
			const identity = profileIdentity(actual);
			for (const record of records) { record.authorProfile = clone(identity); record.authorProvenance = clone(provenance); }
			records.authorProfile = records.profile = clone(identity); records.authorProvenance = records.provenance = clone(provenance);
			ctx.authorProvenance = clone(provenance);
			return records;
		};
		let triedOpenAlex = false;
		if (openalexId && !options.orcidOnly && !ctx.openAlexSpent && !(orcid && profile.alsoIds?.length)) {
			triedOpenAlex = true;
			const outer = ctx.onResults;
			if (outer) ctx.onResults = (records, details) => { if (records.length) outer(records, details); };
			try {
				const found = await Sources.search("openalex", { authors: openalexId, sort: "date", maxResults }, http, ctx);
				if (found.length) {
					const total = Number.isFinite(profile.worksCount) ? profile.worksCount : null;
					const truncated = found.length >= maxResults && (total == null || total > found.length);
					return attach(found, actual, { provider: "combined", id: actual.id, openalexId, orcid: orcid || null, endpoint: "openalex-works", via: "openalex", capturedAt: new Date().toISOString(),
						publicOnly: false, mode: "profile", identityConfirmed: true, totalGroups: total, returned: found.length, truncated, complete: !truncated,
						authorListComplete: true, citationCountsAvailable: true }, ctx);
				}
			} catch (error) {
				if (error.name === "AbortError") throw error;
				if (!orcid) throw error;
				ctx.log?.("OpenAlex works for " + openalexId + " failed, using ORCID: " + error.message);
			} finally { if (outer) ctx.onResults = outer; }
		}
		if (!orcid) throw new Error("OpenAlex has no works under " + openalexId);
		const inner = { ...actual, provider: "orcid", id: orcid };
		const records = await loadPublications(inner, { ...options, orcidOnly: options.orcidOnly || triedOpenAlex }, http, ctx);
		return retag(records, { ...records.authorProvenance, provider: "combined", openalexId: openalexId || null });
	}

	async function loadNamePublications(name, options = {}, http, ctx = {}, provider = "scholar") {
		const authors = String(name ?? "").trim();
		if (!authors) throw new Error("Enter an author name for the separate name-based paper search");
		if (provider === "combined") {
			// OpenAlex resolves the name to its author profiles and returns all of their works together.
			const maxResults = limit(options);
			const profile = { provider: "combined", id: null, name: authors, affiliation: "", url: "", mode: "name-search", identityConfirmed: false };
			// Every streamed batch already says whose it is not: a window drawing it (or keeping it after Stop)
			// must ask for the person before any figure, not compute one over namesakes.
			const outer = ctx.onResults, identity = profileIdentity(profile);
			if (outer) ctx.onResults = (records, details) => {
				for (const record of records) if (!record.authorProfile) record.authorProfile = clone(identity);
				outer(records, details);
			};
			let found;
			try { found = await Sources.search("openalex", { authors, sort: "date", maxResults }, http, ctx); }
			finally { if (outer) ctx.onResults = outer; }
			return attach(found, profile, { provider: "combined", mode: "name-search", via: "openalex", endpoint: "openalex-works", identityConfirmed: false, capturedAt: new Date().toISOString(),
				returned: found.length, truncated: found.length >= maxResults, complete: found.length < maxResults, authorListComplete: true, citationCountsAvailable: true }, ctx);
		}
		const result = await scholarQuery("scholar", { engine: "pop", authors, maxResults: limit(options), popOutputSort: options.popOutputSort || "rank" }, ctx);
		const records = Sources.normalizePoPExactRecords(result.rows, "scholar", result.provenance);
		const profile = { provider: "scholar", id: null, name: authors, affiliation: "", url: "", mode: "name-search", identityConfirmed: false };
		return attach(records, profile, { ...clone(result.provenance), provider: "scholar", mode: "name-search", identityConfirmed: false }, ctx);
	}

	return { searchProfiles, moreProfiles, hasMorePeople, OA_AUTHOR_ROWS, ORCID_ROWS, loadPublications, rankCombinedCandidates, clusterPeople, nameParts, formsCompatible, explainMetrics, defaultMetricsBasis, loadNamePublications, parseScholarProfile, parseOrcid, parseNameInput, orcidNameQuery, rankOrcidCandidates,
		linkedInProfileURL, linkedInSearchURL, linkedInTarget, orcidLinkedIn, summarizeOrcidRecord, orcidSummary };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPAuthors;
