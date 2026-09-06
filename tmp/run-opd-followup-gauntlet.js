/**
 * OPD review-followup-only gauntlet. Does not call extract.
 */
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const axios = require("axios");

const OUT_DIR = __dirname + "/opd-ai-gauntlet";
const URL = "http://localhost:3001/api/discharge-summary/review-followup";
const REQUESTS_PER_MIN = 12;
const MIN_INTERVAL_MS = Math.ceil(60000 / REQUESTS_PER_MIN);

const VITALS = {
  weight: "70",
  height: "166",
  temperature: "98.6",
  spo2: "98",
  heartRate: "72",
  respiratoryRate: "16",
  bloodPressure: "120/80",
};

const empty = (notes = "") => ({
  medicines: [],
  labTests: [],
  procedures: [],
  doctorNotes: notes,
  vitals: { ...VITALS },
});

const med = (name, extra = {}) => ({
  name,
  type: "Tablet",
  duration: "5 days",
  directions: "",
  dosages: [
    { time: "Morning", amount: 1, unit: "", beforeFood: false },
    { time: "Evening", amount: 1, unit: "", beforeFood: false },
  ],
  ...extra,
});

const CHART_UTI = empty("Diagnosis:\n• Urinary tract infection");
const CHART_RA = empty("Diagnosis:\n• Rheumatoid arthritis");
const CHART_MEDS = {
  medicines: [med("Dolo 650"), med("Pantop 40")],
  labTests: [],
  procedures: [],
  doctorNotes: "Diagnosis:\n• Viral fever",
  vitals: { ...VITALS },
};
const CHART_MEDS_CBP = {
  ...CHART_MEDS,
  labTests: ["CBP (Complete blood picture)"],
};
const CHART_MALARIA = {
  medicines: [],
  labTests: [
    "MP (Malaria parasite)",
    "PV (Plasmodium vivax)",
    "PF (Plasmodium falciparum)",
  ],
  procedures: [],
  doctorNotes: "Diagnosis:\n• Malaria",
  vitals: { ...VITALS },
};

