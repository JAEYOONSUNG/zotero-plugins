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
		return { provider: profile.provider, id: profile.id ?? null, name: profile.name || "", affiliation: profile.affiliation || "",
			url: profile.url || "", mode: profile.mode || "profile", identityConfirmed: profile.identityConfirmed === true };
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

	async function orcidJSON(id, section, http, ctx) {
		if (typeof http?.getJSON !== "function") throw new Error("ORCID requires a JSON HTTP transport");
		const headers = { Accept: "application/json" };
		if (ctx.orcidAccessToken) {
			if (typeof ctx.orcidAccessToken !== "string" || /[\r\n\0]/.test(ctx.orcidAccessToken)) throw new Error("Invalid ORCID access token");
			headers.Authorization = "Bearer " + ctx.orcidAccessToken;
		}
		try {
			const result = await cancellable(() => http.getJSON("https://pub.orcid.org/v3.0/" + id + "/" + section, headers, ctx.signal), ctx);
			if (!result || typeof result !== "object" || Array.isArray(result)
				|| result.path && result.path !== "/" + id + "/" + section) throw new Error("ORCID returned an invalid " + section + " response");
			return result;
		} catch (error) {
			if (error.name === "AbortError") throw error;
			if ([401, 403].includes(error.status)) throw Object.assign(new Error("ORCID public access was denied. Configure an ORCID public API token or retry through the public record."), { status: error.status, code: "ORCID_ACCESS_REQUIRED" });
			if (error.status === 404) throw Object.assign(new Error("ORCID record was not found: " + id), { status: 404 });
			if (error.status === 429) throw Object.assign(new Error("ORCID rate limit reached. Retry later."), { status: 429 });
			throw error;
		}
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
		if (provider === "orcid") {
			const id = parseOrcid(value);
			if (!id) throw new Error("Enter a valid ORCID iD or orcid.org profile URL; ORCID name search is not available in this mode");
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
		if (!profile || !["orcid", "scholar"].includes(profile.provider)) throw new Error("Select a supported author profile");
		const maxResults = limit(options);
		if (profile.provider === "scholar") {
			const identity = parseScholarProfile(profile.id);
			if (!identity) throw new Error("Invalid Google Scholar profile ID");
			if (typeof http?.getText === "function" && typeof ctx.DOMParser === "function") {
				let wall = null;
				try {
					const page = await cancellable(() => Sources.scholarProfile(identity.id, http, ctx, { maxResults, sort: options.sort }), ctx);
					const actual = { ...profile, id: identity.id, url: identity.url, name: page.profile.name || profile.name, affiliation: page.profile.affiliation || profile.affiliation,
						hIndex: page.profile.hIndex ?? null, citations: page.profile.citations ?? null, identityConfirmed: true };
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
		const data = await orcidJSON(id, "works", http, ctx);
		if (!Array.isArray(data.group)) throw new Error("ORCID returned an invalid works schema");
		const actual = { ...profile, id, url: "https://orcid.org/" + id, identityConfirmed: true };
		// /works returns all public groups in one response; each group is one work,
		// and display-index selects its preferred assertion without merging by title.
		const records = data.group.map((group, index) => orcidWork(group, index, actual)).slice(0, maxResults);
		const provenance = { provider: "orcid", id, endpoint: "works", capturedAt: new Date().toISOString(),
			publicOnly: true, mode: "profile", identityConfirmed: true, totalGroups: data.group.length,
			returned: records.length, truncated: data.group.length > maxResults, complete: data.group.length <= maxResults,
			authorListComplete: false, citationCountsAvailable: false };
		return attach(records, actual, provenance, ctx);
	}

	async function loadNamePublications(name, options = {}, _http, ctx = {}) {
		const authors = String(name ?? "").trim();
		if (!authors) throw new Error("Enter an author name for the separate name-based paper search");
		const result = await scholarQuery("scholar", { engine: "pop", authors, maxResults: limit(options), popOutputSort: options.popOutputSort || "rank" }, ctx);
		const records = Sources.normalizePoPExactRecords(result.rows, "scholar", result.provenance);
		const profile = { provider: "scholar", id: null, name: authors, affiliation: "", url: "", mode: "name-search", identityConfirmed: false };
		return attach(records, profile, { ...clone(result.provenance), provider: "scholar", mode: "name-search", identityConfirmed: false }, ctx);
	}

	return { searchProfiles, loadPublications, loadNamePublications, parseScholarProfile, parseOrcid };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPAuthors;
