/*
 * Who published this, shown as a mark in the publisher's own colour.
 *
 * A journal's publisher is the thing a reader recognises at a glance -- Science is
 * red, Cell is blue, Nature is green -- and a column of plain journal names hides
 * it. Each publisher family gets a lettermark drawn in its own hue; a journal
 * nobody curated gets an initialism in a colour derived from its name, so the same
 * title is always the same colour.
 *
 * The families, hues and monogram rules mirror the companion Style Custom plugin's
 * journal-identity module, so a paper reads the same in the search results as it
 * does in the library. Search hits also carry the publisher's name (OpenAlex,
 * Crossref), which settles the family for titles the patterns do not know.
 * Environment-agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPJournalMarks = (function () {
	"use strict";

	const text = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	const flat = value => text(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

	/* One entry per publisher family, in the order they are tested: a longer, more
	   specific pattern comes before the family it belongs to, or "Nature
	   Communications" would be matched by the rule for "Nature". */

	/* Every Nature sister journal wears its own cover colour, and a reader who
		 works in the field knows them: Biotechnology blue, Methods green, Chemical
		 Biology purple, Genetics amber, Medicine red. The portfolio is one family
		 but the marks are not one colour. Hues approximate the covers. */
	const NATURE_TITLES = [
		[/^nature$/, 168], [/^nature communications/, 22], [/^nature biotechnology/, 50],
		[/^nature methods/, 95], [/^nature chemical biology/, 285], [/^nature genetics/, 40],
		[/^nature cell biology/, 200], [/^nature immunology/, 350], [/^nature neuroscience/, 25],
		[/^nature medicine/, 5], [/^nature structural/, 260], [/^nature microbiology/, 140],
		[/^nature chemistry/, 320], [/^nature materials/, 30], [/^nature physics/, 230],
		[/^nature nanotechnology/, 15], [/^nature photonics/, 42], [/^nature catalysis/, 20],
		[/^nature energy/, 60], [/^nature ecology/, 120], [/^nature plants/, 110],
		[/^nature metabolism/, 300], [/^nature machine intelligence/, 250], [/^nature sustainability/, 150],
		[/^nature climate change/, 190], [/^nature human behaviour/, 340], [/^nature aging/, 275],
		[/^nature cancer/, 355], [/^nature synthesis/, 35], [/^nature food/, 80], [/^nature water/, 205],
		[/^nature cardiovascular/, 10], [/^nature mental health/, 330], [/^nature protocols/, 100],
		[/^nature reviews/, 175], [/^scientific reports/, 160], [/^npj\b/, 165], [/^communications /, 180]
	];
	function natureHue(title) {
		const key = flat(title);
		const hit = NATURE_TITLES.find(([test]) => test.test(key));
		return hit ? hit[1] : 168;
	}

	const FAMILIES = [
		{ key: "nature", label: "Nature", mark: "N", hue: 168, test: /^nature$/ },
		{ key: "nature-portfolio", label: "Nature Portfolio", hue: natureHue,
			test: /^(nature|npj|scientific reports|communications (biology|chemistry|physics|materials|earth|engineering|medicine))\b/,
			mark: title => monogram(title, "N") },
		{ key: "science", label: "Science", mark: "S", hue: 358, test: /^science$/ },
		{ key: "aaas", label: "AAAS", hue: 358, test: /^science\b(advances|immunology|robotics|signaling|translational)?/,
			mark: title => monogram(title, "S") },
		{ key: "pnas", label: "PNAS", mark: "PN", hue: 220, test: /^proceedings of the national academy|^pnas\b/ },
		{ key: "cell-press", label: "Cell Press", hue: 200,
			test: /^(cell|molecular cell|developmental cell|cancer cell|immunity|neuron|chem|joule|matter|one earth|med|current biology|structure|trends in)\b/,
			mark: title => monogram(title, "C") },
		{ key: "oxford", label: "Oxford", hue: 232,
			test: /^(nucleic acids research|bioinformatics|briefings in|nar |database|molecular biology and evolution|fems )/,
			mark: title => monogram(title, "O") },
		{ key: "asm", label: "ASM", hue: 190,
			test: /^(applied and environmental microbiology|journal of bacteriology|mbio|msystems|msphere|mmbr|microbiology and molecular biology reviews|antimicrobial agents|journal of virology|infection and immunity|journal of clinical microbiology)\b/,
			mark: title => monogram(title, "A") },
		{ key: "acs", label: "ACS", hue: 208,
			test: /^(acs |journal of the american chemical society|analytical chemistry|biochemistry$|journal of agricultural and food chemistry|environmental science and technology)/,
			mark: title => monogram(title, "ACS") },
		{ key: "rsc", label: "RSC", hue: 344,
			test: /^(chemical (science|communications|society reviews)|green chemistry|soft matter|lab on a chip|analyst$)/,
			mark: title => monogram(title, "RSC") },
		{ key: "embo", label: "EMBO", hue: 12, test: /^(the )?embo |^molecular systems biology/, mark: title => monogram(title, "EM") },
		{ key: "elife", label: "eLife", mark: "eL", hue: 24, test: /^elife/ },
		{ key: "plos", label: "PLOS", hue: 32, test: /^plos\b|^plo s\b/, mark: title => monogram(title, "PL") },
		{ key: "frontiers", label: "Frontiers", hue: 152, test: /^frontiers in\b/, mark: title => monogram(title, "F") },
		{ key: "mdpi", label: "MDPI", hue: 140,
			test: /^(ijms|international journal of molecular sciences|microorganisms|biomolecules|catalysts|polymers|molecules|foods|sensors|cells)$/,
			mark: title => monogram(title, "M") },
		{ key: "elsevier", label: "Elsevier", hue: 28,
			test: /^(metabolic engineering|journal of (molecular biology|biological chemistry|biotechnology)|bioresource technology|biotechnology advances|enzyme and microbial|process biochemistry|food chemistry|international journal of biological macromolecules|current opinion in|methods in enzymology|biochimica et biophysica)/,
			mark: title => monogram(title, "E") },
		{ key: "springer", label: "Springer", hue: 214,
			test: /^(applied microbiology and biotechnology|extremophiles|archives of microbiology|world journal of microbiology|biotechnology letters|journal of industrial microbiology|amb express|microbial cell factories|biotechnology for biofuels|bmc )/,
			mark: title => monogram(title, "Sp") },
		{ key: "wiley", label: "Wiley", hue: 246,
			test: /^(biotechnology and bioengineering|molecular microbiology|environmental microbiology|microbial biotechnology|febs |protein science|angewandte|advanced science|chembiochem)/,
			mark: title => monogram(title, "W") }
	];

	/* The publisher as the APIs name it. A title the patterns above do not know is
	   still placed when its record says "Elsevier BV" or "Springer Science and
	   Business Media LLC". Tested after the title rules, so Cell Press keeps its
	   blue even though Elsevier owns it. */
	const PUBLISHERS = [
		{ test: /nature|springer nature/, family: "nature-portfolio" },
		{ test: /american association for the advancement of science|\baaas\b/, family: "aaas" },
		{ test: /national academy of sciences/, family: "pnas" },
		{ test: /cell press/, family: "cell-press" },
		{ test: /oxford university press|\boup\b/, family: "oxford" },
		{ test: /american society for microbiology/, family: "asm" },
		{ test: /american chemical society/, family: "acs" },
		{ test: /royal society of chemistry/, family: "rsc" },
		{ test: /embo press/, family: "embo" },
		{ test: /elife sciences/, family: "elife" },
		{ test: /public library of science/, family: "plos" },
		{ test: /frontiers media/, family: "frontiers" },
		{ test: /\bmdpi\b/, family: "mdpi" },
		{ test: /elsevier/, family: "elsevier" },
		{ test: /springer|biomed central|\bbmc\b/, family: "springer" },
		{ test: /wiley/, family: "wiley" }
	];

	// An initialism from the words that carry meaning, so an unknown journal still
	// gets a mark that means something: "Journal of Molecular Biology" -> JMB.
	const SKIP = new Set(["the", "of", "and", "in", "for", "on", "a", "an", "at", "to", "de", "der"]);
	function monogram(title, fallback) {
		let words = flat(title).split(" ").filter(word => word && !SKIP.has(word));
		if (!words.length) return fallback || "?";
		if (words.length === 1) {
			// A one-word title keeps up to four letters: "Cell" is the mark, "Ce" is not.
			let one = words[0];
			return (one.length <= 4 ? one : one.slice(0, 3)).replace(/^./, c => c.toUpperCase());
		}
		let letters = words.slice(0, 3).map(word => word[0].toUpperCase()).join("");
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
		let value = flat(title);
		let hash = 0;
		for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
		return hash % 360;
	}

	// The mark is the journal's standard abbreviation; the monogram only stands in
	// when even that comes back empty.
	function fromFamily(family, name) {
		return {
			family: family.key, label: family.label,
			hue: typeof family.hue === "function" ? family.hue(name) : family.hue,
			mark: abbreviate(name) || (typeof family.mark === "function" ? family.mark(name) : family.mark),
			known: true
		};
	}

	function identify(title, publisher) {
		let name = text(title);
		if (!name) return null;
		let key = flat(name);
		for (let family of FAMILIES) if (family.test.test(key)) return fromFamily(family, name);
		let house = flat(publisher);
		if (house) {
			let hit = PUBLISHERS.find(p => p.test.test(house));
			let family = hit && FAMILIES.find(f => f.key === hit.family);
			if (family) return fromFamily(family, name);
		}
		return { family: "other", label: "", hue: derivedHue(name), mark: abbreviate(name) || monogram(name), known: false };
	}

	// The mark's ink and its fill, from one hue so every tile in the column is built
	// the same way. A curated family sits a little stronger than a derived one.
	const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
	function colours(identity, { dark = false } = {}) {
		let hue = identity?.hue ?? 0;
		let known = Boolean(identity?.known);
		return dark
			? { ink: hsl(hue, known ? 46 : 26, 72), fill: hsl(hue, known ? 34 : 18, 24), edge: hsl(hue, known ? 34 : 18, 34) }
			: { ink: hsl(hue, known ? 42 : 22, 38), fill: hsl(hue, known ? 46 : 26, 94), edge: hsl(hue, known ? 40 : 22, 86) };
	}

	return { identify, colours, monogram, abbreviate, derivedHue, natureHue, FAMILIES, PUBLISHERS, NATURE_TITLES, ABBREVIATIONS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJournalMarks;
