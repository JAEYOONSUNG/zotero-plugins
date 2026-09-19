/* Who published this, shown as a mark rather than a colour-coded number.

   The IF column used to tint each value by tier: purple above 30, blue above
   10, teal above 5, green above 2. One column, five hues, a different colour on
   every row, and the tier said nothing the number itself did not already say.
   That is what made the list look like a toy.

   A journal's publisher is the thing a reader actually recognises at a glance,
   and it is not written anywhere else in the row. So the colour carries the
   publisher family, the number goes back to plain readable ink, and weight
   alone carries how high the figure is.

   The marks are monograms, not logos. A publisher's logo is its trademark and
   there is no offline source for one, so each family gets a lettermark drawn in
   its own colour instead: recognisable, ours to ship, and legible at 14px. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const flat = value => text(value).toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

  /* One entry per publisher family, in the order they are tested: a longer,
     more specific pattern has to come before the family it belongs to, or
     "Nature Communications" is matched by the rule for "Nature".

     The hues are the families' own, pulled toward each other in saturation so
     that a column of them reads as one set rather than as a paint chart. */

  /* Every Nature sister journal wears its own cover colour, and a reader who
     works in the field knows them: Biotechnology blue, Methods green, Chemical
     Biology purple, Genetics amber, Medicine red. The portfolio is one family
     but the marks are not one colour. Hues approximate the covers. */
  /* Colours measured, not guessed: the first page of every PDF in this library
     was rendered and the dominant saturated colour of its masthead band read
     off, then tallied per journal. A journal enters this table when at least
     three of its PDFs agree on the same hue. Blue that came only from a few
     DOI links was discarded. Hues are 0-359 on the colour wheel. */
  const JOURNAL_HUES = {
    'acs catalysis': 210,
    'acs synthetic biology': 230,
    'annual review of genetics': 0,
    'applied and environmental microbiology': 0,
    'biotechnology advances': 160,
    'biotechnology and bioengineering': 30,
    'biotechnology for biofuels': 0,
    'cell': 200,
    'cell host and microbe': 200,
    'cell reports': 200,
    'communications biology': 0,
    'environmental microbiology': 30,
    'fems microbiology reviews': 200,
    'frontiers in bioengineering and biotechnology': 30,
    'frontiers in microbiology': 90,
    'genome biology': 180,
    'international journal of biological macromolecules': 200,
    'journal of agricultural and food chemistry': 220,
    'journal of bacteriology': 0,
    'metabolic engineering': 30,
    'metabolic engineering communications': 180,
    'microbial biotechnology': 140,
    'microbial cell factories': 60,
    'microorganisms': 100,
    'molecular cell': 200,
    'molecular systems biology': 210,
    'nature': 8,
    'nature biotechnology': 50,
    'nature chemical biology': 190,
    'nature communications': 30,
    'nature methods': 350,
    'nature microbiology': 200,
    'nature protocols': 350,
    'nature reviews genetics': 0,
    'nature reviews microbiology': 330,
    'nature structural and molecular biology': 200,
    'plos one': 200,
    'plos genetics': 200,
    'proceedings of the national academy of sciences': 240,
    'science': 0,
    'scientific reports': 0,
    'trends in biotechnology': 200,
    'trends in microbiology': 200
};

  /* Exact colour codes, read off each journal's own website on 2026-09-19 with a
     real browser: on nature.com the coloured rule under the header is the
     journal's identity (Nature Communications #e63323, Nature Biotechnology
     #efd600); Cell Press, ASM, ACS, PLOS, Frontiers, Oxford and Springer Nature
     Link carry theirs in the masthead or header. null means the journal's
     masthead is black and it has no colour of its own (Nature, Scientific
     Reports). These take precedence over the hue tables below. */
  const JOURNAL_COLOURS = {
      'acs synthetic biology': '#0039a6',
      'applied microbiology and biotechnology': '#bfff00',
      'applied and environmental microbiology': '#6e101c',
      'bioinformatics': '#167da4',
      'biotechnology advances': '#8a752f',
      'biotechnology and bioengineering': '#180d43',
      'cell': '#007dbc',
      'cell host and microbe': '#007dbc',
      'cell reports': '#007dbc',
      'cell systems': '#007dbc',
      'chemical science': '#004976',
      'communications biology': '#e30613',
      'current biology': '#007dbc',
      'embo journal': '#ff0095',
      'environmental microbiology': '#180d43',
      'extremophiles': '#bfff00',
      'fems microbiology letters': '#204d39',
      'fems microbiology reviews': '#204d39',
      'frontiers in microbiology': '#001991',
      'genome biology': '#0015ff',
      'journal of bacteriology': '#6e101c',
      'journal of molecular biology': '#0272b1',
      'journal of the american chemical society': '#0039a6',
      'metabolic engineering': '#e87224',
      'microbial biotechnology': '#180d43',
      'microbial cell factories': '#0070a8',
      'microbiology and molecular biology reviews': '#6e101c',
      'molecular cell': '#007dbc',
      'molecular microbiology': '#180d43',
      'molecular systems biology': '#ffbf00',
      'nature': null,
      'nature aging': '#006eb7',
      'nature biomedical engineering': '#964091',
      'nature biotechnology': '#efd600',
      'nature cancer': '#e40428',
      'nature cardiovascular research': '#e5005b',
      'nature catalysis': '#006eb7',
      'nature cell biology': '#0085c8',
      'nature chemical biology': '#0094a4',
      'nature chemical engineering': '#00928c',
      'nature chemistry': '#6c4796',
      'nature climate change': '#0095bb',
      'nature communications': '#e63323',
      'nature ecology and evolution': '#c7d530',
      'nature energy': '#eb5b25',
      'nature food': '#fbba00',
      'nature genetics': '#008b68',
      'nature human behaviour': '#1951a0',
      'nature immunology': '#1951a0',
      'nature machine intelligence': '#0095bb',
      'nature materials': '#e40428',
      'nature medicine': '#e40428',
      'nature mental health': '#229863',
      'nature metabolism': '#eb5b25',
      'nature methods': '#eb5b25',
      'nature microbiology': '#964091',
      'nature nanotechnology': '#f7a70a',
      'nature neuroscience': '#00928c',
      'nature photonics': '#006eb7',
      'nature physics': '#494495',
      'nature plants': '#299751',
      'nature protocols': '#494495',
      'nature reviews chemistry': '#008b68',
      'nature reviews drug discovery': '#f7a70a',
      'nature reviews genetics': '#e40428',
      'nature reviews immunology': '#6c4796',
      'nature reviews methods primers': '#fbba00',
      'nature reviews microbiology': '#e5005b',
      'nature reviews molecular cell biology': '#1951a0',
      'nature reviews neuroscience': '#3fa535',
      'nature structural and molecular biology': '#6c4796',
      'nature sustainability': '#e63323',
      'nature synthesis': '#c82285',
      'nature water': '#0094a4',
      'nucleic acids research': '#011e41',
      'plos biology': '#0523a2',
      'plos one': '#cc00a6',
      'pnas': '#1f75b9',
      'proceedings of the national academy of sciences': '#1f75b9',
      'science': '#ca2015',
      'science advances': '#ca2015',
      'scientific reports': null,
      'the embo journal': '#ff0095',
      'trends in biochemical sciences': '#007dbc',
      'trends in microbiology': '#007dbc',
      'elife': '#083d87',
      'mbio': '#6e101c',
      'npj biofilms and microbiomes': '#e30613'
  };


  const NATURE_TITLES = [
    [/^nature$/, 168], [/^nature communications/, 30], [/^nature biotechnology/, 50],
    [/^nature methods/, 350], [/^nature chemical biology/, 190], [/^nature genetics/, 40],
    [/^nature cell biology/, 200], [/^nature immunology/, 350], [/^nature neuroscience/, 25],
    [/^nature medicine/, 5], [/^nature structural/, 200], [/^nature microbiology/, 200],
    [/^nature chemistry/, 320], [/^nature materials/, 30], [/^nature physics/, 230],
    [/^nature nanotechnology/, 15], [/^nature photonics/, 42], [/^nature catalysis/, 210],
    [/^nature energy/, 60], [/^nature ecology/, 120], [/^nature plants/, 110],
    [/^nature metabolism/, 300], [/^nature machine intelligence/, 250], [/^nature sustainability/, 150],
    [/^nature climate change/, 190], [/^nature human behaviour/, 340], [/^nature aging/, 275],
    [/^nature cancer/, 355], [/^nature synthesis/, 35], [/^nature food/, 80], [/^nature water/, 205],
    [/^nature cardiovascular/, 10], [/^nature mental health/, 330], [/^nature protocols/, 350],
    [/^nature reviews/, 330], [/^scientific reports/, 0], [/^npj\b/, 165], [/^communications /, 0]
  ];
  function natureHue(title) {
    const key = flat(title);
    const hit = NATURE_TITLES.find(([test]) => test.test(key));
    return hit ? hit[1] : 168;
  }

  const FAMILIES = [
    // --- Nature portfolio: the house colour, with the flagship darker ---
    {key: 'nature', label: 'Nature', mark: 'N', hue: 8, test: /^nature$/},
    {key: 'nature-portfolio', label: 'Nature Portfolio', hue: natureHue,
     // Scientific Reports and the Communications titles are Nature portfolio
     // too, and a reader knows it even though the name does not say so.
     test: /^(nature|npj|scientific reports|communications (biology|chemistry|physics|materials|earth|engineering|medicine))\b/,
     mark: title => monogram(title, 'N')},
    // --- the other flagships ---
    {key: 'science', label: 'Science', mark: 'S', hue: 358, test: /^science$/},
    {key: 'aaas', label: 'AAAS', hue: 358, test: /^science\b(advances|immunology|robotics|signaling|translational)?/,
     mark: title => monogram(title, 'S')},
    {key: 'pnas', label: 'PNAS', mark: 'PN', hue: 240,
     test: /^proceedings of the national academy|^pnas\b/},
    {key: 'cell-press', label: 'Cell Press', hue: 200,
     test: /^(cell|molecular cell|developmental cell|cancer cell|immunity|neuron|chem|joule|matter|one earth|med|current biology|structure|trends in)\b/,
     mark: title => monogram(title, 'C')},
    // --- society and university presses ---
    {key: 'oxford', label: 'Oxford', hue: 232,
     test: /^(nucleic acids research|bioinformatics|briefings in|nar |database|molecular biology and evolution|fems )/,
     mark: title => monogram(title, 'O')},
    {key: 'asm', label: 'ASM', hue: 190,
     test: /^(applied and environmental microbiology|journal of bacteriology|mbio|msystems|msphere|mmbr|microbiology and molecular biology reviews|antimicrobial agents|journal of virology|infection and immunity|journal of clinical microbiology)\b/,
     mark: title => monogram(title, 'A')},
    {key: 'acs', label: 'ACS', hue: 208,
     test: /^(acs |journal of the american chemical society|analytical chemistry|biochemistry$|journal of agricultural and food chemistry|environmental science and technology)/,
     mark: title => monogram(title, 'ACS')},
    {key: 'rsc', label: 'RSC', hue: 344,
     test: /^(chemical (science|communications|society reviews)|green chemistry|soft matter|lab on a chip|analyst$)/,
     mark: title => monogram(title, 'RSC')},
    {key: 'embo', label: 'EMBO', hue: 12,
     test: /^(the )?embo |^molecular systems biology/, mark: title => monogram(title, 'EM')},
    {key: 'elife', label: 'eLife', mark: 'eL', hue: 24, test: /^elife/},
    {key: 'plos', label: 'PLOS', hue: 32, test: /^plos\b|^plo s\b/, mark: title => monogram(title, 'PL')},
    {key: 'frontiers', label: 'Frontiers', hue: 152, test: /^frontiers in\b/, mark: title => monogram(title, 'F')},
    {key: 'mdpi', label: 'MDPI', hue: 140,
     test: /^(ijms|international journal of molecular sciences|microorganisms|biomolecules|catalysts|polymers|molecules|foods|sensors|cells)$/,
     mark: title => monogram(title, 'M')},
    // --- the big commercial houses, last: their titles are the least regular ---
    {key: 'elsevier', label: 'Elsevier', hue: 28,
     test: /^(metabolic engineering|journal of (molecular biology|biological chemistry|biotechnology)|bioresource technology|biotechnology advances|enzyme and microbial|process biochemistry|food chemistry|international journal of biological macromolecules|current opinion in|methods in enzymology|biochimica et biophysica)/,
     mark: title => monogram(title, 'E')},
    {key: 'springer', label: 'Springer', hue: 214,
     test: /^(applied microbiology and biotechnology|extremophiles|archives of microbiology|world journal of microbiology|biotechnology letters|journal of industrial microbiology|amb express|microbial cell factories|biotechnology for biofuels|bmc )/,
     mark: title => monogram(title, 'Sp')},
    {key: 'wiley', label: 'Wiley', hue: 246,
     test: /^(biotechnology and bioengineering|molecular microbiology|environmental microbiology|microbial biotechnology|febs |protein science|angewandte|advanced science|chembiochem)/,
     mark: title => monogram(title, 'W')}
  ];

  /* Publisher name -> family, for the journals the title patterns never saw.

     Measured over every JCR journal, the title rules reached 3%: 84 exact
     colours, 559 by a pattern, and 21,951 left to a hue derived from the
     name -- stable, but meaningless. OpenAlex knows the publisher of nearly
     all of them by ISSN, and thirty publishers account for most of the list.
     A journal nobody curated still gets the colour of the house that prints
     it, which is the thing a reader recognises. Names here are the strings
     OpenAlex actually returns, most frequent first. */
  const PUBLISHER_FAMILY = [
    [/elsevier/i, 'elsevier'],
    [/springer|biomed central|bmc\b|adis/i, 'springer'],
    [/wiley|blackwell/i, 'wiley'],
    [/taylor\s*&\s*francis|routledge|informa/i, 'taylor-francis'],
    [/\bsage\b/i, 'sage'],
    [/oxford university press/i, 'oxford'],
    [/cambridge university press/i, 'cambridge'],
    [/nature portfolio|nature publishing/i, 'nature-portfolio'],
    [/american chemical society/i, 'acs'],
    [/royal society of chemistry/i, 'rsc'],
    [/frontiers media/i, 'frontiers'],
    [/multidisciplinary digital publishing|\bmdpi\b/i, 'mdpi'],
    [/public library of science|\bplos\b/i, 'plos'],
    [/american society for microbiology/i, 'asm'],
    [/american association for the advancement of science/i, 'aaas'],
    [/cell press/i, 'cell-press'],
    [/\belife\b/i, 'elife'],
    [/\bembo\b/i, 'embo'],
    [/institute of electrical and electronics engineers|\bieee\b/i, 'ieee'],
    [/association for computing machinery|\bacm\b/i, 'acm'],
    [/emerald/i, 'emerald'],
    [/lippincott|wolters kluwer/i, 'wolters-kluwer'],
    [/annual reviews/i, 'annual-reviews'],
    [/iop publishing|institute of physics/i, 'iop'],
    [/american physical society/i, 'aps'],
    [/hindawi/i, 'hindawi'],
    [/\bbmj\b/i, 'bmj'],
    [/karger/i, 'karger'],
    [/american psychological association/i, 'apa'],
    [/de gruyter/i, 'degruyter'],
    [/bentham/i, 'bentham'],
    [/dove medical/i, 'dove'],
    [/mary ann liebert/i, 'liebert'],
    [/thieme/i, 'thieme'],
    [/american medical association/i, 'ama'],
    [/massachusetts medical society/i, 'nejm'],
    [/the lancet/i, 'lancet'],
    [/proceedings of the national academy|national academy of sciences/i, 'pnas']
  ];
  // Families the title rules never needed, each with its own hue.
  const PUBLISHER_HUES = {
    'taylor-francis': 200, sage: 210, cambridge: 355, ieee: 208, acm: 210, emerald: 160,
    'wolters-kluwer': 200, 'annual-reviews': 30, iop: 350, aps: 220, hindawi: 100, bmj: 214,
    karger: 205, apa: 215, degruyter: 200, bentham: 20, dove: 150, liebert: 340, thieme: 220,
    ama: 208, nejm: 10, lancet: 350
  };
  const PUBLISHER_LABELS = {
    'taylor-francis': 'Taylor & Francis', sage: 'SAGE', cambridge: 'Cambridge', ieee: 'IEEE', acm: 'ACM',
    emerald: 'Emerald', 'wolters-kluwer': 'Wolters Kluwer', 'annual-reviews': 'Annual Reviews', iop: 'IOP',
    aps: 'APS', hindawi: 'Hindawi', bmj: 'BMJ', karger: 'Karger', apa: 'APA', degruyter: 'De Gruyter',
    bentham: 'Bentham', dove: 'Dove', liebert: 'Liebert', thieme: 'Thieme', ama: 'AMA', nejm: 'NEJM', lancet: 'Lancet'
  };
  /* Publishers that were still unmapped after the big houses, with their own
     hue so the family is stable across builds rather than hashed. Measured on
     the full JCR list: these are the ones with the most journals each. */
  const TAIL_PUBLISHERS = [
    [/\bbrill\b/i, 'brill', 'Brill', 25], [/pleiades/i, 'pleiades', 'Pleiades', 205],
    [/medknow/i, 'medknow', 'Medknow', 150], [/world scientific/i, 'world-scientific', 'World Scientific', 215],
    [/inderscience/i, 'inderscience', 'Inderscience', 10], [/john benjamins/i, 'benjamins', 'John Benjamins', 40],
    [/university of chicago press/i, 'uchicago', 'U Chicago Press', 350], [/johns hopkins university press/i, 'jhup', 'JHU Press', 215],
    [/igi global/i, 'igi', 'IGI Global', 200], [/ios press/i, 'ios', 'IOS Press', 205],
    [/palgrave/i, 'palgrave', 'Palgrave', 220], [/duke university press/i, 'duke', 'Duke UP', 220],
    [/birkh/i, 'birkhauser', 'Birkhäuser', 214], [/institution of engineering and technology/i, 'iet', 'IET', 200],
    [/american society of civil engineers/i, 'asce', 'ASCE', 210]
  ];
  // A stable key and hue for a publisher nobody listed, from its name. Every
  // journal of that house then shares one colour, which is what a publisher
  // colour is for; only a journal with no publisher at all falls back to a
  // hue from its own title.
  const publisherSlug = name => 'pub:' + flat(name).replace(/ /g, '-').slice(0, 48);
  function familyForPublisher(publisher) {
    const name = text(publisher);
    if (!name) return null;
    for (const [pattern, key] of PUBLISHER_FAMILY) if (pattern.test(name)) return key;
    for (const [pattern, key] of TAIL_PUBLISHERS) if (pattern.test(name)) return key;
    return publisherSlug(name);
  }
  // A family's hue and label whether it came from a title rule, a listed
  // publisher, or a publisher known only by name.
  const PUBLISHER_NAMES = new Map();
  function familyInfo(key, publisherName) {
    const titled = FAMILIES.find(family => family.key === key);
    if (titled) return {hue: titled.hue, label: titled.label};
    if (key in PUBLISHER_HUES) return {hue: PUBLISHER_HUES[key], label: PUBLISHER_LABELS[key] || key};
    const tail = TAIL_PUBLISHERS.find(row => row[1] === key);
    if (tail) return {hue: tail[3], label: tail[2]};
    if (key.startsWith('pub:')) {
      const label = text(publisherName) || PUBLISHER_NAMES.get(key) || key.slice(4);
      if (publisherName) PUBLISHER_NAMES.set(key, label);
      return {hue: derivedHue(key), label};
    }
    return null;
  }

  // An initialism from the words that carry meaning, so an unknown journal still
  // gets a mark that means something: "Journal of Molecular Biology" -> JMB.
  const SKIP = new Set(['the', 'of', 'and', 'in', 'for', 'on', 'a', 'an', 'at', 'to', 'de', 'der']);
  function monogram(title, fallback) {
    const words = flat(title).split(' ').filter(word => word && !SKIP.has(word));
    if (!words.length) return fallback || '?';
    if (words.length === 1) {
      // A one-word title keeps up to four letters: "Cell" is the mark, "Ce" is
      // not a name anybody recognises.
      const one = words[0];
      return (one.length <= 4 ? one : one.slice(0, 3)).replace(/^./, c => c.toUpperCase());
    }
    const letters = words.slice(0, 3).map(word => word[0].toUpperCase()).join('');
    return letters.length >= 2 ? letters : (fallback || letters);
  }


  /* The journal's standard abbreviation, the way a reference list writes it: "Nat
     Commun", "Mol Cell", "Nucleic Acids Res". A curated table settles the titles a
     reader here meets most; anything else is abbreviated word by word from the
     ISO 4 / NLM word list below, and a word the list does not know is kept whole,
     so an unfamiliar journal is never mangled into a guess. One-word titles stay as
     they are: "Nature" is not "Nat". */
  const ABBREVIATIONS = {"PNAS":"PNAS","Proceedings of the National Academy of Sciences":"PNAS","Proceedings of the National Academy of Sciences of the United States of America":"PNAS","The ISME Journal":"ISME J","ISME Journal":"ISME J","mBio":"mBio","mSystems":"mSystems","mSphere":"mSphere","eLife":"eLife","EMBO Journal":"EMBO J","The EMBO Journal":"EMBO J","EMBO Reports":"EMBO Rep","PLOS ONE":"PLoS ONE","PLoS ONE":"PLoS ONE","Nucleic Acids Research":"Nucleic Acids Res","Journal of the American Chemical Society":"J Am Chem Soc","Angewandte Chemie International Edition":"Angew Chem Int Ed","Journal of Biological Chemistry":"J Biol Chem","Nature":"Nature","Science":"Science","Cell":"Cell","BMC Genomics":"BMC Genomics","BMC Biology":"BMC Biol","BMC Microbiology":"BMC Microbiol","Scientific Reports":"Sci Rep","Nature Communications":"Nat Commun","Applied and Environmental Microbiology":"Appl Environ Microbiol","Journal of Bacteriology":"J Bacteriol","Metabolic Engineering":"Metab Eng","ACS Synthetic Biology":"ACS Synth Biol","Biotechnology and Bioengineering":"Biotechnol Bioeng","Microbial Cell Factories":"Microb Cell Fact","Bioinformatics":"Bioinformatics","Genome Research":"Genome Res","Genome Biology":"Genome Biol","Nature Methods":"Nat Methods","Nature Biotechnology":"Nat Biotechnol","Nature Microbiology":"Nat Microbiol","Nature Chemical Biology":"Nat Chem Biol","Molecular Cell":"Mol Cell","Cell Reports":"Cell Rep","Cell Systems":"Cell Syst","Current Biology":"Curr Biol","Trends in Biochemical Sciences":"Trends Biochem Sci","Trends in Microbiology":"Trends Microbiol","Trends in Biotechnology":"Trends Biotechnol","Science Advances":"Sci Adv","Nature Reviews Microbiology":"Nat Rev Microbiol","Nature Reviews Genetics":"Nat Rev Genet","Nature Reviews Molecular Cell Biology":"Nat Rev Mol Cell Biol","Frontiers in Microbiology":"Front Microbiol","Journal of Molecular Biology":"J Mol Biol","Nature Structural & Molecular Biology":"Nat Struct Mol Biol","Journal of Virology":"J Virol","Microbiome":"Microbiome","Molecular Microbiology":"Mol Microbiol","Environmental Microbiology":"Environ Microbiol","Nucleic Acids Symposium Series":"Nucleic Acids Symp Ser","Biochemistry (Moscow)":"Biochemistry (Mosc)","Extremophiles":"Extremophiles","Chemical Science":"Chem Sci","Chemical Communications":"Chem Commun","Chemical Society Reviews":"Chem Soc Rev","Analytical Chemistry":"Anal Chem","Biochemistry":"Biochemistry","New England Journal of Medicine":"N Engl J Med","The Lancet":"Lancet","Lancet":"Lancet","JAMA":"JAMA","Nature Medicine":"Nat Med","Nature Genetics":"Nat Genet","Nature Cell Biology":"Nat Cell Biol","Nature Immunology":"Nat Immunol","Nature Neuroscience":"Nat Neurosci","Nature Chemistry":"Nat Chem","Nature Materials":"Nat Mater","Nature Physics":"Nat Phys","Nature Nanotechnology":"Nat Nanotechnol","Nature Photonics":"Nat Photonics","Nature Catalysis":"Nat Catal","Nature Energy":"Nat Energy","Nature Plants":"Nat Plants","Nature Ecology & Evolution":"Nat Ecol Evol","Nature Metabolism":"Nat Metab","Nature Machine Intelligence":"Nat Mach Intell","Nature Sustainability":"Nat Sustain","Nature Climate Change":"Nat Clim Chang","Nature Human Behaviour":"Nat Hum Behav","Nature Aging":"Nat Aging","Nature Cancer":"Nat Cancer","Nature Synthesis":"Nat Synth","Nature Food":"Nat Food","Nature Water":"Nat Water","Nature Protocols":"Nat Protoc","Nature Biomedical Engineering":"Nat Biomed Eng","Communications Biology":"Commun Biol","Communications Chemistry":"Commun Chem","Communications Physics":"Commun Phys","Communications Materials":"Commun Mater","Communications Earth & Environment":"Commun Earth Environ","Communications Engineering":"Commun Eng","Communications Medicine":"Commun Med","npj Biofilms and Microbiomes":"npj Biofilms Microbiomes","Nature Cardiovascular Research":"Nat Cardiovasc Res","Nature Mental Health":"Nat Ment Health","Nature Chemical Engineering":"Nat Chem Eng","Nature Reviews Chemistry":"Nat Rev Chem","Nature Reviews Drug Discovery":"Nat Rev Drug Discov","Nature Reviews Immunology":"Nat Rev Immunol","Nature Reviews Neuroscience":"Nat Rev Neurosci","Nature Reviews Cancer":"Nat Rev Cancer","Nature Reviews Materials":"Nat Rev Mater","Nature Reviews Physics":"Nat Rev Phys","Nature Reviews Disease Primers":"Nat Rev Dis Primers","Nature Reviews Methods Primers":"Nat Rev Methods Primers","Advances in Applied Microbiology":"Adv Appl Microbiol","Applied Microbiology and Biotechnology":"Appl Microbiol Biotechnol","AMB Express":"AMB Express","Biotechnology Advances":"Biotechnol Adv","Biotechnology for Biofuels":"Biotechnol Biofuels","Biotechnology Letters":"Biotechnol Lett","Bioresource Technology":"Bioresour Technol","Enzyme and Microbial Technology":"Enzyme Microb Technol","Process Biochemistry":"Process Biochem","Journal of Biotechnology":"J Biotechnol","Journal of Industrial Microbiology & Biotechnology":"J Ind Microbiol Biotechnol","Journal of Industrial Microbiology and Biotechnology":"J Ind Microbiol Biotechnol","Microbial Biotechnology":"Microb Biotechnol","Molecular Systems Biology":"Mol Syst Biol","Systems Microbiology and Biomanufacturing":"Syst Microbiol Biomanuf","Synthetic and Systems Biotechnology":"Synth Syst Biotechnol","Metabolic Engineering Communications":"Metab Eng Commun","Cell and Tissue Biology":"Cell Tissue Biol","Biochemical Society Transactions":"Biochem Soc Trans","Journal of Cleaner Production":"J Clean Prod","Archives of Microbiology":"Arch Microbiol","World Journal of Microbiology and Biotechnology":"World J Microbiol Biotechnol","International Journal of Molecular Sciences":"Int J Mol Sci","Microorganisms":"Microorganisms","Molecules":"Molecules","Catalysts":"Catalysts","Polymers":"Polymers","Biomolecules":"Biomolecules","Cells":"Cells","Foods":"Foods","Sensors":"Sensors","International Journal of Biological Macromolecules":"Int J Biol Macromol","Biochimica et Biophysica Acta":"Biochim Biophys Acta","Methods in Enzymology":"Methods Enzymol","Journal of Agricultural and Food Chemistry":"J Agric Food Chem","Environmental Science & Technology":"Environ Sci Technol","Green Chemistry":"Green Chem","Soft Matter":"Soft Matter","Lab on a Chip":"Lab Chip","Analyst":"Analyst","PLOS Biology":"PLoS Biol","PLOS Genetics":"PLoS Genet","PLOS Pathogens":"PLoS Pathog","PLOS Computational Biology":"PLoS Comput Biol","FEMS Microbiology Reviews":"FEMS Microbiol Rev","FEMS Microbiology Letters":"FEMS Microbiol Lett","FEMS Microbiology Ecology":"FEMS Microbiol Ecol","Molecular Biology and Evolution":"Mol Biol Evol","Briefings in Bioinformatics":"Brief Bioinform","Database":"Database","Protein Science":"Protein Sci","FEBS Letters":"FEBS Lett","FEBS Journal":"FEBS J","The FEBS Journal":"FEBS J","Advanced Science":"Adv Sci","ChemBioChem":"ChemBioChem","Immunity":"Immunity","Neuron":"Neuron","Chem":"Chem","Joule":"Joule","Matter":"Matter","One Earth":"One Earth","Med":"Med","Structure":"Structure","Developmental Cell":"Dev Cell","Cancer Cell":"Cancer Cell","Cell Host & Microbe":"Cell Host Microbe","Cell Chemical Biology":"Cell Chem Biol","Cell Metabolism":"Cell Metab","Cell Stem Cell":"Cell Stem Cell","Molecular Plant":"Mol Plant","iScience":"iScience","STAR Protocols":"STAR Protoc","Antimicrobial Agents and Chemotherapy":"Antimicrob Agents Chemother","Journal of Clinical Microbiology":"J Clin Microbiol","Infection and Immunity":"Infect Immun","Microbiology and Molecular Biology Reviews":"Microbiol Mol Biol Rev","Science Immunology":"Sci Immunol","Science Robotics":"Sci Robot","Science Signaling":"Sci Signal","Science Translational Medicine":"Sci Transl Med","Journal of the Royal Society Interface":"J R Soc Interface","Philosophical Transactions of the Royal Society B":"Philos Trans R Soc B","Proceedings of the Royal Society B":"Proc R Soc B","Genes & Development":"Genes Dev","RNA":"RNA","Nucleic Acids Research Genomics and Bioinformatics":"NAR Genom Bioinform","Journal of Bacteriology and Virology":"J Bacteriol Virol","Applied Biological Chemistry":"Appl Biol Chem","Journal of Microbiology and Biotechnology":"J Microbiol Biotechnol","Journal of Microbiology":"J Microbiol","Korean Journal of Microbiology":"Korean J Microbiol","Biotechnology and Bioprocess Engineering":"Biotechnol Bioprocess Eng"};
  const ABBREVIATION_WORDS = {"journal":"J","journals":"J","biology":"Biol","biological":"Biol","biotechnology":"Biotechnol","microbiology":"Microbiol","microbiological":"Microbiol","chemistry":"Chem","chemical":"Chem","chemie":"Chem","molecular":"Mol","cellular":"Cell","research":"Res","communications":"Commun","communication":"Commun","reviews":"Rev","review":"Rev","applied":"Appl","environmental":"Environ","engineering":"Eng","science":"Sci","sciences":"Sci","scientific":"Sci","structural":"Struct","structure":"Struct","genetics":"Genet","genetic":"Genet","nature":"Nat","proceedings":"Proc","national":"Natl","academy":"Acad","american":"Am","society":"Soc","international":"Int","european":"Eur","letters":"Lett","physics":"Phys","physical":"Phys","biochemistry":"Biochem","biochemical":"Biochem","immunology":"Immunol","medicine":"Med","medical":"Med","neuroscience":"Neurosci","synthetic":"Synth","synthesis":"Synth","systems":"Syst","system":"Syst","metabolic":"Metab","metabolism":"Metab","bacteriology":"Bacteriol","virology":"Virol","reports":"Rep","report":"Rep","advances":"Adv","advanced":"Adv","frontiers":"Front","current":"Curr","opinion":"Opin","annual":"Annu","analytical":"Anal","technology":"Technol","technologies":"Technol","microbial":"Microb","ecology":"Ecol","evolution":"Evol","evolutionary":"Evol","development":"Dev","developmental":"Dev","physiology":"Physiol","pharmacology":"Pharmacol","nanotechnology":"Nanotechnol","materials":"Mater","catalysis":"Catal","sustainability":"Sustain","climate":"Clim","behaviour":"Behav","behavior":"Behav","human":"Hum","machine":"Mach","intelligence":"Intell","protocols":"Protoc","biomedical":"Biomed","discovery":"Discov","clinical":"Clin","oncology":"Oncol","disease":"Dis","diseases":"Dis","computational":"Comput","computing":"Comput","computer":"Comput","bioengineering":"Bioeng","industrial":"Ind","archives":"Arch","agricultural":"Agric","macromolecules":"Macromol","bioresource":"Bioresour","biochimica":"Biochim","biophysica":"Biophys","biophysics":"Biophys","biophysical":"Biophys","angewandte":"Angew","edition":"Ed","production":"Prod","cleaner":"Clean","bulletin":"Bull","transactions":"Trans","quarterly":"Q","mathematics":"Math","mathematical":"Math","statistics":"Stat","statistical":"Stat","psychology":"Psychol","psychological":"Psychol","economics":"Econ","economic":"Econ","education":"Educ","management":"Manag","information":"Inf","infection":"Infect","infectious":"Infect","antimicrobial":"Antimicrob","agents":"Agents","chemotherapy":"Chemother","molecules":"Molecules","organisms":"Organisms","enzyme":"Enzyme","protein":"Protein","proteins":"Proteins","genome":"Genome","genomics":"Genomics","proteomics":"Proteomics","bioinformatics":"Bioinformatics","briefings":"Brief","database":"Database","nucleic":"Nucleic","acids":"Acids","acta":"Acta","toxicology":"Toxicol","pathology":"Pathol","pathogens":"Pathog","plant":"Plant","plants":"Plants","animal":"Anim","marine":"Mar","food":"Food","water":"Water","energy":"Energy","environment":"Environ","earth":"Earth","planetary":"Planet","astrophysical":"Astrophys","astronomy":"Astron","optics":"Opt","optical":"Opt","photonics":"Photonics","electronics":"Electron","electronic":"Electron","electrical":"Electr","mechanical":"Mech","mechanics":"Mech","thermal":"Therm","fluid":"Fluid","fluids":"Fluids","nutrition":"Nutr","pharmaceutical":"Pharm","pharmaceutics":"Pharm","therapy":"Ther","therapeutics":"Ther","surgery":"Surg","surgical":"Surg","cardiology":"Cardiol","cardiovascular":"Cardiovasc","neurology":"Neurol","neurological":"Neurol","psychiatry":"Psychiatry","radiology":"Radiol","aging":"Aging","cancer":"Cancer","biomacromolecules":"Biomacromolecules","express":"Express","factories":"Fact","biofuels":"Biofuels","bioproducts":"Bioprod","technical":"Tech","processes":"Process","process":"Process","world":"World","russian":"Russ","chinese":"Chin","japanese":"Jpn","korean":"Korean","british":"Br","canadian":"Can","australian":"Aust","indian":"Indian","royal":"R","university":"Univ","institute":"Inst","laboratory":"Lab","methods":"Methods","method":"Method","techniques":"Tech","applications":"Appl","application":"Appl","general":"Gen","comparative":"Comp","experimental":"Exp","theoretical":"Theor","practice":"Pract","quantitative":"Quant","integrative":"Integr","interdisciplinary":"Interdiscip","perspectives":"Perspect","trends":"Trends","insights":"Insights","open":"Open","access":"Access","public":"Public","health":"Health","global":"Glob","regional":"Reg","studies":"Stud","study":"Stud","history":"Hist","philosophy":"Philos","social":"Soc","sociology":"Sociol","political":"Polit","policy":"Policy","law":"Law","business":"Bus","finance":"Financ","financial":"Financ","accounting":"Account","marketing":"Mark","organization":"Organ","organizational":"Organ","urban":"Urban","transport":"Transp","transportation":"Transp","construction":"Constr","civil":"Civ","geology":"Geol","geological":"Geol","geophysical":"Geophys","geophysics":"Geophys","geography":"Geogr","geographical":"Geogr","hydrology":"Hydrol","soil":"Soil","atmospheric":"Atmos","oceanography":"Oceanogr","ecological":"Ecol","conservation":"Conserv","biodiversity":"Biodivers","forest":"For","forestry":"For","veterinary":"Vet","dental":"Dent","dentistry":"Dent","nursing":"Nurs","pediatric":"Pediatr","pediatrics":"Pediatr","obstetrics":"Obstet","gynecology":"Gynecol","dermatology":"Dermatol","ophthalmology":"Ophthalmol","endocrinology":"Endocrinol","gastroenterology":"Gastroenterol","hepatology":"Hepatol","nephrology":"Nephrol","rheumatology":"Rheumatol","hematology":"Hematol","urology":"Urol","anesthesiology":"Anesthesiol","emergency":"Emerg","epidemiology":"Epidemiol","virulence":"Virulence","immunity":"Immunity","inflammation":"Inflamm","allergy":"Allergy","vaccine":"Vaccine","vaccines":"Vaccines","antibiotics":"Antibiotics","resistance":"Resist","signaling":"Signal","signalling":"Signal","transduction":"Transduct","regulation":"Regul","regulatory":"Regul","expression":"Expr","function":"Funct","functional":"Funct","dynamics":"Dyn","dynamic":"Dyn","kinetics":"Kinet","thermodynamics":"Thermodyn","spectroscopy":"Spectrosc","spectrometry":"Spectrom","microscopy":"Microsc","imaging":"Imaging","crystallography":"Crystallogr","crystal":"Cryst","polymer":"Polym","polymers":"Polymers","composites":"Compos","ceramics":"Ceram","metallurgy":"Metall","alloys":"Alloys","surfaces":"Surf","surface":"Surf","interfaces":"Interfaces","interface":"Interface","colloid":"Colloid","colloids":"Colloids","nanoscale":"Nanoscale","nano":"Nano","quantum":"Quantum","nuclear":"Nucl","particle":"Part","particles":"Part","plasma":"Plasma","condensed":"Condens","matter":"Matter","solid":"Solid","state":"State","semiconductor":"Semicond","devices":"Devices","device":"Device","circuits":"Circuits","networks":"Netw","network":"Netw","software":"Softw","data":"Data","artificial":"Artif","learning":"Learn","robotics":"Robot","automation":"Autom","control":"Control","signal":"Signal","processing":"Process","vision":"Vis","pattern":"Pattern","recognition":"Recognit","language":"Lang","linguistics":"Linguist","cognitive":"Cogn","cognition":"Cogn","brain":"Brain","behavioral":"Behav","reproduction":"Reprod","reproductive":"Reprod","fertility":"Fertil","embryology":"Embryol","stem":"Stem","cells":"Cells","tissue":"Tissue","regenerative":"Regen","biomaterials":"Biomater","biomechanics":"Biomech","biomedicine":"Biomed","translational":"Transl","precision":"Precis","personalized":"Pers","digital":"Digit"};
  const ABBREVIATION_SKIP = new Set(["the", "of", "and", "in", "for", "on", "a", "an", "at", "to", "de", "der", "des", "du", "la", "le", "et", "und", "f\u00fcr", "fur", "di", "del", "della"]);
  function abbreviate(title) {
    const name = text(title);
    if (!name) return "";
    const known = ABBREVIATIONS[name] || ABBREVIATIONS[name.replace(/^The /i, "")];
    if (known) return known;
    const flatKey = flat(name);
    for (const [full, short] of Object.entries(ABBREVIATIONS)) if (flat(full) === flatKey) return short;
    const words = name.replace(/&/g, " and ").split(/\s+/).filter(Boolean);
    const kept = words.filter(w => !ABBREVIATION_SKIP.has(w.toLowerCase().replace(/[^a-z\u00c0-\u024f]/g, "")));
    if (kept.length <= 1) return name;
    return kept.map(w => {
      const bare = w.replace(/[^\p{L}\p{N}]/gu, "");
      const short = ABBREVIATION_WORDS[bare.toLowerCase()];
      if (!short) return w;
      return /^[A-Z]/.test(bare) ? short : short.toLowerCase();
    }).join(" ");
  }

  // A stable hue for a journal nobody curated, so the same title is always the
  // same colour and the column stays coherent instead of arbitrary.
  function derivedHue(title) {
    const value = flat(title);
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hash % 360;
  }

  /* Memoised on the title.

     The row's journal cell asks this through both the sort provider and the
     renderer, for four columns, on every repaint: about eight calls a row. At
     twenty microseconds each -- eighteen families of regular expressions, tried
     in order -- a forty-row viewport spent six milliseconds an scroll frame
     deciding facts that never change. A journal's publisher is fixed. */
  const seen = new Map();
  const SEEN_LIMIT = 4000;

  function identify(title) {
    const name = text(title);
    if (!name) return null;
    const cached = seen.get(name);
    if (cached !== undefined) return cached;
    const found = classify(name);
    /* Whatever branch named the colour, the registry's facts ride along:
       a journal matched by a title rule (Nature, Cell, Science) used to come
       back without its quartile or abbreviation, so the list showed Q1 on
       Chemical Reviews and nothing on Nature. */
    if (found) {
      const row = registryLookup(flat(name));
      if (row) {
        if (found.quartile == null) found.quartile = row.quartile ?? null;
        if (!found.abbreviation) found.abbreviation = row.abbreviation || '';
        if (!found.publisher) found.publisher = row.publisher || '';
        if (!found.issns) found.issns = row.issns || [];
        if (found.impactFactor == null) found.impactFactor = row.impactFactor ?? null;
        if (found.year == null) found.year = row.year ?? null;
      }
    }
    // A library has hundreds of journals, not thousands; the cap is there so a
    // pathological caller cannot grow this without bound.
    if (seen.size >= SEEN_LIMIT) seen.clear();
    seen.set(name, found);
    return found;
  }

  function classify(name) {
    const key = flat(name);
    const measured = JOURNAL_HUES[key];
    const exact = Object.prototype.hasOwnProperty.call(JOURNAL_COLOURS, key) ? JOURNAL_COLOURS[key] : undefined;
    for (const family of FAMILIES) {
      if (!family.test.test(key)) continue;
      // The mark is the journal's standard abbreviation; the monogram only stands
      // in when even that comes back empty.
      return {
        family: family.key, label: family.label,
        hue: exact ? Math.round(hexToHsl(exact).h) : measured ?? (typeof family.hue === 'function' ? family.hue(name) : family.hue),
        hex: exact, exact: exact !== undefined,
        mark: abbreviate(name) || (typeof family.mark === 'function' ? family.mark(name) : family.mark),
        known: true
      };
    }
    // A journal the patterns do not know but the PDFs do is still a known colour.
    if (exact !== undefined || measured != null) {
      return {family: 'other', label: '', hue: exact ? Math.round(hexToHsl(exact).h) : measured, hex: exact, exact: exact !== undefined,
        mark: abbreviate(name) || monogram(name), known: true};
    }
    /* Neither a title rule nor a measured colour. The registry may still know
       who publishes it, and a journal nobody curated then gets the colour of
       the house that prints it -- which is the thing a reader recognises.
       Measured over every JCR journal, the rules alone reached 3%. */
    const row = registryLookup(key);
    const family = row ? familyForPublisher(row.publisher) : null;
    const info = family ? familyInfo(family, row.publisher) : null;
    if (info) {
      return {family, label: info.label, hue: info.hue, known: true, viaPublisher: true,
        mark: abbreviate(name) || monogram(row.abbreviation || name),
        publisher: row.publisher, quartile: row.quartile, abbreviation: row.abbreviation,
        issns: row.issns || [], impactFactor: row.impactFactor ?? null, year: row.year ?? null};
    }
    return {family: 'other', label: '', hue: derivedHue(name), mark: abbreviate(name) || monogram(name), known: false,
      publisher: row ? row.publisher : '', quartile: row ? row.quartile : null, abbreviation: row ? row.abbreviation : '',
      issns: row ? (row.issns || []) : [], impactFactor: row ? (row.impactFactor ?? null) : null, year: row ? (row.year ?? null) : null};
  }

  /* The registry: one row per JCR journal, loaded once, looked up by the same
     flattened title the rules use and by ISSN. Absent under test or before the
     data file loads, every lookup simply misses and the old behaviour stands. */
  let REGISTRY = null;
  function loadRegistry(payload) {
    const list = Array.isArray(payload) ? payload : (payload && payload.journals) || [];
    REGISTRY = {byTitle: new Map(), byIssn: new Map(), size: list.length};
    for (const row of list) {
      const key = flat(row.title);
      if (key && !REGISTRY.byTitle.has(key)) REGISTRY.byTitle.set(key, row);
      const abbr = flat(row.abbreviation);
      if (abbr && !REGISTRY.byTitle.has(abbr)) REGISTRY.byTitle.set(abbr, row);
      for (const issn of row.issns || []) if (issn) REGISTRY.byIssn.set(String(issn).toUpperCase(), row);
    }
    seen.clear();
    return REGISTRY.size;
  }
  /* The whole registry in one order -- JIF descending, ties by name -- with
     each row's place in it. The user wants to see where a journal stands
     among all of them, and which journals they do not hold at all, not only
     the 255 in the library. Built once on first use. */
  function registryRanked() {
    if (!REGISTRY) return [];
    if (!REGISTRY.ranked) {
      const rows = [...new Set(REGISTRY.byTitle.values())];
      rows.sort((a, b) => (Number(b.impactFactor) || 0) - (Number(a.impactFactor) || 0) || String(a.title).localeCompare(String(b.title)));
      REGISTRY.ranked = rows.map((row, index) => ({...row, rank: index + 1, key: flat(row.title)}));
      REGISTRY.rankByKey = new Map(REGISTRY.ranked.map(row => [row.key, row.rank]));
    }
    return REGISTRY.ranked;
  }
  function registryRank(title) { registryRanked(); return REGISTRY && REGISTRY.rankByKey ? (REGISTRY.rankByKey.get(flat(title)) || null) : null; }
  function registryLookup(flatTitle) { return REGISTRY ? (REGISTRY.byTitle.get(flatTitle) || null) : null; }
  function registryByIssn(issn) { return REGISTRY ? (REGISTRY.byIssn.get(String(issn || '').toUpperCase()) || null) : null; }

  // The mark's ink and its fill, derived from one hue so every tile in the
  // column is built the same way. A curated family sits a little stronger than
  // a derived one, so a recognised publisher reads first.
  function colours(identity, {dark = false} = {}) {
    if (identity?.exact) return tonesFor(identity.hex, dark);
    const hue = identity?.hue ?? 0;
    const known = !!identity?.known;
    return dark
      ? {ink: hsl(hue, known ? 62 : 40, 74), fill: hsl(hue, known ? 44 : 26, 24), edge: hsl(hue, known ? 44 : 26, 36)}
      : {ink: hsl(hue, known ? 62 : 40, 40), fill: hsl(hue, known ? 62 : 36, 93), edge: hsl(hue, known ? 52 : 30, 84)};
  }

  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
  /* From one exact brand colour to ink and fill that read on the page. A
     yellow like #efd600 is the journal's colour but not legible as text on
     white, so the ink is the same hue pulled down to a readable lightness and
     the fill is the same hue washed nearly out; in dark mode the ink is lifted
     instead. The hue is never changed, only how light it is drawn. */
  function hexToHsl(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return {h: 0, s: 0, l};
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return {h: h * 60, s, l};
  }
  function luminance(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const c = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * c(n >> 16 & 255) + 0.7152 * c(n >> 8 & 255) + 0.0722 * c(n & 255);
  }
  /* From one exact brand colour to ink and fill that read on the page.

     The old rule re-saturated every brand to at least 45% and pinned the ink
     at 36% lightness. That is why the venue text never quite matched the
     badge beside it: Nucleic Acids Research is a near-black navy (#011e41),
     and pinning it at 36% made a vivid mid-blue; anything achromatic became a
     dark red, because a saturation floor of 45% has to pick some hue and it
     picks zero. Two colours in one row that are almost the same is worse
     than two that are clearly different.

     Now the brand colour is used as the ink verbatim whenever it already reads
     on the page -- most journal colours are dark enough -- and only pulled
     along its own hue, at its own saturation, when it does not. Black stays
     black. The fill is the same hue washed nearly out. */
  const WHITE = '#ffffff', DARK_BG = '#1c1c1f';
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
  }
  // Walk the lightness until the colour clears the contrast it needs, keeping
  // hue and saturation exactly as the brand has them.
  function readable(hex, dark) {
    const behind = dark ? DARK_BG : WHITE;
    if (contrast(hex, behind) >= 4.2) return hex;
    const {h, s, l} = hexToHsl(hex);
    let light = l;
    for (let step = 0; step < 40; step++) {
      light += dark ? 0.02 : -0.02;
      if (light <= 0.04 || light >= 0.96) break;
      const candidate = hslToHex(h, s, light);
      if (contrast(candidate, behind) >= 4.2) return candidate;
    }
    return dark ? '#e8e8ed' : '#1c1c1e';
  }
  function tonesFor(hex, dark) {
    if (!hex) return dark
      ? {ink: 'hsl(0 0% 88%)', fill: 'hsl(0 0% 24%)', edge: 'hsl(0 0% 36%)'}
      : {ink: 'hsl(0 0% 12%)', fill: 'hsl(0 0% 93%)', edge: 'hsl(0 0% 84%)'};
    const {h, s} = hexToHsl(hex);
    const sat = Math.round(s * 100);
    // The badge wears the exact code, with black or white lettering by luminance,
    // so the colour the journal actually prints is the colour on the row.
    const badge = {badge: hex, badgeInk: luminance(hex) > 0.42 ? '#111111' : '#ffffff'};
    const ink = readable(hex, dark);
    return dark
      ? {...badge, ink, fill: hsl(h, Math.round(sat * 0.7), 24), edge: hsl(h, Math.round(sat * 0.7), 36)}
      : {...badge, ink, fill: hsl(h, sat, 93), edge: hsl(h, Math.round(sat * 0.85), 84)};
  }

  const api = {identify, colours, monogram, abbreviate, derivedHue, natureHue, hexToHsl, hslToHex, contrast, readable, tonesFor, familyForPublisher, familyInfo, PUBLISHER_FAMILY, loadRegistry, registryLookup, registryByIssn, registryRanked, registryRank, _registrySize: () => (REGISTRY ? REGISTRY.size : 0), FAMILIES, NATURE_TITLES, ABBREVIATIONS, JOURNAL_HUES, JOURNAL_COLOURS, _cacheSize: () => seen.size};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleJournalIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