const CASES = [
  {
    id: "1",
    instruction: "uti, add mp, pv, pf, gabapin me 100 hs",
    chart: empty(),
  },
  {
    id: "2",
    instruction:
      "c/o burning micturition 3d likely uti add cbp cue rbs nitrofurantoin 100 bd 5d",
    chart: empty(),
  },
  {
    id: "3",
    instruction: "fever 5d, mp pv pf, pcm 650 tid, if mp+ start artesunate",
    chart: empty(),
  },
  {
    id: "4",
    instruction: "add dolo 650 bd, cbp lft, cough 3 days, no syp",
    chart: empty(),
  },
  { id: "5", instruction: "gabapin me, mp, uti", chart: empty() },
  { id: "6", instruction: "add mp pv pf", chart: CHART_UTI },
  { id: "7", instruction: "cough", chart: empty() },
  { id: "8a", instruction: "viral fever", chart: empty() },
  { id: "8b", instruction: "fever 3d", chart: empty() },
  { id: "9a", instruction: "gibapin me", chart: empty() },
  { id: "9b", instruction: "gabapin me", chart: empty() },
  { id: "9c", instruction: "gabapin me 300", chart: empty() },
  { id: "10", instruction: "pan 40", chart: empty() },
  { id: "11", instruction: "pcm 650 bd", chart: empty() },
  { id: "12", instruction: "telma am h 40", chart: empty() },
  {
    id: "13",
    instruction: "wysolone 40 then 20 then 10 bd 3d each",
    chart: empty(),
  },
  { id: "14", instruction: "hctz 12.5", chart: empty() },
  { id: "15", instruction: "azithro 500 od 3d", chart: empty() },
  { id: "16", instruction: "NS 1 pint 100ml/hr", chart: empty() },
  { id: "17", instruction: "lali b inj stat", chart: empty() },
  { id: "18", instruction: "add tsh ft3 ft4", chart: empty() },
  { id: "19", instruction: "hbsag anti hcv hiv", chart: empty() },
  { id: "20a", instruction: "usg abd", chart: empty() },
  { id: "20b", instruction: "cxr pa", chart: empty() },
  { id: "21a", instruction: "ps for mp", chart: empty() },
  { id: "21b", instruction: "mp pv pf", chart: empty() },
  { id: "22a", instruction: "aec", chart: empty() },
  { id: "22b", instruction: "ace", chart: empty() },
  { id: "23", instruction: "crp", chart: empty() },
  { id: "24", instruction: "add ra factor ana", chart: CHART_RA },
  {
    id: "25",
    instruction: "c/o headache vomiting photophobia",
    chart: empty(),
  },
  { id: "26", instruction: "migraine", chart: empty() },
  { id: "27", instruction: "c/o headache, migraine", chart: empty() },
  { id: "28", instruction: "k/c/o dm t2, now polyuria", chart: empty() },
  { id: "29", instruction: "advise rest hydration review 5d", chart: empty() },
  {
    id: "30",
    instruction: "o/e throat congested, no lymphadenopathy",
    chart: empty(),
  },
  { id: "31", instruction: "dd viral vs strep", chart: empty() },
  { id: "32", instruction: "dolo650 bd5d pcm sos", chart: empty() },
  { id: "33", instruction: "tab.dolo,syp.ascoril,cbp", chart: empty() },
  {
    id: "34",
    instruction: "pt c/o cough n cold.. add azithro n cbp",
    chart: empty(),
  },
  { id: "35", instruction: "GABAPIN-ME 100 HS 10D", chart: empty() },
  { id: "36", instruction: "mp+pv+pf", chart: empty() },
  { id: "37", instruction: "uti?? add nitro 100bd n cue", chart: empty() },
  {
    id: "38",
    instruction: "febrile, ?malaria , mp pv pf , pcm tds",
    chart: empty(),
  },
  { id: "39", instruction: "bukhar 3 din, cbp, dolo bd", chart: empty() },
  {
    id: "40",
    instruction: "wysolone 40mg/30/20/10 bd 2d each",
    chart: empty(),
  },
  { id: "41", instruction: "insulin 10 morning 15 evening", chart: empty() },
  { id: "42", instruction: "dolo 650 bd", chart: empty() },
  { id: "43", instruction: "pcm 650 tid", chart: empty() },
  { id: "44", instruction: "gabapin me hs", chart: empty() },
  { id: "45", instruction: "pcm 650 sos fever", chart: empty() },
  { id: "46", instruction: "pcm od 5d then stop", chart: empty() },
  {
    id: "47",
    instruction: "denv ns1 igm, plat count, pcm, no nsaids",
    chart: empty(),
  },
  {
    id: "48",
    instruction: "enteric fever, blood c/s, cefixime 200 bd",
    chart: empty(),
  },
  {
    id: "49",
    instruction: "g2p1, 32w, leaking pv, nfhs, inj betnesol 12mg 2 doses",
    chart: empty(),
  },
  {
    id: "50",
    instruction: "menorrhagia 6m, usg pelvis, primolut n",
    chart: empty(),
  },
  {
    id: "51",
    instruction: "6mo, loose stools 8 times, zinc 20 od 14d, ors, stool r/e",
    chart: empty(),
  },
  { id: "52", instruction: "wheeze, neb duolin x 3, no tab", chart: empty() },
  {
    id: "53",
    instruction:
      "twisted ankle, xray ap lat, rest, no wt bearing, diclo 50 bd sos",
    chart: empty(),
  },
  { id: "54", instruction: "oa knee, physio, not a medicine", chart: empty() },
  { id: "55", instruction: "wax, syringing, not a tablet", chart: empty() },
  { id: "56", instruction: "aso, throat swab, azithro", chart: empty() },
  {
    id: "57",
    instruction: "red eye, moxi drops 1-1-1, no systemic",
    chart: empty(),
  },
  { id: "58", instruction: "iop, fundus, not labs-as-meds", chart: empty() },
  {
    id: "59",
    instruction: "tinea cruris, itra 100 bd 7d, koh",
    chart: empty(),
  },
  { id: "60", instruction: "betnovate", chart: empty() },
  {
    id: "61",
    instruction: "insomnia, gabapin me hs, no diagnosis unless named",
    chart: empty(),
  },
  { id: "62", instruction: "low mood 2w", chart: empty() },
  {
    id: "63",
    instruction: "chest pain, trop i, ecg, asprin 75",
    chart: empty(),
  },
  { id: "64", instruction: "cva, ct brain, ecosprin gold", chart: empty() },
  { id: "65", instruction: "seizure, eeg, levipil 500 bd", chart: empty() },
  { id: "66", instruction: "ckd, kft, no nsaids, nodosis", chart: empty() },
  {
    id: "67",
    instruction: "stone, kub, drotin, plenty fluids",
    chart: empty(),
  },
  { id: "68", instruction: "pain abd, usg, pantop 40 od bbf", chart: empty() },
  {
    id: "69",
    instruction: "ugib, npo, ppi inf, not 5d default if IV",
    chart: empty(),
  },
  {
    id: "70",
    instruction: "sob, spo2, cxr, duolin neb, deriphyllin",
    chart: empty(),
  },
  { id: "71", instruction: "sputum afb x 2", chart: empty() },
  { id: "72", instruction: "anemia, cbp p/s, iron profile", chart: empty() },
  { id: "73", instruction: "fnac", chart: empty() },
  { id: "74", instruction: "add", chart: empty() },
  { id: "75", instruction: "same as last time", chart: empty() },
  { id: "76a", instruction: "stop all", chart: CHART_MEDS_CBP },
  { id: "76b", instruction: "stop dolo", chart: CHART_MEDS },
  {
    id: "77",
    instruction: "replace pantop with rabeprazole 20",
    chart: CHART_MEDS,
  },
  { id: "78", instruction: "continue everything add cbp", chart: CHART_MEDS },
  { id: "79", instruction: "not malaria", chart: CHART_MALARIA },
  { id: "80", instruction: "maybe uti", chart: empty() },
  {
    id: "81",
    instruction:
      "k/c/o htn dm, c/o fever chills 4d, o/e febrile, ?malaria, mp pv pf, cbp, pcm 650 tds, doxy 100 bd, gabapin me hs, review 3d if fever persists, no cipro",
    chart: empty(),
  },
  {
    id: "82",
    instruction:
      "post lscs day 3, wound soak, dressing, not inj unless named, cbp",
    chart: empty(),
  },
  {
    id: "83",
    instruction: "child 2y, barking cough, steam, no codeine, xray if stridor",
    chart: empty(),
  },
  {
    id: "84",
    instruction: "add mp, pv, pf, uti, gabapin me, dolo, cbp",
    chart: empty(),
  },
  {
    id: "85",
    instruction:
      "k/c/o t2dm, c/o burning micturition n fever 3d, ?uti ?malaria, o/e temp 101, add mp pv pf cue cbp, nitrofurantoin 100 bd 5d, pcm 650 tds sos, gabapin me 100 hs, pantop 40 od bbf, review 5d, plenty fluids, no nsaid",
    chart: empty(),
  },

  // --- tough mixed notes, all specialties ---
  {
    id: "86",
    instruction:
      "k/c/o cad on ecosprin gold, c/o chest pain 2h radiating left arm, o/e sweaty, trop i, ecg, asprin 325 stat, telma am h 40 od, if trop+ admit, no nsaid",
    chart: empty(),
  },
  {
    id: "87",
    instruction:
      "c/o gtcs 1 episode, k/c/o epilepsy on levipil, eeg, ct brain if focal, gabapin me hs, no phenytoin, review neuro",
    chart: empty(),
  },
  {
    id: "88",
    instruction:
      "k/c/o copd, c/o fever cough 5d, o/e wheeze, sputum afb x2, cxr, duolin neb, deriphyllin, aec, if stridor xray neck, no codeine",
    chart: empty(),
  },
  {
    id: "89",
    instruction:
      "c/o malena 1d, k/c/o pud on pan 40, o/e pallor, npo, ppi inf, cbp lft, usg abd, no nsaids, if hb<7 transfuse",
    chart: empty(),
  },
  {
    id: "90",
    instruction:
      "k/c/o ckd on nodosis, c/o loin pain, usg kub, kft, drotin 40 sos, plenty fluids, no nsaids, no acei, if creat>3 refer nephro",
    chart: empty(),
  },
  {
    id: "91",
    instruction:
      "k/c/o t2dm on metformin, c/o polyuria, hba1c, fbs, lantus 10iu m 15iu e 3d, no new metformin, review endo",
    chart: empty(),
  },
  {
    id: "92",
    instruction:
      "k/c/o ra, c/o joint pain, ra factor ana, mtx 15mg weekly 8w, folic od, wysolone 20 bd 5d then 10 3d then 5 3d, no nsaid if pud",
    chart: empty(),
  },
  {
    id: "93",
    instruction:
      "tinea cruris groin, koh, itra 100 bd 7d, betnovate od 5d, no oral steroid, if no response punch bx",
    chart: empty(),
  },
  {
    id: "94",
    instruction:
      "c/o red eye, o/e iop fundus, refresh tears 2 drops tds 7d, moxi drops 1-1-1, no systemic abx, review ophtho if photophobia",
    chart: empty(),
  },
  {
    id: "95",
    instruction:
      "c/o ear pain, wax, syringing not a tablet, aso, throat swab, azithro 500 od 3d then stop, no ototoxic drops",
    chart: empty(),
  },
  {
    id: "96",
    instruction:
      "6mo, loose stools 8 times, zinc 20 od 14d, ors, stool r/e, no loperamide, if blood in stool stool c/s",
    chart: empty(),
  },
  {
    id: "97",
    instruction:
      "g2p1 32w leaking pv 2h, nfhs, inj betnesol 12mg 2 doses, usg obs, if labour pains admit, no tocolysis unless named",
    chart: empty(),
  },
  {
    id: "98",
    instruction:
      "oa knee, xray ap lat if swelling, physio not a medicine, diclo 50 bd sos max 3/d, no steroid inj unless named",
    chart: empty(),
  },
  {
    id: "99",
    instruction:
      "c/o insomnia 2w low mood, gabapin me hs, no diagnosis unless named, no ssri, review psych if suicidal",
    chart: empty(),
  },
  {
    id: "100",
    instruction:
      "anemia, cbp p/s iron profile, fnac breast lump if palpable, no iron inj unless named, b12 if vegan",
    chart: empty(),
  },
  {
    id: "101",
    instruction:
      "fever 4d myalgia, ?dengue ?enteric, denv ns1 igm, plat, blood c/s, pcm 650 tds, no nsaids, if mp+ artesunate not now",
    chart: empty(),
  },
  {
    id: "102",
    instruction:
      "fever cough 3d, k/c/o dm on metformin, o/e chest clear, pantop 40 od bbf 5d, dolo 650 sos max 3/day, azithro 500 od 3d then stop, wysolone 20 bd 5d then 10 3d then 5 3d, lantus 3d m 10iu af 15iu, mtx 15mg weekly 8 weeks, refresh tears 2 drops tds 7d, t-bact bd 5d, advise cbp lft review 5d",
    chart: empty(),
  },
  {
    id: "103",
    instruction: "elaborate the notes",
    chart: empty(
      "Complaints:\n• fever 3d, cough\nHistory:\n• k/c/o DM on metformin\nExamination:\n• chest clear\nAdvice:\n• review 5d",
    ),
  },
  {
    id: "104",
    instruction: "rewrite the notes as short bullet points under each heading",
    chart: empty(
      "Complaints: Fever present for 3 days with cough. History: Known DM on metformin. Examination: Chest clear. Advice: Review after 5 days.",
    ),
  },
  {
    id: "105",
    instruction:
      "k/c/o htn dm, lipid profile, hba1c, telma am h 40, ecosprin gold, no new statin unless named, review 3m",
    chart: empty(),
  },
  {
    id: "106",
    instruction:
      "uti?? add nitro 100bd n cue n cbp, if culture + switch abx, no cipro, gabapin me hs",
    chart: empty(),
  },
  {
    id: "107",
    instruction:
      "hbsag anti hcv hiv, lft, no invent hepatitis dx, pan 40 od bbf",
    chart: empty(),
  },
  {
    id: "108",
    instruction:
      "child 2y barking cough 1d, steam, no codeine, no syp unless named, xray if stridor, pcm 125 sos",
    chart: empty(),
  },
  {
    id: "109",
    instruction:
      "menorrhagia 6m, usg pelvis, tsh, primolut n, if hb<8 admit, no estrogen unless named",
    chart: empty(),
  },
  {
    id: "110",
    instruction:
      "c/o allergy sneezing, aec, no ace, montair lc hs, if wheeze neb duolin",
    chart: empty(),
  },
  {
    id: "111",
    instruction:
      "post lscs d3, wound soak dressing not inj, cbp, pcm 650 tds, if pus swab c/s, no nsaid",
    chart: empty(),
  },
  {
    id: "112",
    instruction:
      "stone, mp pv pf, uti, drotin, cue, plenty fluids, pv is vivax not venous, nitro only if cue+",
    chart: empty(),
  },
];

