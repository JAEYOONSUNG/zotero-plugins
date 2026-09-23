/* What to read before a paper, and in what order.

   The related list answers "what else is there". A reader about to take on a
   paper in an unfamiliar corner asks something narrower: which of these do I
   need first, and which can wait. The citation record answers that, from lists
   OpenAlex already hands over with every work.

   Every reference comes back with its own reference list. Within the set of a
   paper's references, one reference citing another is a stated dependency: the
   later work was built on the earlier one, so the earlier one is read first.

   What the plan is made of, and the traps each part fell into on real papers
   (nine from the user's own library, judged by a reader in the field):

     - foundations: works many of the references cite, including the ones the
       paper itself leaves out. The same count also crowns every method the
       field uses -- Southern blots, MMseqs2, a lab manual -- so methods are
       recognised by what they are (a tool's name, a book, a very highly cited
       paper that cites almost nothing) before anything is ranked.
     - direct predecessors: references that share much of the paper's reading.
       Ranked on the number shared, not on the share normalised by length:
       normalising favoured short bibliographies, and a reference sharing twelve
       lost to one sharing five.
     - continuation: later work that shares the paper's reading and sits in the
       same topic. "Cited it" is not "continued it": a reagent paper is cited by
       thousands of papers that merely used the reagent, and a paper that cites
       one m6A review is pulled toward the whole epitranscriptome field.
     - reviews, before or after, are the cheapest map and go first.
     - one paper arrives as a preprint, a journal version and a second preprint
       record; the paper's own preprint shares all its references and looked
       like its closest predecessor. Versions are merged by title.

   Each section shows its few strongest works numbered, in dependency order; the
   rest of the section is one click away rather than lost in a list of 135. A
   review as the paper in hand gets a different plan: the primary papers it is
   built on; a method's citers are shown as uses of it, not as its sequel. Nothing here is fetched; the caller brings the works. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const shares = (a, b) => [...(a || [])].some(id => b?.has(id));

  function relevance(work, source) {
    if (!work?.subjects || !source?.subjects) return 0;
    if (shares(work.subjects.topic, source.subjects.topic)) return 3;
    if (shares(work.subjects.subfield, source.subjects.subfield)) return 2;
    if (shares(work.subjects.field, source.subjects.field)) return 1;
    return 0;
  }

  function coupling(a, b) {
    const x = new Set(a?.references || []), y = new Set(b?.references || []);
    if (!x.size || !y.size) return {shared: 0, score: 0};
    let shared = 0;
    for (const id of x) if (y.has(id)) shared++;
    return {shared, score: shared / Math.sqrt(x.size * y.size)};
  }

  // A version of the same paper has the same title, give or take case,
  // punctuation and markup.
  const titleKey = value => text(value).toLowerCase().normalize('NFKD')
    .replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 14).join(' ');

  // Function words say nothing about a subject: "DNA ... and ... bacteria"
  // matched a mismatch-repair review to a methylation one.
  const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'its', 'their', 'into', 'via', 'using', 'during', 'between', 'through', 'new', 'novel', 'role', 'roles', 'study', 'analysis']);
  /* Words in the titles of a whole field. With too few titles to count
     rarity, these are what "the same subject" must not rest on. */
  const GENERIC = new Set(['struct', 'basis', 'protei', 'bacter', 'crysta', 'mechan', 'dna', 'rna', 'gene', 'genes', 'cell', 'cells',
    'system', 'type', 'functi', 'activi', 'recogn', 'comple', 'bindin', 'regula', 'expres', 'human', 'escher', 'coli', 'molecu', 'insigh',
    // Qualities, not subjects: "efficient", "improved", "rational", "directed".
    'effici', 'improv', 'enhanc', 'highly', 'rapid', 'robust', 'simple', 'engine', 'ration', 'direct', 'develo', 'design']);
  /* Words to compare titles by: the first six letters, so "protects" meets
     "protect" and "signalling" meets "signal", without a stemmer. */
  const stem = w => w.slice(0, 6);
  const rawWords = value => titleKey(value).split(' ').filter(w => w.length > 2 && !STOP.has(w));
  const titleWords = value => new Set(rawWords(value).map(stem));
  // One letter apart ("Ketose" / "Ketoso") is a typo, not another word.
  function oneEdit(a, b) {
    if (a === b) return true;
    // Cas12a and Cas12k, AcrVA1 and AcrVA4 are different proteins, not typos.
    if (/\d/.test(a) || /\d/.test(b)) return false;
    if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  // Named things with digits in them (Cas12a, AcrVA4, C66S) must agree
  // exactly for two titles to be one paper.
  const named = value => rawWords(value).filter(w => /\d/.test(w)).sort().join(' ');
  const sameNamed = (a, b) => named(a) === named(b);
  // Word overlap of two titles, for versions retitled between preprint and journal.
  function titleOverlap(a, b) {
    const x = [...new Set(rawWords(a))], y = [...new Set(rawWords(b))];
    if (!x.length || !y.length) return 0;
    let shared = 0;
    for (const w of x) if (y.some(v => stem(v) === stem(w) || oneEdit(v, w))) shared++;
    return shared / Math.max(x.length, y.length);
  }
  /* The same subject is a matter of the rare words. "CRISPR", "type",
     "system", "structure" are in half the titles around a paper and matched a
     Lactobacillus gasseri type II paper to a crispatus type I one; "cichorii"
     and "tagatose" are in three. Rarity is counted over the titles in the plan
     itself, so it adapts to the field. Two rare words in common make a
     subject; with too few titles to count, three words of any kind. */
  function subjectMatcher(seedTitle, titles) {
    const df = new Map();
    for (const t of titles) for (const w of titleWords(t)) df.set(w, (df.get(w) || 0) + 1);
    const n = titles.length;
    const rare = w => (df.get(w) || 0) <= Math.max(2, n * 0.1);
    /* What a title rules out is not its subject: "integration without
       double-strand breaks" is not about double-strand breaks, and reading it
       so made a Cas9 large-deletion paper the start of a transposase path. The
       words after "without", "no", "independent of" are left out. */
    const kept = titleKey(seedTitle).split(' ');
    const negated = new Set();
    kept.forEach((w, i) => { if (/^(without|no|non|independent|free)$/.test(w)) for (let k = i + 1; k <= i + 4 && k < kept.length; k++) negated.add(k); });
    const own = new Set(kept.filter((w, i) => !negated.has(i) && w.length > 2 && !STOP.has(w)).map(stem));
    return title => {
      const shared = [...titleWords(title)].filter(w => own.has(w));
      const specific = shared.filter(w => !GENERIC.has(w));
      return n >= 15 ? specific.filter(rare).length >= 2 : specific.length >= 3;
    };
  }
  const sameSubject = (a, b) => subjectMatcher(b, [])(a);

  /* OpenAlex types most reviews as "article", so the title and the length of
     the bibliography carry most of the weight. A book review is not a review. */
  const REVIEW = /\b(review|overview|perspective|primer|tutorial|survey|progress in|advances (in|on)|recent progress|an update on|past,? present|and future|lessons learned|historical|state of the art|current understanding|mechanisms, functions)\b/i;
  /* A long bibliography is weak evidence on its own: Nature research papers
     with methods run past 120 references, and calling the evolved-CAST paper a
     review hid the obvious sequel to the paper it followed. So a long list
     makes a review only past 180 references, or past 120 under a "topic:
     angle" title -- and never when the title reports a finding, or for a
     preprint, which is usually a research paper not yet trimmed for a journal. */
  const FINDING = /\b(reveals?|identif\w*|required|requires|promotes?|enables?|determines?|controls?|mediates?|drives?|regulates?|shows?|is|are|screen|systematic|genome-wide|collection|we)\b/i;
  /* The journal is the surest sign: FEMS Microbiology Reviews, Trends in ...,
     Current Opinion in ..., Annual Review of ... publish reviews and little
     else. Guessing from reference counts flipped a 149-reference FEMS review
     into a research paper and gave it the wrong kind of plan. */
  const REVIEW_VENUE = /\b(reviews?|trends in|current opinion|annual review|progress in)\b/i;
  function isReview(work) {
    const type = text(work?.type).toLowerCase();
    if (type === 'book-review') return false;
    if (type === 'review') return true;
    if (REVIEW_VENUE.test(text(work?.venue)) && !/preprint|posted-content/.test(type)) return true;
    /* A Science Perspective or an essay is typed "article", sits in a research
       journal and has a short list; only its own words give it away. */
    const abstract = text(work?.abstract);
    // "We discuss the implications" closes many research abstracts; only an
    // abstract that reports nothing is read as a review by its wording.
    const reports = /\b(we (show|demonstrate|find|found|identify|identified|reveal|report|determined|measured)|here,? we (report|show|present|describe the (structure|discovery)))\b/i.test(abstract);
    if (!reports && /\b(this (review|perspective|essay|commentary|minireview)|we (review|discuss)|here,? we (review|discuss|summari[sz]e|highlight|outline))\b/i.test(abstract)
      && (work?.references?.length || 0) <= 120) return true;
    /* An essay argues and reports nothing: "We consider an alternative view
       ... We surmise ..." with no sentence that shows or finds. */
    if (/\bwe (consider|surmise|argue|speculate|posit|contend)\b/i.test(abstract)
      && !/\bwe (show|demonstrate|find|found|identify|identified|reveal|report|determined|measured)\b/i.test(abstract)
      && (work?.references?.length || 0) <= 120) return true;
    const title = text(work?.title);
    if (REVIEW.test(title)) return true;
    const length = work?.references?.length || 0;
    if (/preprint|posted-content/.test(type) || FINDING.test(title)) return false;
    return length >= 180 || (length >= 120 && title.includes(':'));
  }

  /* A method or a tool, recognised by what it is rather than by how far it
     sits from the paper: the tools that most need catching are the ones from
     the paper's own field. */
  /* Two lists. Words that name a kind of tool match in any case. Names of
     particular tools match only as written: "Skeletal muscle", "rice blast",
     "a chimera" and "transcriptional program" are biology, and matching them
     case-blind turned a muscle paper into a methods paper. */
  const TOOL_KIND = /\b(software|toolkit|web ?server|database|pipeline|computer program|python package|r package|aligner|plugin|laboratory manual|lab manual|methods in|experiments in|user guide)\b/i;
  const TOOL_PROPER = /\b(MMseqs2?|BLAST[NPX+]?|Bowtie ?2?|SAMtools|BWA|AlphaFold\d?|MAFFT|MUSCLE|Clustal[WXO]?|PyMOL|UCSF Chimera(X)?|ChimeraX|RELION|cryoSPARC|DESeq2|edgeR|HMMER|Pfam|InterPro(Scan)?|PHENIX|Phenix|Coot|XDS|CCP4|Fiji|ImageJ|MolProbity|Rosetta(Fold)?|trRosetta|ColabFold|IQ-TREE|RAxML|MEGA\s?\d+|Phyre2?|SWISS-MODEL|UniProt|Prokka|SPAdes|Trimmomatic|Gibson assembly|Golden Gate|MoClo|SEVA|REFMAC\d*|Phaser|SHELX\w*|EMAN2?|MotionCor2?|CTFFIND\d*|Gctf)\b/;
  const TOOL_NAME = {test: value => TOOL_KIND.test(value) || TOOL_PROPER.test(value)};
  /* 'named' when the record says what it is; 'counted' when only its numbers
     do -- a paper cited thousands of times that cites almost nothing is usually
     a method, but the paper a method paper improves on looks exactly the same,
     so a counted tool that shares the paper's topic or reading is kept in the
     path (Boeke 1984 is the predecessor of the 5-FOA chapter, not its tool). */
  function isTool(work, {citations = 2000, shortList = 20} = {}) {
    const type = text(work?.type).toLowerCase();
    if (['dataset', 'software', 'standard', 'reference-entry', 'report'].includes(type)) return 'named';
    if (TOOL_NAME.test(text(work?.title))) return 'titled';
    const cited = work?.citations || 0;
    if (['book', 'book-chapter'].includes(type) && cited >= 1000) return 'named';
    return cited >= citations && (work?.references?.length || 0) < shortList ? 'counted' : false;
  }

  /* The works the references keep citing that the paper itself leaves out.
     Kept only when a real share of the references agree. */
  function foundationCandidates(seed, refs, {limit = 12, floor = 3, share = 0.15} = {}) {
    const own = new Set([seed?.id, ...(seed?.references || [])]);
    const counted = (refs || []).filter(ref => ref?.references?.length);
    const need = Math.max(floor, Math.ceil(counted.length * share));
    const tally = new Map();
    for (const ref of counted) {
      for (const id of new Set(ref.references)) {
        if (own.has(id)) continue;
        tally.set(id, (tally.get(id) || 0) + 1);
      }
    }
    return [...tally.entries()]
      .filter(([, n]) => n >= need)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([id, count]) => ({id, count}));
  }

  /* Depth in the dependency order: 0 for a work that builds on nothing else in
     the set, otherwise one more than the deepest thing it builds on. A citation
     to a work more than a year newer is a data error and ignored; a cycle is
     cut where it is found. `below` holds only the edges that survived. */
  function depths(works) {
    const byID = new Map(works.map(w => [w.id, w]));
    const raw = new Map();
    for (const w of works) {
      raw.set(w.id, [...new Set(w.references || [])].filter(id => {
        const other = byID.get(id);
        if (!other || id === w.id) return false;
        return !(w.year && other.year && other.year > w.year + 1);
      }));
    }
    const memo = new Map(), open = new Set(), below = new Map();
    const depth = id => {
      if (memo.has(id)) return memo.get(id);
      if (open.has(id)) return -1;
      open.add(id);
      let d = 0;
      const kept = [];
      for (const next of raw.get(id) || []) {
        const inner = depth(next);
        if (inner < 0) continue;
        kept.push(next);
        d = Math.max(d, inner + 1);
      }
      open.delete(id);
      memo.set(id, d);
      below.set(id, kept);
      return d;
    };
    for (const w of works) depth(w.id);
    return {depth: memo, below};
  }

  /* Merge the versions of one paper: a preprint and its journal version, or two
     preprint records. The journal version wins, then the more cited. Returns
     the kept works and a map from every merged id to the one kept. */
  const preference = w => (/preprint|posted-content/i.test(text(w.type)) ? 0 : 1) * 1e9 + (w.citations || 0);
  /* A title of two words ("Correction", "Editorial") names nothing: two of
     them are merged only when they are also a year apart at most. A typo
     between versions ("Ketose" / "Ketoso") is caught by word overlap. */
  function mergeVersions(works) {
    const byKey = new Map();
    const lists = [];
    for (const w of works) {
      const key = titleKey(w.title);
      const short = !key || key.split(' ').length < 3;
      let list = key && byKey.get(key);
      if (list && short && !list.some(v => Math.abs((v.year || 0) - (w.year || 0)) <= 1)) {
        list = lists.find(l => titleKey(l[0].title) === key && l.some(v => Math.abs((v.year || 0) - (w.year || 0)) <= 1)) || null;
      }
      if (!list && !short) {
        list = lists.find(l => l.some(v => Math.abs((v.year || 0) - (w.year || 0)) <= 1
          && titleOverlap(v.title, w.title) >= 0.8 && sameNamed(v.title, w.title)));
      }
      if (!list) { list = []; lists.push(list); if (key && !byKey.has(key)) byKey.set(key, list); }
      list.push(w);
    }
    const alias = new Map(), kept = [];
    for (const list of lists) {
      const best = [...list].sort((a, b) => preference(b) - preference(a))[0];
      kept.push({...best, versions: list.length});
      for (const w of list) alias.set(w.id, best.id);
    }
    return {kept, alias};
  }

  const SHOW = {overview: 2, foundation: 5, predecessor: 5, primary: 8, continuation: 4, uses: 3};
  const KEEP = {overview: 4, foundation: 12, predecessor: 12, primary: 16, continuation: 10, tools: 8};

  /* seed: the paper. refs: its references, as works. citers: works citing it.
     foundations: works fetched for foundationCandidates(), with that count.
     Everything is a shaped OpenAlex work (discover.js shapeWork). */
  /* OpenAlex's topic for a paper is a classifier's guess, and it can be wild:
     the VECTOR preprint, a microbial engineering toolkit, is filed under
     "Spacecraft and Cryogenic Technologies". When a paper's topics disagree
     with almost all of its own references, the references are the better
     witness: the paper is taken to sit where they commonly do. */
  function trustedSubjects(seed, refs) {
    // A reference with no topics has no vote.
    const listed = (refs || []).filter(r => r?.subjects?.topic?.size);
    if (listed.length < 5) return seed.subjects;
    const agree = listed.filter(r => relevance(r, seed) >= 1).length / listed.length;
    if (agree >= 0.3) return seed.subjects;
    const common = level => {
      const count = new Map();
      for (const r of listed) for (const id of r.subjects[level] || []) count.set(id, (count.get(id) || 0) + 1);
      return new Set([...count].filter(([, n]) => n >= Math.max(2, listed.length * 0.15)).map(([id]) => id));
    };
    return {topic: common('topic'), subfield: common('subfield'), field: common('field'), domain: common('domain')};
  }

  function plan(seed, {refs = [], citers = [], foundations = [], have = new Set()} = {}, options = {}) {
    if (!seed?.id) return null;
    seed = {...seed, subjects: trustedSubjects(seed, refs)};
    const show = {...SHOW, ...(options.show || {})}, keep = {...KEEP, ...(options.keep || {})};
    const owned = new Set([...have].map(value => text(value).toLowerCase()).filter(Boolean));
    const inLibrary = w => !!w.doi && owned.has(text(w.doi).toLowerCase());
    const seedKey = titleKey(seed.title);

    /* Everything before the paper, with versions merged and the paper's own
       other versions taken out. A hidden classic has to sit in the paper's own
       subfield: one from further away is a method the field happens to use. */
    /* The paper's own preprint is often retitled on the way to the journal
       ("CRISPR RNA-guided" became "CRISPR-associated"), so a title match alone
       misses it. Sharing most of the paper's reading under a similar title does
       not. */
    const ownRefs = new Set(seed.references || []);
    const sameTitleAsSeed = w => !!seedKey && titleKey(w.title) === seedKey;
    // Only among the references: a later paper from the same group can share a
    // title's words and much of the reading, and it is the continuation.
    const isSeedVersion = w => {
      if (sameTitleAsSeed(w)) return true;
      if (!ownRefs.size || titleOverlap(w.title, seed.title) < 0.6) return false;
      let shared = 0;
      for (const id of new Set(w.references || [])) if (ownRefs.has(id)) shared++;
      return shared / ownRefs.size >= 0.8;
    };
    let seedVersions = 0;
    const raw = [];
    const seen = new Set([seed.id]);
    for (const w of refs) {
      if (!w?.id || seen.has(w.id)) continue;
      seen.add(w.id);
      if (isSeedVersion(w)) { seedVersions++; continue; }
      raw.push({...w, cited: true});
    }
    foundations = (foundations || []).filter(f => f?.id);
    const hidden = new Map(foundations.map(f => [f.id, f.count || 0]));
    for (const w of foundations) {
      if (!w?.id || seen.has(w.id) || relevance(w, seed) < 2) continue;
      seen.add(w.id);
      if (seedKey && titleKey(w.title) === seedKey) continue;
      raw.push({...w, cited: false});
    }
    const {kept: prior, alias} = mergeVersions(raw);
    const canon = id => alias.get(id) || id;
    // Two versions of one reference count once, whichever the others cite.
    for (const w of prior) w.references = [...new Set((w.references || []).map(canon))];
    const seedRefs = new Set((seed.references || []).map(canon));
    const seedLike = {...seed, references: [...seedRefs]};

    // How many of the paper's own references cite each work: the field's vote.
    const refCiters = new Map(prior.map(w => [w.id, 0]));
    for (const w of prior) {
      if (!w.cited) continue;
      for (const id of w.references) if (refCiters.has(id) && id !== w.id) refCiters.set(id, refCiters.get(id) + 1);
    }
    for (const [id, n] of hidden) {
      const key = canon(id);
      if (refCiters.has(key)) refCiters.set(key, Math.max(refCiters.get(key), n));
    }

    const withLists = refs.filter(w => w?.references?.length).length;
    const aboutSeed = subjectMatcher(seed.title, [...prior, ...citers].map(w => w?.title).filter(Boolean));
    const {depth, below} = depths(prior);
    const rows = prior.map(w => {
      const c = coupling(w, seedLike);
      return {...w, inLibrary: inLibrary(w), relevance: relevance(w, seed), shared: c.shared, coupling: c.score,
        refCiters: refCiters.get(w.id) || 0, depth: depth.get(w.id) || 0,
        builtOn: below.get(w.id) || [], review: isReview(w), tool: isTool(w),
        /* The same enzyme, strain or system named in the title: the 2007
           structure of P. cichorii D-tagatose 3-epimerase is what the 2016
           structure of its mutant builds on, however few cite it. */
        sameSubject: aboutSeed(w.title)};
    });
    /* A tool on the paper's own topic that shares its reading is lineage, not
       a method it borrowed: for a paper that builds a toolkit, SEVA and MoClo
       are the predecessors. Only a tool known by its name or its numbers is
       reconsidered; a book or a dataset stays a tool. */
    /* A paper that builds tools stands on other tools: for VECTOR, SEVA, BEVA
       and MoClo are its lineage, not borrowed methods. Whether a paper builds
       tools is read from the paper itself -- its title, or its abstract saying
       it developed a pipeline, toolkit or platform. Counting the tools it
       cites was tried and read every structure paper (AlphaFold, InterProScan,
       HHpred...) as a toolkit, which put MMseqs2 back among the foundations. */
    const BUILDS = /\bwe (developed|develop|present|built|build|established|establish|introduce|created|constructed)\b[^.]{0,100}\b(toolkit|tool ?box|pipeline|platform|resource|vector (set|system|suite|collection)|plasmid (set|collection)|part library|framework)\b/i;
    const buildsTools = TOOL_NAME.test(text(seed.title)) || BUILDS.test(text(seed.abstract));
    for (const w of rows) {
      if (w.tool === 'counted' && (w.relevance === 3 || w.shared >= 3)) w.tool = false;
      if (w.tool === 'titled' && ((w.relevance === 3 && w.shared >= 3) || (buildsTools && w.relevance >= 2))) w.tool = false;
    }

    // A citer can be the journal version of a preprint the paper cited: one
    // work, already placed before the paper.
    const priorKeys = new Set(rows.map(w => titleKey(w.title)).filter(Boolean));
    const later = mergeVersions(citers.filter(w => w?.id && !seen.has(w.id)
      && !sameTitleAsSeed(w) && !priorKeys.has(titleKey(w.title)))).kept.map(w => {
      const c = coupling({...w, references: (w.references || []).map(canon)}, seedLike);
      return {...w, inLibrary: inLibrary(w), relevance: relevance(w, seed), shared: c.shared, coupling: c.score,
        review: isReview(w), tool: false, after: true};
    });
    /* Continued it, not merely cited it: the same topic or a real share of the
       same reading -- and building on the same line of work the path runs
       through. The EcoP15I structure is cited by m6A-writer papers that share
       its methyltransferase reviews; they cite none of the type III restriction
       work the paper itself stands on. */
    let line = new Set();
    const lineShared = w => (w.references || []).map(canon).filter(id => line.has(id)).length;
    // Without the paper's own reference list there is no reading to share;
    // the topic is then the only test there is.
    // A review is cited for its survey, not continued line by line: work that
    // shares two of its sources, or its topic, is what came after it.
    const continues = w => !seedRefs.size ? w.relevance === 3
      : seedIsReviewEarly ? (w.shared >= 2 || w.relevance === 3)
      : w.shared >= 3 && (w.relevance === 3 || w.coupling >= 0.1) && lineShared(w) >= Math.min(2, line.size);

    const seedIsReviewEarly = isReview(seed);
    const used = new Set();
    const take = (list, n) => {
      const out = list.filter(w => !used.has(w.id)).slice(0, Math.max(0, n));
      for (const w of out) used.add(w.id);
      return out;
    };
    /* The field's vote, weighted toward the specific: a work the paper itself
       cites, on its own topic, before a classic of the whole field. Human-cell
       CAST stands on Klompe and Strecker 2019 first and on Cas9 (cited by more
       references, but not by this paper) second. */
    // (Weighting toward works the paper itself cites was tried and pushed
    // Yoshida 2016 and Austin 2018 out of the PET path; the field's own vote
    // is the better rank.)
    const byWeight = (a, b) => (b.sameSubject ? 1 : 0) - (a.sameSubject ? 1 : 0)
      || b.refCiters - a.refCiters || b.shared - a.shared || (a.year || 9999) - (b.year || 9999);
    /* A review shares more of anything than a research paper does, and one
       OpenAlex calls an article took the continuation and predecessor slots
       on four unseen papers. A list of a hundred references goes last. */
    const longList = w => w.review || (w.references?.length || 0) >= 100;
    const bySharing = (a, b) => (longList(a) ? 1 : 0) - (longList(b) ? 1 : 0)
      || b.shared - a.shared || b.coupling - a.coupling || b.refCiters - a.refCiters;

    const tools = take(rows.filter(w => w.tool && (w.cited || w.refCiters))
      .sort((a, b) => (b.citations || 0) - (a.citations || 0)), keep.tools);
    const seedIsReview = isReview(seed);
    /* A method is cited by the work that used it, and that is what its citers
       are: examples of use, not a continuation. The section says so. */
    // A protocol journal publishes methods whatever the title says.
    const PROTOCOL_VENUE = /\b(bio-protocol|protocols?|methods in enzymology|methods in molecular biology|jove|journal of visualized experiments|methodsx)\b/i;
    const seedIsMethod = !seedIsReview && (['named', 'titled'].includes(isTool(seed))
      || PROTOCOL_VENUE.test(text(seed.venue)) || /protocol/i.test(text(seed.type)));


    // A review the paper cites belongs to the line if it builds on the line's
    // work or the line's work builds on it.
    const linked = w => !line.size || lineShared(w) >= 1
      || rows.some(r => line.has(r.id) && r.references.includes(w.id));
    // Reviews come first on the page but are chosen last, once the line of
    // work is known: a review that shares none of it maps another field.
    // A review the references lean on counts even when it shares little of
    // the paper's own list (the pan-immune review, cited by 12 of them).
    const reviewScore = w => (w.relevance === 3 ? 2 : 1) * (w.shared + (w.refCiters || 0)) * Math.log10((w.citations || 0) + 10);
    const overview = () => take([
      ...later.filter(w => w.review && continues(w)),
      ...rows.filter(w => w.review && !w.tool && w.relevance >= 2 && (w.shared >= 3 || w.refCiters >= need) && linked(w))
    ].sort((a, b) => reviewScore(b) - reviewScore(a)), keep.overview);

    const need = Math.max(2, Math.ceil(withLists * 0.08));
    const gate = Math.max(3, Math.round(seedRefs.size * 0.05));
    let sections;
    if (seedIsReview) {
      /* A review is not read after its sources; it is read to find them. Its
         plan is the primary work it rests on, most leaned-on first. (Spreading
         the list over OpenAlex topics was tried: the topics are too noisy -- a
         CtrA paper filed under wastewater treatment -- and the spreading pushed
         SeqA, cited by 24 of the references, out of the list.) */
      const primary = take(rows.filter(w => w.cited && !w.tool && !w.review && !used.has(w.id)).sort(byWeight), keep.primary);
      line = new Set(primary.slice(0, show.primary).map(w => w.id));
      sections = [
        {key: 'overview', list: overview()},
        {key: 'primary', list: primary},
        {key: 'seed', list: [{...seed, inLibrary: inLibrary(seed), seed: true, versions: seedVersions + 1}]},
        {key: 'continuation', list: take(later.filter(w => !w.review && continues(w)).sort(bySharing), keep.continuation)}
      ];
    } else {
      /* The paper's own field only. A structure paper's references cite the
         feeding trials that made the sugar interesting; those are its
         motivation, not the ground it stands on. */
      // OpenAlex's topics are guesses; a work half again as leaned-on as the
      // bar is foundational whatever it is filed under (bacterial cGAS, DncV).
      let foundation = take(rows.filter(w => !w.tool && !w.review && (w.relevance >= 2 || w.refCiters >= need * 1.5)
        && (w.refCiters >= need || (!w.cited && w.refCiters)))
        .sort(byWeight), keep.foundation);
      /* Shared reading alone rewards long same-field bibliographies and
         demoted landmarks (Tournier 2020 behind a techno-economic analysis):
         half the rank is how much the paper shares, half how much the field
         leans on it. */
      /* And a predecessor stands in the same line as the foundations: it cites
         one of them or is cited by one. Ranking on how much the references
         lean on a work brought the EcoP15I paper's second thread -- m6A, which
         its references cite among themselves -- into the path. */
      const base = new Set(foundation.slice(0, show.foundation).map(w => w.id));
      // Two ties to the foundations, or one and the same topic: prime editing
      // cites Cas9, as every genome-editing paper does, and is not the lineage
      // of a transposase paper.
      const ties = w => w.references.filter(id => base.has(id)).length
        + rows.filter(r => base.has(r.id) && r.references.includes(w.id)).length;
      /* Relaxed where it cost the most: on real papers never seen while tuning,
         requiring two ties cut the one paper to read first (BREX before
         DISARM, the 2007 structure before the 2016 one) -- same-lab work with
         a short list. A small base cannot vouch for anything, and a paper that
         shares five or more of the reading is in the line whatever it cites. */
      /* ...but sharing five references is not enough on its own: the EcoP15I
         paper's m6A thread shares that many, and its m6A sources sit in the
         foundation's tail. A tie to the shown foundations is required with it. */
      /* A work sharing eight references on the paper's own topic is in the line
         even untied: Cohen 2019, which named CBASS, shares ten with the paper
         and ties to none of its mammalian cGAS foundations. The m6A thread in
         the EcoP15I paper shares five. */
      const inLine = w => base.size < 5 || ties(w) >= 2 || (w.relevance === 3 && ties(w) >= 1)
        || (w.relevance === 3 && w.shared >= Math.max(gate, 8));
      const candidates = rows.filter(w => w.cited && !w.tool && !w.review && w.shared >= gate && !used.has(w.id) && inLine(w));
      const rank = key => { const sorted = [...candidates].sort((a, b) => b[key] - a[key]); return new Map(sorted.map((w, i) => [w.id, i / Math.max(1, sorted.length - 1)])); };
      const bySharedRank = rank('shared'), byLeanRank = rank('refCiters');
      let predecessor = take(candidates.sort((a, b) => (b.sameSubject ? 1 : 0) - (a.sameSubject ? 1 : 0)
        || (longList(a) ? 1 : 0) - (longList(b) ? 1 : 0)
        || (bySharedRank.get(a.id) + byLeanRank.get(a.id)) - (bySharedRank.get(b.id) + byLeanRank.get(b.id))
        || bySharing(a, b)), keep.predecessor);
      /* A foundation that builds on a predecessor would be read before the
         thing it needs. That predecessor is itself foundational: move it. */
      for (let moved = true; moved;) {
        moved = false;
        for (const w of predecessor) {
          if (foundation.some(f => f.builtOn.includes(w.id))) {
            // Just before the first foundation that needs it, so it keeps a
            // numbered place instead of dropping into the section's tail.
            const at = foundation.findIndex(f => f.builtOn.includes(w.id));
            foundation = [...foundation.slice(0, at), w, ...foundation.slice(at)];
            predecessor = predecessor.filter(p => p.id !== w.id);
            moved = true;
            break;
          }
        }
      }
      // The line is the core, not the section: a paper with two threads (the
      // EcoP15I structure also discusses m6A writers) keeps its second thread
      // in the tail of the predecessors, and it must not pull that field in.
      line = new Set([...foundation.slice(0, show.foundation), ...predecessor.slice(0, show.predecessor)].map(w => w.id));
      sections = [
        {key: 'overview', list: overview()},
        {key: 'foundation', list: foundation},
        {key: 'predecessor', list: predecessor},
        {key: 'seed', list: [{...seed, inLibrary: inLibrary(seed), seed: true, versions: seedVersions + 1}]},
        {key: seedIsMethod ? 'uses' : 'continuation', list: take(later.filter(w => !w.review && continues(w)).sort(bySharing), keep.continuation)}
      ];
    }
    /* A section's tail keeps only works tied to its core -- citing one, or
       cited by one. The rest is a second thread (m6A in the EcoP15I paper,
       alphavirus fusion in the S-layer one) and belongs with the references. */
    for (const section of sections) {
      if (!['foundation', 'predecessor', 'primary'].includes(section.key)) continue;
      const head = section.list.slice(0, show[section.key]);
      const core = new Set(sections.filter(s => ['foundation', 'predecessor', 'primary'].includes(s.key))
        .flatMap(s => s.list.slice(0, show[s.key]).map(w => w.id)));
      const tied = w => w.references.some(id => core.has(id)) || rows.some(r => core.has(r.id) && r.references.includes(w.id));
      const tail = section.list.slice(show[section.key]);
      for (const w of tail) if (!tied(w)) used.delete(w.id);
      section.list = [...head, ...tail.filter(tied)];
    }
    sections.push({key: 'tools', list: tools});

    /* The strongest few of each section are the path; they are then put in
       dependency order, so no numbered step needs one numbered after it. */
    const ordered = list => [...list].sort((a, b) => a.depth - b.depth
      || b.refCiters - a.refCiters || (a.year || 9999) - (b.year || 9999));
    // Each work keeps its rank in its section, so a view that shows only the
    // first two can take the two most important rather than the two oldest.
    for (const section of sections) section.list.forEach((w, i) => { w.rank = i; });
    const steps = sections.filter(section => section.list.length).map(({key, list}) => {
      const limit = key === 'seed' ? 1 : key === 'tools' ? 0 : show[key] ?? 4;
      const core = list.slice(0, limit);
      const more = list.slice(limit);
      const sort = ['foundation', 'predecessor', 'primary'].includes(key) ? ordered
        : key === 'continuation' || key === 'uses' ? l => [...l].sort((a, b) => (a.year || 0) - (b.year || 0)) : l => l;
      return {key, works: sort(core), more: sort(more)};
    });

    let n = 0;
    const number = new Map(), section = new Map();
    for (const step of steps) {
      for (const w of step.works) { number.set(w.id, ++n); section.set(w.id, step.key); }
      for (const w of step.more) section.set(w.id, step.key);
    }
    /* "Read 4, 5, 6, 7, 8 first" says nothing once 8 already built on the rest.
       Reachability runs over the numbered works' own citations only, and a
       step names only what it stands on directly. Within a section the order
       already says it; across sections it is worth saying. */
    const numbered = new Map();
    for (const w of rows) if (number.has(w.id)) numbered.set(w.id, (w.builtOn || []).filter(id => number.has(id) && id !== w.id));
    const reach = new Map();
    const ancestors = (id, trail = new Set()) => {
      if (reach.has(id)) return reach.get(id);
      if (trail.has(id)) return new Set();
      trail.add(id);
      const out = new Set();
      for (const next of numbered.get(id) || []) {
        out.add(next);
        for (const far of ancestors(next, trail)) out.add(far);
      }
      trail.delete(id);
      out.delete(id);
      reach.set(id, out);
      return out;
    };
    for (const step of steps) for (const w of [...step.works, ...step.more]) {
      w.step = number.get(w.id) || null;
      const direct = (numbered.get(w.id) || []).filter(id => number.get(id) < (w.step || Infinity));
      const implied = new Set(direct.flatMap(id => [...ancestors(id)]));
      w.needs = direct.filter(id => !implied.has(id) && section.get(id) !== step.key)
        .map(id => number.get(id)).sort((a, b) => a - b).slice(0, 3);
      // The same, by id, across every section: a view that shows fewer rows
      // numbers them afresh and needs to know what each one stands on.
      /* Every row's own citations of other rows in the plan, unreduced: a view
         that hides or owns some of them has to reduce over what it shows, or
         "read 2 first" vanishes when the step between is on the shelf. */
      w.needIDs = [...new Set(w.builtOn || [])].filter(id => section.has(id) && id !== w.id).map(id => [id, section.get(id)]);
    }
    /* Where to start is a choice, not the first row. A method paper starts
       from the method it improves on; otherwise from a well-cited review on the
       paper's own topic, and failing that from the foundation the references
       lean on most. */
    const shown = key => steps.find(step => step.key === key)?.works || [];
    /* A review to start from maps the ground the paper stood on: one it cites,
       or one from within two years of it. A well-cited review written five
       years later about applications is a different map. */
    const onTopicReview = shown('overview').filter(w => w.relevance === 3 && (w.citations || 0) >= 30
      && (w.cited || !seed.year || !w.year || w.year <= seed.year + 2))
      .sort((a, b) => (b.cited ? 1 : 0) - (a.cited ? 1 : 0) || (b.citations || 0) - (a.citations || 0))[0];
    const baseRow = [...shown('foundation'), ...shown('primary')].filter(w => !w.depth || !w.needs?.length)
      .sort((a, b) => (b.cited ? 1 : 0) - (a.cited ? 1 : 0) || b.refCiters - a.refCiters)[0];
    /* A paper about one enzyme, strain or system starts from the first paper
       it cites on that same subject: the 2007 structure before the 2016 one. */
    // Chosen by how much the references lean on it, not by age: the oldest
    // same-subject paper put a 2011 cutinase ahead of the PET field's axis.
    const firstOnSubject = [...shown('foundation'), ...shown('predecessor')].filter(w => w.sameSubject && w.cited && w.refCiters >= need)
      .sort((a, b) => b.refCiters - a.refCiters || (a.year || 9999) - (b.year || 9999))[0];
    const start = (seedIsMethod && shown('predecessor')[0]) || firstOnSubject || onTopicReview || baseRow
      || steps.find(step => !['tools', 'seed'].includes(step.key))?.works[0];
    if (start) start.start = true;

    const rest = rows.filter(w => !used.has(w.id) && w.cited).sort(byWeight);
    return {steps, rest, mode: seedIsReview ? 'review' : seedIsMethod ? 'method' : 'paper', seedVersions,
      counts: {references: refs.length, withLists, citers: later.length, foundations: foundations.length}};
  }

  /* Why a paper sits where it does, as separate phrases so each one can be
     translated on its own. */
  function reasons(work, key) {
    const out = [];
    if (key === 'overview') out.push(work.after ? '이 논문을 인용한 리뷰' : work.cited ? '이 논문이 인용한 리뷰' : '참고문헌들이 인용한 리뷰');
    if (key === 'foundation' || key === 'primary') {
      if (work.refCiters) out.push(`참고문헌 ${work.refCiters}편이 인용`);
      if (!work.cited) out.push('이 논문 참고문헌엔 없음');
    }
    if (key === 'tools') out.push('널리 쓰이는 방법·도구 — 필요할 때 참고');
    if (['overview', 'predecessor', 'continuation', 'uses'].includes(key) && work.shared) out.push(`참고문헌 ${work.shared}편 겹침`);
    if (key === 'predecessor' && work.refCiters >= 2) out.push(`참고문헌 ${work.refCiters}편이 인용`);
    if (work.sameSubject && !work.seed && ['foundation', 'predecessor', 'primary'].includes(key)) out.push('같은 대상을 다룸');
    if (work.seed && work.versions > 1) out.push(`다른 판 ${work.versions - 1}개 합침`);
    if (work.needs?.length) out.push(`먼저: ${work.needs.join(', ')}번`);
    return out;
  }
  const reason = (work, key) => reasons(work, key).join(' · ');

  const api = {plan, reason, reasons, foundationCandidates, depths, coupling, relevance, isReview, isTool,
    mergeVersions, titleKey};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleReadingPath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
