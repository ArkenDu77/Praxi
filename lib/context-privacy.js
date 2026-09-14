/* Deterministic minimisation of known patient identifiers in historical text.
 * This is not a general named-entity recogniser and does not promise complete
 * anonymisation of arbitrary free text. No model, lookup, log or persistence. */
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = pattern => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'giu');
const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function birthDatePatterns(value) {
  const text = String(value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const french = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  const parts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : french ? [Number(french[3]), Number(french[2]), Number(french[1])] : null;
  if (!parts) return text ? [escapeRegExp(text)] : [];
  const [year, month, day] = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return [escapeRegExp(text)];
  const monthName = months[month - 1].replace('é', '[ée]').replace('û', '[ûu]');
  return [escapeRegExp(text), `${year}-0?${month}-0?${day}`, `0?${day}[/.-]0?${month}[/.-]${year}`, String.raw`0?${day}\s+${monthName}\s+${year}`];
}

function protectContextText(value, patient = {}) {
  let text = String(value || '');
  const redactions = { name: 0, birthDate: 0, nationalId: 0, email: 0, telephone: 0, address: 0 };
  const replace = (regex, token, category) => {
    text = text.replace(regex, () => { redactions[category] += 1; return token; });
  };
  const fullName = String(patient.nom || patient.name || '').trim();
  // Full name first, then exact known name components. Unicode boundaries are
  // essential for accented names; never rewrite pieces of clinical words.
  const names = [...new Set([...(fullName ? [fullName] : []), ...fullName.split(/[\s,]+/).filter(name => name.length >= 3)])].sort((a, b) => b.length - a.length);
  for (const name of names) replace(word(escapeRegExp(name)), 'PATIENT_CONFIDENTIEL', 'name');
  for (const pattern of birthDatePatterns(patient.ddn || patient.dateOfBirth)) replace(word(pattern), '[date de naissance retirée]', 'birthDate');
  // NIR: 13-character base, optional two-digit key, including Corsican 2A/2B
  // departments and the spaced presentation used in copied documents.
  replace(word('[12][ .-]?\\d{2}[ .-]?\\d{2}[ .-]?(?:\\d{2}|2[AB])[ .-]?\\d{3}[ .-]?\\d{3}(?:[ .-]?\\d{2})?'), '[identifiant retiré]', 'nationalId');
  replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[courriel retiré]', 'email');
  replace(/(?<!\d)(?:\+\s?33|0033)[ .-]?(?:\(0\)[ .-]?)?[1-9](?:[ .-]?\d{2}){4}(?!\d)/g, '[téléphone retiré]', 'telephone');
  replace(/(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g, '[téléphone retiré]', 'telephone');
  // Stop at sentence punctuation, so a following dose or clinical conclusion
  // remains intact. Free-form addresses outside this pattern remain a limit.
  replace(/\b\d{1,4}\s*(?:bis|ter)?\s+(?:rue|avenue|av\.?|boulevard|bd\.?|allée|allee|place|impasse|chemin|voie|route|passage|cité|cite|résidence|residence|cours)\s+[^,;\n.]{2,80}(?:,\s*\d{5}\s+[^,;\n.]{2,50})?/giu, '[adresse retirée]', 'address');
  return { text, redactions };
}

function protectHistoricalContext(context) {
  if (!context) return context;
  const protectedText = protectContextText(context.texte, context.patient || {});
  return { ...context, texte: protectedText.text,
    privacy: { method: 'known-identifiers-v1', redactions: protectedText.redactions, exhaustive: false } };
}

module.exports = { protectContextText, protectHistoricalContext };
