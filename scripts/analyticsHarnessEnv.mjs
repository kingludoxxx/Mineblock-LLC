// Side-effect-only module: pins DATABASE_URL for the verification harness.
//
// WHY IT IS A SEPARATE FILE. ESM hoists every `import` and evaluates it BEFORE
// any top-level statement in the importing module, so a
// `process.env.DATABASE_URL ||= …` line at the top of the harness runs far too
// late — the ensure*Tables helpers have already built their pool against the
// default localhost:5432 and the run dies ECONNREFUSED before assertion one.
// Module evaluation follows import ORDER, so importing this file first is the
// one placement that actually wins.
//
// `||=` so an explicit DATABASE_URL on the command line still takes precedence.
process.env.DATABASE_URL ||= 'postgresql://puure@127.0.0.1:5433/puure_analytics';

export const HARNESS_DB_URL = process.env.DATABASE_URL;