function labNames(body) {
  return (body.labTests || [])
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter(Boolean);
}
function medNames(body) {
  return (body.medicines || []).map((m) => m?.name || "").filter(Boolean);
}
function procNames(body) {
  return (body.procedures || [])
    .map((p) => (typeof p === "string" ? p : p?.name || ""))
    .filter(Boolean);
}
function slotsOf(m) {
  return (
    (m.dosages || [])
      .map((d) => d.time)
      .filter(Boolean)
      .join("+") || "-"
  );
}
function notesFlat(body) {
  return String(body.doctorNotes || "").replace(/\n/g, " | ");
}
function hasNoteSection(notes, section) {
  return new RegExp(`^${section}\\s*:`, "im").test(notes || "");
}
function blob(body) {
  return JSON.stringify(body || {}).toLowerCase();
}

function judge(c, body, status) {
  const issues = [];
  if (status !== 200) {
    issues.push(`HTTP ${status}`);
    return issues;
  }
  const notes = String(body.doctorNotes || "");
  const meds = medNames(body);
  const labs = labNames(body);
  const procs = procNames(body);
  const medsL = meds.join(" | ").toLowerCase();
  const labsL = labs.join(" | ").toLowerCase();
  const procsL = procs.join(" | ").toLowerCase();
  const notesL = notes.toLowerCase();
  const all = blob(body);
  const id = c.id;

  const expectMed = (re, label) => {
    if (!medsL.match(re)) issues.push(`missing med ${label}`);
  };
  const expectLab = (re, label) => {
    if (!labsL.match(re)) issues.push(`missing lab ${label}`);
  };
  const expectNote = (re, label) => {
    if (!notesL.match(re)) issues.push(`missing note ${label}`);
  };
  const noMed = (re, label) => {
    if (medsL.match(re))
      issues.push(`unwanted med ${label}: ${meds.join(" | ")}`);
  };
  const noLab = (re, label) => {
    if (labsL.match(re))
      issues.push(`unwanted lab ${label}: ${labs.join(" | ")}`);
  };
  const noInventedNotes = () => {
    if (
      notes.trim() &&
      /none|n\/a/.test(notesL) === false &&
      notes.trim().length > 0
    ) {
      // caller decides
    }
  };

  if (id === "1") {
    expectNote(/urinary|uti/, "UTI dx");
    expectLab(/malaria|mp/, "MP");
    expectLab(/vivax|pv/, "PV");
    expectLab(/falciparum|pf/, "PF");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    noMed(/uti|mp|pv|pf|malaria/, "labs/dx as med");
    noLab(/urine|uti|cue/, "urine from UTI");
  }
  if (id === "2") {
    expectNote(/burning|micturition/, "complaint");
    expectNote(/urinary|uti/, "UTI");
    expectLab(/blood|cbp|complete/, "CBP");
    expectLab(/urine|cue/, "CUE");
    expectLab(/sugar|rbs|glucose/, "RBS");
    expectMed(/nitro/, "nitrofurantoin");
  }
  if (id === "3") {
    expectNote(/fever/, "fever");
    expectLab(/malaria|mp/, "MP");
    expectMed(/pcm|paracetamol/, "pcm");
    noMed(/artesunate/, "conditional artesunate should be advice");
    if (
      !/artesunate/.test(notesL) &&
      !/artesunate/.test(String(body.assistantReply || "").toLowerCase())
    ) {
      // advice may be in notes
      if (!/artesunate/.test(all)) issues.push("missing artesunate as advice");
    }
  }
  if (id === "4") {
    expectMed(/dolo/, "Dolo");
    expectLab(/cbp|blood|complete/, "CBP");
    expectLab(/lft|liver/, "LFT");
    expectNote(/cough/, "cough");
    noMed(/syp|syrup/, "no syrup");
    if (!/syrup|syp/.test(notesL)) issues.push("missing no-syrup advice");
  }
  if (id === "5") {
    expectMed(/gabapin\s*me/, "Gabapin ME");
    expectLab(/malaria|mp/, "MP");
    expectNote(/urinary|uti/, "UTI");
    noLab(/urine|uti|cue/, "UTI must not be a lab");
    noMed(/uti|mp/, "dx/lab as med");
  }
  if (id === "6") {
    expectLab(/malaria|mp/, "MP");
    expectLab(/vivax|pv/, "PV");
    expectLab(/falciparum|pf/, "PF");
    noLab(/urine|cue|pus/, "must not remap to urine");
    expectNote(/urinary|uti/, "keep UTI");
    if (meds.length) issues.push(`should not add meds: ${meds.join(" | ")}`);
  }
  if (id === "7") {
    expectNote(/cough/, "cough complaint");
    if (hasNoteSection(notes, "Diagnosis"))
      issues.push("cough should not invent diagnosis");
    if (meds.length)
      issues.push(`no meds for cough alone: ${meds.join(" | ")}`);
  }
  if (id === "8a") {
    expectNote(/viral/, "viral fever dx");
    if (
      hasNoteSection(notes, "Complaints") &&
      /viral fever/.test(notesL) &&
      !/fever/.test(notes.split(/Diagnosis/i)[0] || "")
    ) {
      // ok if complaints empty
    }
    if (meds.length) issues.push("no meds");
  }
  if (id === "8b") {
    expectNote(/fever/, "fever complaint");
    if (hasNoteSection(notes, "Diagnosis"))
      issues.push("fever 3d should not invent diagnosis");
  }
  if (id === "9a" || id === "9b") {
    expectMed(/gabapin\s*me|gibapin\s*me/, "Gabapin ME suffix");
    if (
      notes.trim() &&
      !/empty|none/.test(notesL) &&
      /complaint|diagnosis/i.test(notes)
    ) {
      issues.push("medicine-only should not invent notes");
    }
  }
  if (id === "9c") {
    expectMed(/gabapin\s*me\s*300/, "Gabapin ME 300");
  }
  if (id === "10") {
    expectMed(/^pan\s*40$|pan 40/, "Pan 40 brand");
    noMed(/pantoprazole/, "must not rewrite Pan→Pantoprazole");
  }
  if (id === "11") {
    expectMed(/pcm|paracetamol/, "pcm");
    const m = (body.medicines || [])[0];
    const slots = slotsOf(m);
    if (m && !/Evening/.test(slots))
      issues.push(`bd should be Evening not ${slots}`);
  }
  if (id === "12") {
    expectMed(/telma.*am.*h.*40/, "Telma AM H 40");
  }
  if (id === "13") {
    if (meds.length < 3)
      issues.push(
        `taper should be 3 rows, got ${meds.length}: ${meds.join(" | ")}`,
      );
  }
  if (id === "14") {
    expectMed(/hctz|hydrochlorothiazide/, "HCTZ");
  }
  if (id === "15") {
    expectMed(/azithro/, "azithro");
  }
  if (id === "16") {
    if (!medsL.match(/ns|saline|normal/) && !procsL.match(/ns|saline/)) {
      issues.push("missing NS fluid");
    }
    const dur = (body.medicines || []).map((m) => m.duration).join(" ");
    if (/5\s*day/i.test(dur)) issues.push(`IV defaulted to 5 days: ${dur}`);
  }
  if (id === "17") {
    expectMed(/lali/, "Lali B");
  }
  if (id === "18") {
    if (labs.length < 3)
      issues.push(`need 3 thyroid labs, got ${labs.join(" | ")}`);
    if (meds.length) issues.push(`thyroid codes as meds: ${meds.join(" | ")}`);
  }
  if (id === "19") {
    if (labs.length < 3)
      issues.push(`need HBsAg/HCV/HIV, got ${labs.join(" | ")}`);
    if (meds.length) issues.push("serology as meds");
  }
  if (id === "20a") expectLab(/usg|ultrasound|abdomen/, "USG");
  if (id === "20b") expectLab(/x-?ray|cxr|chest/, "CXR");
  if (id === "21a") expectLab(/smear|ps|malaria|mp/, "PS for MP");
  if (id === "21b") {
    expectLab(/malaria|mp/, "MP");
    expectLab(/vivax|pv/, "PV");
    expectLab(/falciparum|pf/, "PF");
  }
  if (id === "22a") {
    expectLab(/aec|eosinophil/, "AEC lab");
    noMed(/aec/, "AEC as med");
  }
  if (id === "22b") {
    if (!labs.length && !meds.length && !notes.trim())
      issues.push("ACE dropped entirely");
  }
  if (id === "23") {
    expectLab(/crp|c-reactive/, "CRP");
    noMed(/crp/, "CRP as med");
  }
  if (id === "24") {
    expectLab(/ra|rheumatoid/, "RA factor");
    expectLab(/ana|antinuclear/, "ANA");
    expectNote(/rheumatoid|ra/, "keep RA dx");
    if (labs.length > 4)
      issues.push(`invented extra rheum panel: ${labs.join(" | ")}`);
  }
  if (id === "25") {
    expectNote(/headache/, "headache");
    if (hasNoteSection(notes, "Diagnosis"))
      issues.push("symptoms should not invent dx");
  }
  if (id === "26") {
    expectNote(/migraine/, "migraine dx");
    if (
      hasNoteSection(notes, "Complaints") &&
      /migraine/.test((notes.split(/Diagnosis/i)[0] || "").toLowerCase()) &&
      !/headache/.test(notesL)
    ) {
      issues.push("migraine as complaint instead of diagnosis");
    }
  }
  if (id === "27") {
    expectNote(/headache/, "headache");
    expectNote(/migraine/, "migraine");
  }
  if (id === "28") {
    expectNote(/polyuria/, "polyuria");
    expectNote(/diabetes|dm|t2/, "k/c/o DM");
    if (
      !hasNoteSection(notes, "History") &&
      !/known|history|k\/c/i.test(notes)
    ) {
      issues.push("k/c/o should be History not only Diagnosis");
    }
  }
  if (id === "29") {
    if (
      !hasNoteSection(notes, "Advice") &&
      !/rest|hydration|review/.test(notesL)
    ) {
      issues.push("missing Advice");
    }
    if (meds.length) issues.push("advice became meds");
  }
  if (id === "30") {
    if (!hasNoteSection(notes, "Examination") && !/throat|lymph/.test(notesL)) {
      issues.push("missing Examination");
    }
  }
  if (id === "31") {
    expectNote(/viral|strep/, "DD");
  }
  if (id === "32") {
    expectMed(/dolo/, "Dolo");
    expectMed(/pcm|paracetamol/, "pcm");
  }
  if (id === "33") {
    expectMed(/dolo/, "Dolo");
    expectMed(/ascoril/, "Ascoril");
    expectLab(/cbp|blood|complete/, "CBP");
  }
  if (id === "34") {
    expectNote(/cough|cold/, "complaint");
    expectMed(/azithro/, "azithro");
    expectLab(/cbp|blood|complete/, "CBP");
  }
  if (id === "35") {
    expectMed(/gabapin.*me.*100/, "GABAPIN-ME 100");
  }
  if (id === "36") {
    expectLab(/malaria|mp/, "MP");
    expectLab(/vivax|pv/, "PV");
    expectLab(/falciparum|pf/, "PF");
  }
  if (id === "37") {
    expectNote(/urinary|uti/, "UTI");
    expectMed(/nitro/, "nitro");
    expectLab(/cue|urine/, "CUE");
  }
  if (id === "38") {
    expectLab(/malaria|mp/, "MP");
    expectMed(/pcm|paracetamol/, "pcm");
  }
  if (id === "39") {
    expectNote(/fever|bukhar/, "fever");
    expectLab(/cbp|blood|complete/, "CBP");
    expectMed(/dolo/, "Dolo");
  }
  if (id === "40") {
    if (meds.length < 4)
      issues.push(`taper 4 rows, got ${meds.length}: ${meds.join(" | ")}`);
  }
  if (id === "41") {
    expectMed(/insulin/, "insulin");
    const ins = (body.medicines || []).find((m) =>
      /insulin/i.test(m.name || ""),
    );
    const amts = (ins?.dosages || []).map((d) => d.amount);
    if (ins && !(amts.includes(10) && amts.includes(15))) {
      issues.push(
        `insulin amounts ${amts.join(",") || "missing"} want 10 and 15`,
      );
    }
  }
  if (id === "42") {
    expectMed(/dolo/, "Dolo");
    const m = (body.medicines || []).find((x) => /dolo/i.test(x.name || ""));
    if (m && !/Evening/.test(slotsOf(m)))
      issues.push(`bd Evening, got ${slotsOf(m)}`);
  }
  if (id === "43") {
    const m = (body.medicines || [])[0];
    if (m && /Night/.test(slotsOf(m)) && !/Evening/.test(slotsOf(m))) {
      issues.push(`tid used Night not Evening: ${slotsOf(m)}`);
    }
  }
  if (id === "44") {
    expectMed(/gabapin\s*me/, "Gabapin ME");
    const m = (body.medicines || [])[0];
    if (m && !/Night/.test(slotsOf(m)))
      issues.push(`hs should be Night, got ${slotsOf(m)}`);
  }
  if (id === "45") {
    expectMed(/pcm|paracetamol/, "pcm");
    expectNote(/fever/, "fever");
  }
  if (id === "46") {
    expectMed(/pcm|paracetamol/, "pcm");
    if ((body.medicines || []).some((m) => /stop/i.test(m.action || ""))) {
      issues.push("then stop should not be action=stop on add");
    }
  }
  if (id === "47") {
    expectLab(/dengue|ns1|denv/, "dengue");
    expectLab(/plat|platelet/, "platelets");
    expectMed(/pcm|paracetamol/, "pcm");
    if (!/nsaid/.test(notesL)) issues.push("missing no NSAIDs advice");
  }
  if (id === "48") {
    expectNote(/enteric|typhoid/, "enteric");
    expectLab(/culture|c\/s|blood/, "blood C/S");
    expectMed(/cefixime/, "cefixime");
  }
  if (id === "49") {
    expectMed(/betnesol/, "Betnesol");
    expectNote(/leak/, "leaking PV");
  }
  if (id === "50") {
    expectNote(/menorrhagia/, "menorrhagia");
    expectLab(/usg|ultrasound|pelvis/, "USG");
    expectMed(/primolut/, "Primolut N");
  }
  if (id === "51") {
    expectMed(/zinc/, "zinc");
    expectMed(/ors/, "ORS");
    expectLab(/stool/, "stool RE");
  }
  if (id === "52") {
    expectNote(/wheez/, "wheeze");
    if (!medsL.match(/duolin/) && !procsL.match(/duolin|nebul/)) {
      issues.push("missing Duolin neb");
    }
    noMed(/^(tab|tablet)$/i, "no tab");
  }
  if (id === "53") {
    expectNote(/ankle|twist/, "ankle");
    expectLab(/x-?ray|ap|lat/, "xray");
    expectMed(/diclo/, "diclo");
  }
  if (id === "54") {
    expectNote(/osteo|oa|knee/, "OA");
    noMed(/physio/, "physio as med");
    if (!procsL.match(/physio/) && !/physio/.test(notesL))
      issues.push("physio missing");
  }
  if (id === "55") {
    noMed(/wax|syring/, "wax as tablet");
    if (!procsL.match(/syring|wax/) && !/syring/.test(notesL))
      issues.push("syringing missing");
  }
  if (id === "56") {
    expectLab(/aso/, "ASO");
    expectLab(/swab|throat/, "throat swab");
    expectMed(/azithro/, "azithro");
  }
  if (id === "57") {
    expectNote(/red eye|eye/, "red eye");
    expectMed(/moxi/, "moxi drops");
  }
  if (id === "58") {
    noMed(/iop|fundus/, "exam as med");
    noLab(/iop|fundus/, "exam as lab — should be Examination");
  }
  if (id === "59") {
    expectNote(/tinea/, "tinea");
    expectMed(/itra/, "itra");
    expectLab(/koh/, "KOH");
  }
  if (id === "60") {
    expectMed(/betnovate/, "Betnovate brand");
    noMed(/betamethasone/, "rewrote brand to salt");
  }
  if (id === "61") {
    expectNote(/insomnia/, "insomnia complaint");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    if (
      hasNoteSection(notes, "Diagnosis") &&
      /neuropath|depression|anxiety/.test(notesL)
    ) {
      issues.push("invented diagnosis");
    }
  }
  if (id === "62") {
    expectNote(/low mood|mood/, "low mood");
    if (/depression/.test(notesL) && !/low mood/.test(c.instruction)) {
      issues.push("invented depression");
    }
    if (meds.length) issues.push("no meds");
  }
  if (id === "63") {
    expectNote(/chest pain/, "chest pain");
    expectLab(/trop/, "trop I");
    expectLab(/ecg/, "ECG");
    expectMed(/asprin|aspirin/, "aspirin typo");
  }
  if (id === "64") {
    expectNote(/cva|stroke|cerebro/, "CVA");
    expectLab(/ct|brain/, "CT brain");
    expectMed(/ecosprin/, "Ecosprin Gold brand");
  }
  if (id === "65") {
    expectNote(/seizure/, "seizure");
    expectLab(/eeg/, "EEG");
    expectMed(/levipil/, "Levipil brand");
  }
  if (id === "66") {
    expectNote(/ckd|kidney/, "CKD");
    expectLab(/kft|kidney|renal/, "KFT");
    expectMed(/nodosis/, "Nodosis");
    if (!/nsaid/.test(notesL)) issues.push("missing no NSAIDs");
  }
  if (id === "67") {
    expectLab(/kub/, "KUB");
    expectMed(/drotin/, "Drotin");
    if (!/fluid/.test(notesL)) issues.push("missing fluids advice");
  }
  if (id === "68") {
    expectNote(/pain|abd|abdomen/, "pain abd");
    expectLab(/usg|ultrasound/, "USG");
    expectMed(/pantop/, "Pantop");
  }
  if (id === "69") {
    expectNote(/ugib|bleed|gastro/, "UGIB");
    if (!/npo|nil per oral|nil by mouth/.test(notesL))
      issues.push("missing NPO");
    const ppi = (body.medicines || []).find(
      (m) => /ppi/i.test(m.name || "") || /infusion/i.test(m.name || ""),
    );
    if (ppi && /5\s*day/i.test(ppi.duration || ""))
      issues.push(`PPI IV defaulted to 5 days: ${ppi.duration}`);
  }
  if (id === "70") {
    expectNote(/sob|breath|dyspnoea|dyspnea/, "SOB");
    expectLab(/cxr|x-?ray|chest/, "CXR");
    if (
      !medsL.match(/duolin|deriphyllin/) &&
      !procsL.match(/duolin|deriphyllin|nebul/)
    ) {
      issues.push("missing Duolin/Deriphyllin");
    }
  }
  if (id === "71") {
    expectLab(/afb|sputum/, "sputum AFB");
  }
  if (id === "72") {
    expectNote(/anemia|anaemia/, "anemia");
    expectLab(/cbp|blood|complete/, "CBP");
    expectLab(/smear|p\/s|ps/, "P/S");
    expectLab(/iron/, "iron profile");
  }
  if (id === "73") {
    noMed(/fnac/, "FNAC as tablet");
    if (!labsL.match(/fnac/) && !procsL.match(/fnac/))
      issues.push("FNAC dropped");
  }
  if (id === "74") {
    if (meds.length || labs.length || notes.trim()) {
      issues.push("bare 'add' should not invent chart");
    }
  }
  if (id === "75") {
    if (
      meds.length ||
      labs.length ||
      (notes.trim() && !/same|unchanged|nothing/.test(notesL))
    ) {
      if (meds.length || labs.length)
        issues.push("same as last time invented orders");
    }
  }
  if (id === "76a") {
    if (meds.length) issues.push(`stop all left meds: ${meds.join(" | ")}`);
  }
  if (id === "76b") {
    if (medsL.match(/dolo/)) issues.push("Dolo not stopped");
    if (!medsL.match(/pantop/)) issues.push("Pantop should remain");
  }
  if (id === "77") {
    expectMed(/rabeprazole/, "Rabeprazole");
    noMed(/pantop/, "Pantop should be replaced");
  }
  if (id === "78") {
    expectMed(/dolo/, "keep Dolo");
    expectMed(/pantop/, "keep Pantop");
    expectLab(/cbp|blood|complete/, "add CBP");
  }
  if (id === "79") {
    if (
      /malaria/.test(notesL) &&
      !/not|ruled|unlikely|no malaria|negat/.test(notesL)
    ) {
      issues.push("did not negate malaria diagnosis");
    }
  }
  if (id === "80") {
    expectNote(/uti|urinary/, "maybe UTI as provisional");
    if (meds.length || labs.length)
      issues.push("maybe uti should not invent orders");
  }
  if (id === "81") {
    expectNote(/fever|chills/, "complaints");
    expectLab(/malaria|mp/, "MP");
    expectLab(/cbp|blood|complete/, "CBP");
    expectMed(/pcm|paracetamol/, "pcm");
    expectMed(/doxy/, "doxy");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    if (!/cipro/.test(notesL)) issues.push("missing no cipro");
    if (!/review/.test(notesL)) issues.push("missing review advice");
  }
  if (id === "82") {
    expectLab(/cbp|blood|complete/, "CBP");
    noMed(/dressing|soak/, "dressing as inj/med");
    if (!procsL.match(/dress/) && !/dress/.test(notesL))
      issues.push("dressing missing");
  }
  if (id === "83") {
    expectNote(/barking|cough/, "cough");
    if (labsL.match(/x-?ray|cxr/)) {
      issues.push("conditional xray became a lab order");
    }
    noMed(/codeine/, "no codeine");
    if (!/steam/.test(notesL) && !procsL.match(/steam/)) {
      issues.push("missing steam advice");
    }
  }
  if (id === "84") {
    expectLab(/malaria|mp/, "MP");
    expectLab(/cbp|blood|complete/, "CBP");
    expectNote(/uti|urinary/, "UTI dx");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    expectMed(/dolo/, "Dolo");
    noLab(/urine|cue|culture/, "UTI must not invent urine lab");
  }
  if (id === "85") {
    expectNote(/burning|micturition/, "complaint");
    expectLab(/malaria|mp/, "MP");
    expectLab(/cue|urine/, "CUE");
    expectLab(/cbp|blood|complete/, "CBP");
    expectMed(/nitro/, "nitrofurantoin");
    expectMed(/pcm|paracetamol/, "pcm");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    expectMed(/pantop/, "Pantop");
    if (!/nsaid/.test(notesL)) issues.push("missing no NSAID");
    if (!/review|fluid/.test(notesL))
      issues.push("missing review/fluids advice");
  }

  if (id === "86") {
    expectNote(/chest pain/, "chest pain");
    expectNote(/cad|coronary|heart/, "k/c/o CAD history");
    expectLab(/trop/, "trop I");
    expectLab(/ecg/, "ECG");
    expectMed(/asprin|aspirin/, "aspirin");
    expectMed(/telma.*am.*h/, "Telma AM H");
    if (!/ecosprin/.test(notesL) && !medsL.match(/ecosprin/))
      issues.push("missing Ecosprin Gold in history or meds");
    noMed(/nsaid/, "NSAID as med");
    if (labsL.match(/admit/) || medsL.match(/admit/))
      issues.push("admit became an order");
    if (!/admit|nsaid/.test(notesL)) issues.push("missing if trop+/no NSAID advice");
  }
  if (id === "87") {
    expectNote(/seizure|gtcs|epilepsy/, "seizure/epilepsy");
    expectLab(/eeg/, "EEG");
    if (!medsL.match(/levipil/) && !/levipil/.test(notesL))
      issues.push("missing Levipil (continue or history)");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    noMed(/phenytoin/, "no phenytoin");
    if (labsL.match(/\bct\b|ct brain|brain ct/))
      issues.push("conditional CT became a lab order");
  }
  if (id === "88") {
    expectNote(/cough|fever|wheez|copd/, "respiratory");
    expectLab(/afb|sputum/, "sputum AFB");
    expectLab(/cxr|x-?ray|chest/, "CXR");
    expectLab(/aec|eosinophil/, "AEC");
    if (
      !medsL.match(/duolin|deriphyllin/) &&
      !procsL.match(/duolin|deriphyllin|nebul/)
    ) {
      issues.push("missing Duolin/Deriphyllin");
    }
    noMed(/codeine/, "no codeine");
    if (labsL.match(/neck/)) issues.push("conditional neck xray became lab");
  }
  if (id === "89") {
    expectNote(/malena|melaena|bleed|pud|ulcer/, "bleed/PUD");
    if (!/npo|nil per oral|nil by mouth/.test(notesL))
      issues.push("missing NPO");
    expectLab(/cbp|blood|complete/, "CBP");
    expectLab(/lft|liver/, "LFT");
    if (!medsL.match(/pan\s*40|pantop|ppi/) && !/pan 40|pantop|ppi/.test(notesL))
      issues.push("missing Pan 40 / PPI");
    noMed(/nsaid/, "NSAID as med");
    const inf = (body.medicines || []).find((m) =>
      /infusion|\binf\b/i.test(`${m.name || ""} ${m.type || ""}`),
    );
    if (inf && /5\s*day/i.test(String(inf.duration || "")))
      issues.push(`IV/infusion defaulted to 5 days: ${inf.duration}`);
    if (medsL.match(/transfus/) || labsL.match(/transfus/))
      issues.push("conditional transfusion became an order");
  }
  if (id === "90") {
    expectNote(/ckd|kidney|loin/, "CKD/loin");
    expectLab(/kub/, "KUB");
    expectLab(/kft|kidney|renal|creat/, "KFT");
    if (!medsL.match(/nodosis/) && !/nodosis/.test(notesL))
      issues.push("missing Nodosis (history or continue)");
    expectMed(/drotin/, "Drotin");
    noMed(/nsaid|acei|enalapril|ramipril/, "prohibited as med");
    if (!/nsaid/.test(notesL)) issues.push("missing no NSAIDs");
    if (medsL.match(/refer|nephro/) || labsL.match(/refer/))
      issues.push("conditional refer became an order");
  }
  if (id === "91") {
    expectNote(/polyuria/, "polyuria");
    expectNote(/diabetes|dm|t2/, "DM history");
    expectLab(/hba1c|a1c|glycated/, "HbA1c");
    expectLab(/fbs|fasting|glucose|sugar/, "FBS");
    expectMed(/lantus/, "Lantus");
    noMed(/metformin/, "home metformin must not be a new med");
    const ins = (body.medicines || []).find((m) =>
      /lantus|insulin/i.test(m.name || ""),
    );
    const amts = (ins?.dosages || []).map((d) => Number(d.amount));
    if (ins && !(amts.includes(10) && amts.includes(15))) {
      issues.push(
        `Lantus amounts ${amts.join(",") || "missing"} want 10 and 15`,
      );
    }
  }
  if (id === "92") {
    expectNote(/ra|rheumatoid|joint/, "RA");
    expectLab(/ra|rheumatoid/, "RA factor");
    expectLab(/ana|antinuclear/, "ANA");
    expectMed(/mtx|methotrexate/, "MTX");
    expectMed(/folic/, "folic");
    const wys = (body.medicines || []).filter((m) =>
      /wysolone|prednisolone/i.test(m.name || ""),
    );
    if (wys.length < 3)
      issues.push(
        `wysolone taper 3 rows, got ${wys.length}: ${wys
          .map((m) => m.name)
          .join(" | ")}`,
      );
    const mtx = (body.medicines || []).find((m) =>
      /mtx|methotrexate/i.test(m.name || ""),
    );
    if (mtx && (mtx.dosages || []).length >= 2) {
      issues.push("weekly MTX should not get a fake daily grid");
    }
  }
  if (id === "93") {
    expectNote(/tinea/, "tinea");
    expectLab(/koh/, "KOH");
    expectMed(/itra/, "itra");
    expectMed(/betnovate/, "Betnovate");
    noMed(/betamethasone/, "rewrote Betnovate to salt");
    noMed(/prednisolone|wysolone|oral steroid/, "unwanted oral steroid");
    if (labsL.match(/biopsy|punch|bx/))
      issues.push("conditional punch bx became a lab");
  }
  if (id === "94") {
    expectNote(/red eye|eye/, "red eye");
    noMed(/iop|fundus/, "exam as med");
    noLab(/iop|fundus/, "exam as lab");
    expectMed(/refresh|tears/, "Refresh Tears");
    expectMed(/moxi/, "moxi drops");
    noMed(/tablet|tab |azithro|amox/, "systemic abx");
  }
  if (id === "95") {
    noMed(/wax|syring/, "wax as tablet");
    if (!procsL.match(/syring|wax/) && !/syring/.test(notesL))
      issues.push("syringing missing");
    expectLab(/aso/, "ASO");
    expectLab(/swab|throat/, "throat swab");
    expectMed(/azithro/, "azithro");
  }
  if (id === "96") {
    expectMed(/zinc/, "zinc");
    expectMed(/ors/, "ORS");
    expectLab(/stool/, "stool RE");
    noMed(/loperamide|imodium/, "no loperamide");
    if (labsL.match(/c\/s|culture/) && !/stool r/.test(labsL)) {
      // culture only if blood — should be advice
    }
    if (labsL.match(/culture|c\/s/))
      issues.push("conditional stool C/S became a lab");
  }
  if (id === "97") {
    expectNote(/leak|prom|rupture|liquor/, "leaking PV");
    expectMed(/betnesol/, "Betnesol");
    noMed(/nfhs|toco/, "NFHS/tocolysis as med");
    expectLab(/usg|ultrasound|obs|obstetric/, "USG obs");
    if (medsL.match(/admit/) || labsL.match(/admit/))
      issues.push("conditional admit became an order");
  }
  if (id === "98") {
    expectNote(/osteo|oa|knee/, "OA");
    noMed(/physio/, "physio as med");
    if (!procsL.match(/physio/) && !/physio/.test(notesL))
      issues.push("physio missing");
    expectMed(/diclo/, "diclo");
    if (labsL.match(/x-?ray|ap|lat/))
      issues.push("conditional xray became a lab order");
  }
  if (id === "99") {
    expectNote(/insomnia|low mood|mood/, "complaint");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    noMed(/ssri|sertraline|fluoxetine|escital/, "no SSRI");
    if (
      hasNoteSection(notes, "Diagnosis") &&
      /depression|anxiety|neuropath/.test(notesL)
    ) {
      issues.push("invented diagnosis");
    }
  }
  if (id === "100") {
    expectNote(/anemia|anaemia/, "anemia");
    expectLab(/cbp|blood|complete/, "CBP");
    expectLab(/smear|p\/s|ps/, "P/S");
    expectLab(/iron/, "iron profile");
    noMed(/fnac/, "FNAC as tablet");
    noMed(/iron inj|iron sucrose|orofer/, "unwanted iron inj");
    if (labsL.match(/fnac/) || procsL.match(/fnac/)) {
      issues.push("conditional FNAC became an order");
    }
  }
  if (id === "101") {
    expectNote(/fever|myalgia/, "complaints");
    expectLab(/dengue|ns1|denv/, "dengue");
    expectLab(/plat|platelet/, "platelets");
    expectLab(/culture|c\/s|blood/, "blood C/S");
    expectMed(/pcm|paracetamol/, "pcm");
    noMed(/nsaid|ibuprofen|diclo/, "NSAID as med");
    noMed(/artesunate/, "conditional artesunate");
    if (!/nsaid/.test(notesL)) issues.push("missing no NSAIDs");
  }
  if (id === "102") {
    expectNote(/fever|cough/, "complaints");
    expectNote(/diabetes|dm|metformin/, "DM/metformin history");
    noMed(/metformin/, "home metformin must not be a new med");
    expectMed(/pantop/, "Pantop");
    expectMed(/dolo/, "Dolo");
    expectMed(/azithro/, "Azithro");
    expectMed(/lantus/, "Lantus");
    expectMed(/mtx|methotrexate/, "MTX");
    expectMed(/refresh|tears/, "Refresh Tears");
    expectMed(/t-?bact|bactroban|mupirocin/, "T-Bact");
    expectLab(/cbp|blood|complete/, "CBP");
    expectLab(/lft|liver/, "LFT");
    const wys = (body.medicines || []).filter((m) =>
      /wysolone|prednisolone/i.test(m.name || ""),
    );
    if (wys.length < 3)
      issues.push(`wysolone taper 3 rows, got ${wys.length}`);
    const ins = (body.medicines || []).find((m) =>
      /lantus/i.test(m.name || ""),
    );
    const amts = (ins?.dosages || []).map((d) => Number(d.amount));
    if (ins && !(amts.includes(10) && amts.includes(15))) {
      issues.push(`Lantus amounts ${amts.join(",") || "missing"} want 10 and 15`);
    }
    const mtx = (body.medicines || []).find((m) =>
      /mtx|methotrexate/i.test(m.name || ""),
    );
    if (mtx && (mtx.dosages || []).length >= 2) {
      issues.push("weekly MTX should not get a fake daily grid");
    }
  }
  if (id === "103") {
    const before = String(c.chart?.doctorNotes || "");
    if (!notes.trim()) issues.push("elaborate emptied notes");
    if (notes.length <= before.length)
      issues.push("elaborate did not expand notes");
    expectNote(/fever|cough|diabetes|metformin|chest|review/, "kept facts");
    if (meds.length) issues.push("elaborate should not invent meds");
  }
  if (id === "104") {
    if (!/•/.test(notes) && !/^\s*[-*]/m.test(notes))
      issues.push("format-as-bullets produced no bullets");
    expectNote(/fever|cough|diabetes|metformin|chest|review/, "kept facts");
  }
  if (id === "105") {
    expectNote(/htn|hypertension|diabetes|dm/, "history");
    expectLab(/lipid|cholesterol/, "lipid");
    expectLab(/hba1c|a1c/, "HbA1c");
    expectMed(/telma.*am.*h/, "Telma AM H");
    expectMed(/ecosprin/, "Ecosprin Gold");
    noMed(/atorva|rosuva|statin/, "unwanted statin");
  }
  if (id === "106") {
    expectNote(/uti|urinary/, "UTI");
    expectMed(/nitro/, "nitro");
    expectLab(/cue|urine/, "CUE");
    expectLab(/cbp|blood|complete/, "CBP");
    expectMed(/gabapin\s*me/, "Gabapin ME");
    noMed(/cue/, "CUE as medicine");
    noMed(/cipro/, "no cipro");
  }
  if (id === "107") {
    if (labs.length < 3)
      issues.push(`need HBsAg/HCV/HIV, got ${labs.join(" | ")}`);
    expectLab(/lft|liver/, "LFT");
    expectMed(/^pan\s*40$|pan 40/, "Pan 40 brand");
    noMed(/pantoprazole/, "must not rewrite Pan→Pantoprazole");
    if (hasNoteSection(notes, "Diagnosis") && /hepatitis/.test(notesL))
      issues.push("invented hepatitis diagnosis from serology");
  }
  if (id === "108") {
    expectNote(/barking|cough/, "cough");
    expectMed(/pcm|paracetamol/, "pcm");
    noMed(/codeine/, "no codeine");
    noMed(/syp|syrup|ascoril/, "no unnamed syrup");
    if (labsL.match(/x-?ray|cxr/))
      issues.push("conditional xray became a lab order");
    if (!/steam/.test(notesL) && !procsL.match(/steam/))
      issues.push("missing steam advice");
  }
  if (id === "109") {
    expectNote(/menorrhagia/, "menorrhagia");
    expectLab(/usg|ultrasound|pelvis/, "USG");
    expectLab(/tsh/, "TSH");
    expectMed(/primolut/, "Primolut N");
    noMed(/estrogen|estradiol|premarin/, "unwanted estrogen");
    if (medsL.match(/admit/) || labsL.match(/admit/))
      issues.push("conditional admit became an order");
  }
  if (id === "110") {
    expectNote(/sneez|allergy/, "allergy");
    expectLab(/aec|eosinophil/, "AEC");
    noLab(/\bace\b|angiotensin/, "ACE must not be a lab");
    expectMed(/montair/, "Montair LC");
    if (medsL.match(/duolin/) || procsL.match(/duolin/)) {
      issues.push("conditional Duolin neb became an order");
    }
  }
  if (id === "111") {
    expectLab(/cbp|blood|complete/, "CBP");
    expectMed(/pcm|paracetamol/, "pcm");
    noMed(/dressing|soak/, "dressing as inj/med");
    if (!procsL.match(/dress/) && !/dress/.test(notesL))
      issues.push("dressing missing");
    noMed(/nsaid|ibuprofen|diclo/, "NSAID as med");
    if (labsL.match(/swab|c\/s|culture/))
      issues.push("conditional swab C/S became a lab");
  }
  if (id === "112") {
    expectNote(/uti|urinary|stone/, "stone/UTI");
    expectLab(/malaria|mp/, "MP");
    expectLab(/vivax|pv/, "PV vivax");
    expectLab(/falciparum|pf/, "PF");
    expectLab(/cue|urine/, "CUE");
    expectMed(/drotin/, "Drotin");
    noMed(/\bcue\b/, "CUE as medicine");
    noLab(/peripheral venous|venous smear/, "pv remapped to venous");
    noMed(/nitro/, "nitro only if cue+ — should be advice not med");
  }

  return issues;
}

