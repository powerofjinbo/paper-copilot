/**
 * Consistency, Terminology and Figure-plan reports (batch B): pure functions over the project's units
 * (with their LaTeX text), facts, outline and file texts. Output shapes are zod schemas in api.ts
 * (EchoReport, TerminologyReport, FigurePlanReport); labels in src/i18n.
 *
 * Typical server use:
 *   const order = projectFileOrder(config.mainFile, files);
 *   const units = orderUnits(unitsWithText(allUnits, texts), order);
 *   const echo = echoCheck(units, facts, outline, { title: extractTitle(texts[mainFile]), derived: derivedRelations(facts) });
 *   const terms = terminologyReport(units, terminology);
 *   const plan = figurePlan(files, units, outline, { order, figures, claims });
 */
export { echoCheck, conditionPhrases, type EchoOptions } from './echo';
export { terminologyReport, findAcronymDefinitions, findAcronymUses, isAcronym, KNOWN_ACRONYMS, type TerminologyOptions } from './terms';
export { figurePlan, type FigurePlanFile, type FigurePlanOptions } from './figures';
export {
  unitsWithText,
  projectFileOrder,
  orderUnits,
  extractTitle,
  maskComments,
  matchPhrase,
  type ConsistencyUnit,
  type ProjectFile,
  type ProjectOrderEntry,
  type PhraseMatch,
} from './common';
