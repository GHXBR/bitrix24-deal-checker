/**
 * По умолчанию — только важное.
 * Подробности: config.verbose = true или VERBOSE=1
 */

let verbose = null;

function isVerbose() {
  if (verbose === null) {
    try {
      const config = require('../config');
      verbose = !!config.verbose || process.env.VERBOSE === '1';
    } catch {
      verbose = process.env.VERBOSE === '1';
    }
  }
  return verbose;
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function info(message) {
  console.log(message);
}

function log(message, extra) {
  if (!isVerbose()) return;
  if (extra !== undefined) console.log(`[${ts()}] ${message}`, extra);
  else console.log(`[${ts()}] ${message}`);
}

function logStep(step, message) {
  if (!isVerbose()) return;
  console.log(`[${ts()}] → ${step}: ${message}`);
}

function logOk(message) {
  if (!isVerbose()) return;
  console.log(`[${ts()}] ✓ ${message}`);
}

function logWarn(message) {
  if (!isVerbose()) return;
  console.log(`! ${message}`);
}

function logErr(message) {
  console.log(`✗ ${message}`);
}

module.exports = {
  info,
  log,
  logStep,
  logOk,
  logWarn,
  logErr,
  isVerbose,
};