function slimBody(body) {
  return {
    assistantReply: body.assistantReply || "",
    doctorNotes: body.doctorNotes || "",
    medicines: (body.medicines || []).map((m) => ({
      name: m.name,
      type: m.type,
      duration: m.duration,
      directions: m.directions,
      dosages: m.dosages,
    })),
    labTests: labNames(body),
    procedures: procNames(body),
    provider: body.provider,
    model: body.model,
    error: body.error || null,
  };
}

async function mintToken() {
  const Hospital = require("../models/Hospital");
  await mongoose.connect(process.env.MONGO_URI);
  const hospital = await Hospital.findOne({
    $or: [{ subscriptionStatus: "active" }, { active: true }],
  })
    .select("_id")
    .lean();
  if (!hospital) throw new Error("No hospital found in master DB");
  const token = jwt.sign(
    {
      user: {
        id: hospital._id,
        userId: "gauntlet",
        type: "Doctor",
        hospitalId: hospital._id,
      },
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" },
  );
  await mongoose.disconnect();
  return token;
}

async function runOne(token, c) {
  const t0 = Date.now();
  try {
    const res = await axios.post(
      URL,
      {
        instruction: c.instruction,
        currentChart: c.chart,
        clinicalSetting: "opd",
      },
      {
        headers: { "x-auth-token": token, "Content-Type": "application/json" },
        timeout: 90000,
        validateStatus: () => true,
      },
    );
    const ms = Date.now() - t0;
    const body =
      res.data && typeof res.data === "object" ? res.data : { raw: res.data };
    const issues = judge(c, body, res.status);
    return {
      id: c.id,
      instruction: c.instruction,
      status: res.status,
      ms,
      issues,
      pass: res.status === 200 && issues.length === 0,
      body: slimBody(body),
      error:
        body.error ||
        (res.status !== 200 ? JSON.stringify(body).slice(0, 400) : null),
    };
  } catch (err) {
    return {
      id: c.id,
      instruction: c.instruction,
      status: err.response?.status || 0,
      ms: Date.now() - t0,
      issues: [err.message],
      pass: false,
      body: {},
      error: err.message,
    };
  }
}

function formatRow(r) {
  const meds = (r.body.medicines || []).map((m) => m.name).join(", ") || "-";
  const slots =
    (r.body.medicines || [])
      .map(
        (m) =>
          `${m.name}:${(m.dosages || []).map((d) => d.time).join("+") || "-"}`,
      )
      .join("; ") || "-";
  const labs = (r.body.labTests || []).join(", ") || "-";
  const procs = (r.body.procedures || []).join(", ") || "-";
  const notes = String(r.body.doctorNotes || "").replace(/\n/g, " | ") || "-";
  return [
    `${r.id}\t${r.pass ? "PASS" : "FAIL"}\tFU ${r.status}/${r.ms}ms\t${r.instruction}`,
    `  meds: ${meds}`,
    `  slots: ${slots}`,
    `  labs: ${labs}`,
    `  procs: ${procs}`,
    `  notes: ${notes}`,
    `  reply: ${r.body.assistantReply || "-"}`,
    `  FAIL: ${r.issues.join(" || ") || "-"}`,
    `  provider: ${r.body.provider || "-"} ${r.body.model || ""}`.trim(),
    "",
  ].join("\n");
}

function writeOutputs(results) {
  const digest = results.map(formatRow).join("\n");
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  const header = `FOLLOWUP-ONLY ${new Date().toISOString()}  ${pass} PASS / ${fail} FAIL / ${results.length} of ${CASES.length}\n\n`;
  fs.writeFileSync(
    path.join(OUT_DIR, "digest-followup-only.txt"),
    header + digest,
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "results-followup-only.jsonl"),
    results.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const failList = results
    .filter((r) => !r.pass)
    .map((r) => `${r.id}\t${r.issues.join(" | ")}\t${r.instruction}`)
    .join("\n");
  fs.writeFileSync(
    path.join(OUT_DIR, "fails-followup-only.txt"),
    failList + "\n",
  );
  return { header, failList, pass, fail };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = String(process.env.GAUNTLET_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const runList = only.length
    ? CASES.filter((c) => only.includes(c.id))
    : CASES;
  if (!runList.length) throw new Error("No gauntlet cases to run");
  const token = await mintToken();
  const results = [];
  let lastStart = 0;
  process.stderr.write(
    `Rate limit ${REQUESTS_PER_MIN}/min (interval ${MIN_INTERVAL_MS}ms), ${runList.length} cases, followup only\n`,
  );
  for (let idx = 0; idx < runList.length; idx++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStart);
    if (idx > 0 && wait > 0) {
      process.stderr.write(
        `  wait ${wait}ms to stay at ${REQUESTS_PER_MIN}/min\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    lastStart = Date.now();
    const c = runList[idx];
    process.stderr.write(
      `[${idx + 1}/${runList.length}] ${c.id} ${c.instruction.slice(0, 60)}\n`,
    );
    const r = await runOne(token, c);
    results.push(r);
    writeOutputs(results);
    process.stderr.write(
      `  -> ${r.status} ${r.ms}ms ${r.pass ? "PASS" : "FAIL " + r.issues.join("; ")}\n`,
    );
  }

  const { header, failList } = writeOutputs(results);
  console.log(header);
  console.log(`Wrote ${OUT_DIR}/digest-followup-only.txt`);
  console.log(`FAILS:\n${failList}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
