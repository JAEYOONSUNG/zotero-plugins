/* Finding what to read next: papers related to one you have, and what a given
   author is publishing now. Pure URL building and response shaping; the caller
   makes every request. Backed by OpenAlex, which needs no key. */
(function (root) {
  'use strict';

  const API = 'https://api.openalex.org/';
  const text = value => String(value == null ? '' : value).trim();
  const bareDOI = value => text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
  const shortID = value => text(value).replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase();

  // A key raises the daily budget but is optional; a mailto gets the polite pool.
  function credentials({email, apiKey} = {}) {
    return (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '')
      + (email ? '&mailto=' + encodeURIComponent(email) : '');
  }

  const WORK_FIELDS = 'id,doi,title,publication_year,cited_by_count,type,'
    + 'primary_location,authorships,related_works,referenced_works,open_access,topics';

  function workURL(record, options = {}) {
    const doi = bareDOI(record?.DOI || record?.doi);
    if (doi) return `${API}works/doi:${encodeURIComponent(doi)}?select=${WORK_FIELDS}${credentials(options)}`;
    const title = text(record?.title);
    if (!title) return null;
    // Without a DOI, the title search is the only handle, so ask for one result.
    return `${API}works?per_page=1&filter=${encodeURIComponent('title.search:' + title)}`
      + `&select=${WORK_FIELDS}${credentials(options)}`;
  }

  // OpenAlex caps a filter list; batching keeps the URL inside its limits.
  function worksByIDsURL(ids, options = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(shortID).filter(Boolean))].slice(0, 50);
    if (!list.length) return null;
    return `${API}works?per_page=${list.length}`
      + `&filter=${encodeURIComponent('openalex_id:' + list.join('|'))}`
      + `&select=${WORK_FIELDS}${credentials(options)}`;
  }

  // OpenAlex classifies a work at four widening levels. Keeping all four lets a
  // candidate be scored on how closely it sits to the paper in hand.
  function subjectsOf(raw) {
    const topics = Array.isArray(raw?.topics) ? raw.topics : [];
    const pick = (list, key) => new Set(list.map(t => shortID(t?.[key]?.id)).filter(Boolean));
    return {
      topic: new Set(topics.map(t => shortID(t?.id)).filter(Boolean)),
      subfield: pick(topics, 'subfield'),
      field: pick(topics, 'field'),
      domain: pick(topics, 'domain')
    };
  }

  const shares = (a, b) => [...(a || [])].some(id => b?.has(id));

  // OpenAlex's related_works can be plainly wrong -- a Russian pedagogy paper
  // turns up beside a bacterial condensin study -- so a candidate has to sit in
  // the same part of the literature to be worth showing at all.
  function relevance(work, source) {
    if (!work?.subjects || !source?.subjects) return 0;
    if (shares(work.subjects.topic, source.subjects.topic)) return 3;
    if (shares(work.subjects.subfield, source.subjects.subfield)) return 2;
    if (shares(work.subjects.field, source.subjects.field)) return 1;
    return 0;
  }

  function shapeWork(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = shortID(raw.id);
    if (!id) return null;
    // Keep each author's OpenAlex id. Looking one up by name alone picks the
    // wrong person: "Eugene Kim" matches a surgeon before the biophysicist.
    const people = (Array.isArray(raw.authorships) ? raw.authorships : [])
      .map(a => ({
        id: shortID(a?.author?.id),
        name: text(a?.author?.display_name),
        institution: text((Array.isArray(a?.institutions) ? a.institutions : [])[0]?.display_name),
        position: text(a?.author_position)
      }))
      .filter(a => a.name);
    const authors = people.map(a => a.name);
    return {
      id, doi: bareDOI(raw.doi), title: text(raw.title),
      year: Number.isInteger(raw.publication_year) ? raw.publication_year : null,
      citations: Number.isInteger(raw.cited_by_count) ? raw.cited_by_count : null,
      venue: text(raw.primary_location?.source?.display_name),
      authors, people, type: text(raw.type),
      openAccess: raw.open_access?.is_oa === true,
      pdfURL: text(raw.primary_location?.pdf_url) || text(raw.open_access?.oa_url),
      related: (Array.isArray(raw.related_works) ? raw.related_works : []).map(shortID).filter(Boolean),
      references: (Array.isArray(raw.referenced_works) ? raw.referenced_works : []).map(shortID).filter(Boolean),
      subjects: subjectsOf(raw)
    };
  }

  // A /works/doi: lookup returns the work itself; a title search returns a list.
  function readWork(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.results)) return shapeWork(payload.results[0]);
    return shapeWork(payload);
  }
  const readWorks = payload => (Array.isArray(payload?.results) ? payload.results : [])
    .map(shapeWork).filter(Boolean);

  // OpenAlex's own related_works come first; references fill the rest, because a
  // paper's own bibliography is the most reliable "read this next" there is.
  // Papers that cite this one are the strongest signal, then the ones it chose
  // to cite; OpenAlex's computed "related" is the weakest and goes last.
  const GROUPS = ['citing', 'reference', 'related'];
  const GROUP_RANK = new Map(GROUPS.map((name, i) => [name, i]));

  function mergeSuggestions(work, found, {have = new Set(), limit = 40, citing = []} = {}) {
    if (!work) return [];
    const byID = new Map(found.map(w => [w.id, w]));
    for (const cited of citing) byID.set(cited.id, cited);
    const rank = new Map();
    citing.forEach((w, i) => rank.set(w.id, {source: 'citing', order: i}));
    work.references.forEach((id, i) => { if (!rank.has(id)) rank.set(id, {source: 'reference', order: i}); });
    work.related.forEach((id, i) => { if (!rank.has(id)) rank.set(id, {source: 'related', order: i}); });
    rank.delete(work.id);
    const owned = new Set([...have].map(value => bareDOI(value)).filter(Boolean));
    return [...rank.entries()]
      .map(([id, meta]) => {
        const hit = byID.get(id);
        if (!hit) return null;
        const score = relevance(hit, work);
        // Nothing in common with the source paper is noise, whatever list it came from.
        if (!score) return null;
        return {...hit, ...meta, relevance: score, inLibrary: !!hit.doi && owned.has(hit.doi)};
      })
      .filter(Boolean)
      .sort((a, b) => GROUP_RANK.get(a.source) - GROUP_RANK.get(b.source)
        || b.relevance - a.relevance
        || (b.citations ?? 0) - (a.citations ?? 0))
      .slice(0, limit);
  }

  // Papers that cite this one, newest and most-cited first.
  const citingURL = (workID, options = {}) => shortID(workID).startsWith('W')
    ? `${API}works?per_page=${Math.min(50, options.limit || 25)}`
      + `&filter=${encodeURIComponent('cites:' + shortID(workID))}`
      + `&sort=cited_by_count:desc&select=${WORK_FIELDS}${credentials(options)}`
    : null;

  // Matching an author by name alone picks the wrong person often enough to be
  // useless. An institution narrows it decisively, so it is scored first and a
  // name-only match is only accepted when nothing else is close.

  // NFKD pulls the accent off "é" but leaves letters that are not an accented
  // Latin base alone. OpenAlex's index carries names built out of them --
  // "Vı́ctor de Lorenzo" is a dotless i plus a combining acute -- and without
  // folding those, a search for Victor never reaches him.
  const FOLD = {'ı': 'i', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss',
    'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ħ': 'h', 'ŋ': 'n'};

  const plain = value => text(value).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[ıøæœßđðþłħŋ]/g, ch => FOLD[ch] || ch)
    .replace(/[^a-z0-9]+/g, ' ').trim();

  const normalise = value => plain(value)
    .replace(/\b(university|universite|universiteit|universitat|univ|college|institute|institut|school|of|the|for|and|at)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  // "Ruben L Gonzalez Jr" ends in a generation, not in a family name, and the
  // family name is the one part that has to agree. Left in, it made the search
  // go looking for a Ruben whose surname was "Jr".
  const SUFFIXES = new Set(['jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv']);
  // A particle is part of the family name, not a name of its own.
  const PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'dos', 'du', 'van', 'von',
    'der', 'den', 'ter', 'la', 'le', 'el', 'al', 'bin', 'ibn']);
  function withoutSuffix(parts) {
    const kept = [...parts];
    while (kept.length > 2 && SUFFIXES.has(plain(kept[kept.length - 1]))) kept.pop();
    return kept;
  }

  const nameParts = value => withoutSuffix(normalise(value).split(' ').filter(Boolean));
  const fullName = value => nameParts(value).join(' ');

  // Equal, one letter changed, one letter dropped or added, or two adjacent
  // letters swapped -- the shapes a name takes when it is typed from memory.
  function withinOneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
      && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const left = a.length - head - tail, right = b.length - head - tail;
    if (left <= 1 && right <= 1) return true;
    return a.length === b.length && left === 2 && right === 2
      && a[head] === b[head + 1] && a[head + 1] === b[head];
  }

  // A family name typed one letter short ("Cheemeng Ta" for Cheemeng Tan) is a
  // slip of the hand. A family name with a letter *changed* ("Laue" for "Laub")
  // is a different family, so only the dropped letter is ever forgiven.
  const droppedLetter = (a, b) => a !== b && Math.abs(a.length - b.length) === 1
    && (a.length > b.length ? a.startsWith(b) : b.startsWith(a));

  // Everyday short forms, used to build one extra query and nothing else. The
  // table is deliberately one-directional and short: it exists to find a person
  // the index files under their full name, not to license loose matching.
  const NICKNAMES = new Map(Object.entries({
    alex: ['alexander', 'alexandra'], andy: ['andrew'], bea: ['beatrice'], ben: ['benjamin'],
    beth: ['elizabeth'], bill: ['william'], bob: ['robert'], cathy: ['catherine'],
    chris: ['christopher', 'christine'], dan: ['daniel'], dave: ['david'], deb: ['deborah'],
    dick: ['richard'], don: ['donald'], ed: ['edward'], fran: ['frances', 'francis'],
    greg: ['gregory'], jeff: ['jeffrey'], jen: ['jennifer'], jenn: ['jennifer'],
    jim: ['james'], joe: ['joseph'], jon: ['jonathan'], kate: ['katherine'], ken: ['kenneth'],
    liz: ['elizabeth'], matt: ['matthew'], mike: ['michael'], nick: ['nicholas'],
    pete: ['peter'], phil: ['philip', 'phillip'], rick: ['richard'], rob: ['robert'],
    ron: ['ronald'], sam: ['samuel'], steve: ['steven', 'stephen'], sue: ['susan'],
    ted: ['edward', 'theodore'], tim: ['timothy'], tom: ['thomas'], tony: ['anthony'],
    vic: ['victor'], will: ['william']
  }));
  const expansions = part => NICKNAMES.get(plain(part)) || [];

  // How much a query has guessed at, and so how much its answer has to prove.
  // '' is the name as recorded; 'expansion' is a short form written out in full;
  // 'fragment' is one part of the name on its own. Both guesses need the place.
  const confirmsPlace = confirm => confirm === 'expansion' || confirm === 'fragment';
  const givenAgrees = (wanted, got) => wanted === got || withinOneEdit(wanted, got)
    || expansions(wanted).includes(got) || expansions(got).includes(wanted);

  // A place is recorded the way the watcher thinks of it, which is rarely the
  // way OpenAlex spells it.
  const initialsOf = home => plain(home).split(' ').filter(word => word.length > 3)
    .map(word => word[0]).join('');

  function institutionAgrees(candidate, institution) {
    const place = normalise(institution);
    if (!place) return false;
    const words = place.split(' ').filter(word => word.length > 2);
    // An acronym is how people write a place they know well, and OpenAlex never
    // abbreviates. A record shouted in full capitals says nothing about which of
    // its words is an abbreviation, so only a record that is otherwise mixed
    // case -- or that is nothing but the abbreviation -- offers one.
    const tokens = text(institution).split(/[^A-Za-z]+/).filter(Boolean);
    const shouts = (/[a-z]/.test(text(institution)) || tokens.length === 1)
      ? tokens
        .filter(token => token.length >= 3 && token.length <= 6 && token === token.toUpperCase())
        .map(token => token.toLowerCase())
      : [];
    for (const home of (candidate?.institutions || [])) {
      const known = normalise(home).split(' ').filter(Boolean);
      // A whole word, not a word inside a word: matching on substrings put
      // "Ohio state university" inside "Guardian Industries (United States)"
      // and handed a watcher of archaeal chromosomes a political cartoonist.
      const shared = words.some(word => known.some(part => part === word
        // One mistyped letter in a long word still names the same place: "UC
        // berkely" is the Berkeley campus, not some other university.
        || (word.length >= 6 && part.length >= 6 && withinOneEdit(word, part))));
      if (shared) return true;
      // Three letters at least: "UC" is the University of Cambridge as readily
      // as the University of California, and it put David B. Savage of
      // Cambridge inside "UC berkely".
      const acronym = initialsOf(home);
      if (acronym.length >= 3 && shouts.includes(acronym)) return true;
    }
    return false;
  }

  // A recorded interest counts as met when one of its words turns up in a topic
  // OpenAlex assigns the author: inside a topic word ("phage" in
  // "Bacteriophages"), or sharing a five-letter stem with one ("synthetic" and
  // "synthesis"). Five is the floor because shorter stems -- "bio", "gene" --
  // match nearly every life-science topic and so prove nothing.
  const STEM = 5;
  const TOPIC_NOISE = new Set(['research', 'studies', 'study', 'analysis', 'science',
    'sciences', 'general', 'other', 'various', 'applications', 'techniques', 'methods',
    'approaches', 'advanced', 'related', 'fields']);

  function topicsAgree(candidate, topics) {
    const wanted = plain(topics).split(' ')
      .filter(word => word.length >= STEM && !TOPIC_NOISE.has(word));
    if (!wanted.length) return false;
    const vocabulary = new Set((candidate?.topics || [])
      .flatMap(topic => plain(topic?.name).split(' ')).filter(Boolean));
    if (!vocabulary.size) return false;
    return wanted.some(word => [...vocabulary].some(other => {
      if (other.length >= STEM && other.includes(word)) return true;
      if (other.length >= STEM && word.includes(other)) return true;
      let shared = 0;
      while (shared < word.length && shared < other.length && word[shared] === other[shared]) shared++;
      return shared >= STEM;
    }));
  }

  function scoreAuthor(candidate, {name, institution, topics, confirm} = {}) {
    const wanted = nameParts(name);
    const got = nameParts(candidate?.name);
    if (!wanted.length || !got.length) return 0;
    // The family name is the one part that must agree. Only a last-resort query,
    // which has to confirm the institution anyway, may forgive a dropped final
    // letter -- and then the given name has to be word-for-word right, so
    // "Cheemeng Ta" reaches Cheemeng Tan while "Michael Laue" never reaches Laub.
    if (wanted[wanted.length - 1] !== got[got.length - 1]) {
      if (confirm !== 'fragment' || wanted[0] !== got[0]
        || !droppedLetter(wanted[wanted.length - 1], got[got.length - 1])) return 0;
    }
    // A loose query casts wide -- a surname on its own pulls in every Nielsen --
    // so the given name has to hold up too, as itself, one typo away, or the
    // short form of what was found.
    if (confirmsPlace(confirm) && wanted.length > 1 && got.length > 1
      && !givenAgrees(wanted[0], got[0])) return 0;
    let score = 1;
    if (wanted.length > 1 && got.length > 1) {
      if (wanted[0] === got[0]) score += 2;
      else if (wanted[0][0] === got[0][0]) score += 1;
    }
    if (institutionAgrees(candidate, institution)) score += 4;
    // OpenAlex often records a former affiliation, so the institution cannot be
    // relied on alone. Standing can, but only as a tie-break: capping it would
    // flatten two well-known namesakes onto the same ceiling.
    return score + Math.min(3, (candidate?.hIndex || 0) / 25);
  }

  // OpenAlex sometimes files one person twice -- Peter Jorth has a 72-work
  // record and a 2-work one, both at Cedars-Sinai. The copies share an ORCID,
  // the one identifier a person owns, so they are not an ambiguous field at all;
  // folding them together is what lets the real record clear the margin.
  function collapseDuplicates(candidates) {
    const held = new Map();
    const kept = [];
    for (const candidate of (Array.isArray(candidates) ? candidates : []).filter(Boolean)) {
      const key = plain(candidate.orcid);
      if (!key) { kept.push(candidate); continue; }
      const seen = held.get(key);
      if (!seen) { held.set(key, candidate); kept.push(candidate); continue; }
      if ((candidate.works || 0) > (seen.works || 0)) {
        kept[kept.indexOf(seen)] = candidate;
        held.set(key, candidate);
      }
    }
    return kept;
  }

  // Comparing standing as a ratio keeps two eminent namesakes apart, where a
  // capped score cannot.
  const dominates = (best, next) => {
    const top = best?.candidate?.hIndex || 0, rival = next?.candidate?.hIndex || 0;
    return top >= 10 && top >= rival * 2;
  };

  // Every part of the recorded name accounted for, give or take the one dropped
  // final letter the family name is allowed.
  const wholeNameAgrees = (candidate, name) => {
    const wanted = nameParts(name), got = nameParts(candidate?.name);
    if (!wanted.length || wanted.length !== got.length) return false;
    return wanted.every((part, i) => part === got[i]
      || (i === wanted.length - 1 && droppedLetter(part, got[i])));
  };

  // Returns the best candidate, or null when nothing is clearly right. Watching
  // the wrong person is worse than watching nobody, so an unclear field is
  // refused rather than guessed: without a matching institution the leader has
  // to dominate outright.
  function pickAuthor(candidates, wanted = {}) {
    const ranked = collapseDuplicates(candidates)
      .map(candidate => ({candidate, score: scoreAuthor(candidate, wanted)}))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const answer = row => ({...row.candidate, matchScore: row.score});
    const [best, next] = ranked;

    // A guessed query only earns an answer the recorded place confirms.
    if (confirmsPlace(wanted.confirm)
      && !institutionAgrees(best.candidate, wanted.institution)) return null;
    // A fragment of a name retrieves an arbitrary ten out of a very large field
    // -- a surname on its own pulls in ten unrelated Weisses -- so being the
    // only one left proves nothing: it may be only what the name test discarded.
    // A lone survivor there has to account for every part of the recorded name,
    // which "Ron J. Weiss" does not do for a watched "Ron Weiss".
    if (wanted.confirm === 'fragment' && !next
      && !wholeNameAgrees(best.candidate, wanted.name)) return null;
    // A guessed query has stepped away from what was written down, so its answer
    // answers to the rest of what was written down: where anyone it found does
    // the recorded work, the leader has to be one of them. "Steve Bell" of Ohio
    // expanded to Stephen leads with a growth-hormone lab at Ohio University,
    // ahead of the archaeal chromosome lab OpenAlex files under a stale company
    // address -- and the recorded "archaea chromosome" is what says so.
    if (confirmsPlace(wanted.confirm)
      && ranked.some(row => topicsAgree(row.candidate, wanted.topics))
      && !topicsAgree(best.candidate, wanted.topics)) return null;

    if (!next) return answer(best);

    // What the watcher wrote down about the work separates the two in front,
    // because what a person works on identifies them and a citation count does
    // not. It speaks only where the score was going to decide by coin-flip, and
    // there it cuts both ways: the rival doing that work is taken over a
    // slightly better-cited namesake, and a leader doing none of it is refused
    // rather than guessed at. Keeping it inside the coin-flip is what makes it
    // safe -- these topics are typed by hand, and words like "library" or
    // "machine learning" turn up under namesakes who share nothing else.
    const close = best.score - next.score < 1;
    const works = row => topicsAgree(row.candidate, wanted.topics);
    if (close && works(best) !== works(next)) {
      const meant = works(best) ? best : next;
      // Promotion needs the place; the leader, already ahead on name, does not.
      return meant === best || institutionAgrees(meant.candidate, wanted.institution)
        ? answer(meant) : null;
    }

    // A matching institution is decisive; a small score margin is then enough.
    if (institutionAgrees(best.candidate, wanted.institution)) {
      if (!close) return answer(best);
      // Standing settles it here for the same reason it does without a place.
      if (dominates(best, next)) return answer(best);
      // The recorded name matched part for part outweighs a namesake carrying an
      // extra initial -- but only from the better-established of the two, so a
      // thin duplicate record can never win on the strength of its spelling.
      if (fullName(best.candidate?.name) === fullName(wanted.name)
        && fullName(next.candidate?.name) !== fullName(wanted.name)
        && (best.candidate?.hIndex || 0) >= (next.candidate?.hIndex || 0)) return answer(best);
      return null;
    }
    return dominates(best, next) ? answer(best) : null;
  }

  // The queries to try, in order, each saying what it takes to trust its answer.
  // "Jason William Chin" returns nothing; "Jason Chin" returns him first, so a
  // middle name recorded by hand is dropped on the retry. Everything past that
  // is a guess about how the name was written down, and a guess is only worth
  // making when there is a recorded institution to check the answer against.
  function authorQueries(name, {institution} = {}) {
    const raw = withoutSuffix(text(name).split(/\s+/).filter(Boolean));
    const queries = [];
    const add = (query, confirm = '') => {
      const key = plain(query);
      if (!key || queries.some(row => plain(row.query) === key)) return;
      queries.push({query: text(query), confirm});
    };
    add(text(name));
    add(raw.join(' '));
    // Drop the middle names, but not a particle: "Victor Lorenzo" is a different
    // man from Víctor de Lorenzo, and asking for him found a one-paper stub.
    let surname = raw.length - 1;
    while (surname > 0 && PARTICLES.has(plain(raw[surname - 1]))) surname--;
    if (surname > 1) add([raw[0], ...raw.slice(surname)].join(' '));
    if (!text(institution) || !raw.length) return queries;
    // A short form is what the watcher calls them, not what the index files
    // them under: "Ron Breaker" finds nobody, "Ronald Breaker" finds Yale.
    for (const full of expansions(raw[0])) {
      add([full[0].toUpperCase() + full.slice(1), ...raw.slice(1)].join(' '), 'expansion');
    }
    // Last, one part of the name alone, longest first, for the names the index
    // has mangled or the watcher has mistyped. A particle belongs to the name it
    // precedes -- searching "Lorenzo" does not reach Víctor de Lorenzo, and
    // searching "de Lorenzo" returns him first. Parts under five letters are
    // skipped: they are too common to narrow anything down.
    const fragments = [];
    for (let i = 0; i < raw.length; i++) {
      if (PARTICLES.has(plain(raw[i]))) continue;
      let start = i;
      while (start > 0 && PARTICLES.has(plain(raw[start - 1]))) start--;
      fragments.push(raw.slice(start, i + 1).join(' '));
    }
    for (const part of fragments.sort((a, b) => b.length - a.length)) {
      if (plain(part).length >= STEM) add(part, 'fragment');
    }
    return queries;
  }

  const authorSearchURL = (name, options = {}) => text(name)
    ? `${API}authors?per_page=10&filter=${encodeURIComponent('display_name.search:' + text(name))}`
      + `&select=id,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics,orcid`
      + credentials(options)
    : null;

  function shapeAuthor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = shortID(raw.id);
    if (!id) return null;
    const institutions = (Array.isArray(raw.last_known_institutions) ? raw.last_known_institutions : [])
      .map(i => text(i?.display_name)).filter(Boolean);
    return {
      id, name: text(raw.display_name), orcid: text(raw.orcid),
      works: Number.isInteger(raw.works_count) ? raw.works_count : null,
      citations: Number.isInteger(raw.cited_by_count) ? raw.cited_by_count : null,
      hIndex: Number.isInteger(raw.summary_stats?.h_index) ? raw.summary_stats.h_index : null,
      i10: Number.isInteger(raw.summary_stats?.i10_index) ? raw.summary_stats.i10_index : null,
      institutions,
      // What the author actually works on, which is the point of looking them up.
      topics: (Array.isArray(raw.topics) ? raw.topics : []).slice(0, 6)
        .map(t => ({name: text(t?.display_name), count: Number.isInteger(t?.count) ? t.count : null}))
        .filter(t => t.name)
    };
  }
  const readAuthors = payload => (Array.isArray(payload?.results) ? payload.results : [])
    .map(shapeAuthor).filter(Boolean);

  const authorWorksURL = (authorID, options = {}) => shortID(authorID).startsWith('A')
    ? `${API}works?per_page=${Math.min(50, options.limit || 25)}`
      + `&filter=${encodeURIComponent('author.id:' + shortID(authorID))}`
      + `&sort=publication_date:desc&select=${WORK_FIELDS}${credentials(options)}`
    : null;

  // The name as the author themselves would search for it.
  function authorNames(item) {
    const creators = typeof item?.getCreators === 'function' ? item.getCreators() : [];
    const seen = new Set();
    const names = [];
    for (const creator of Array.isArray(creators) ? creators : []) {
      if (creator?.creatorType && creator.creatorType !== 'author') continue;
      const name = [text(creator?.firstName), text(creator?.lastName || creator?.name)].filter(Boolean).join(' ');
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  }

  const api = {API, GROUPS, scoreAuthor, pickAuthor, authorQueries, institutionAgrees, topicsAgree,
    workURL, worksByIDsURL, citingURL, readWork, readWorks, mergeSuggestions, relevance,
    authorSearchURL, readAuthors, authorWorksURL, authorNames, shortID, bareDOI, credentials};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleDiscover = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
